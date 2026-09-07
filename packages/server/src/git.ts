import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Every memory write is a commit: who, when, why.
 *
 * The README promises it and, until now, only a person running
 * `manent promote --commit` on their own machine delivered it. A brain that
 * lives on a server and is written through MCP has no such person: what an
 * agent writes is a file nobody committed, and a file nobody committed is one
 * that the next checkout, sync or disk failure removes without a trace.
 *
 * With `--git` the server commits each write as it lands, authored by the
 * identity that made it — the committer is whoever runs the server, so
 * `git log --author=tech` answers "what did tech write this week" and the
 * repository's own configuration says who published it. With `--git-push`
 * each commit is followed by a push, fast-forward only: a remote that has
 * moved on is reported, never overwritten.
 *
 * Commits are serialized through one queue — git holds a single index lock —
 * and pushes are coalesced, so a burst of writes costs one round trip.
 */
export interface GitOptions {
  /** push after every commit; fast-forward only, never with force */
  push?: boolean;
  /** the remote to push to (default `origin`) */
  remote?: string;
}

export type CommitOutcome = { sha: string } | { skipped: "nothing changed" };

export interface PushOutcome {
  pushed: boolean;
  /** the remote has commits this vault does not: resolve by hand */
  diverged?: boolean;
  error?: string;
}

export class VaultGit {
  private queue: Promise<unknown> = Promise.resolve();
  private pushTimer?: NodeJS.Timeout;
  private pushPending?: Promise<PushOutcome>;
  /** how long to wait after a commit before pushing, so a burst of writes pushes once */
  pushDelayMs = 1500;
  lastPush?: PushOutcome;

  private constructor(
    readonly root: string,
    readonly branch: string,
    readonly remote: string | undefined,
  ) {}

  /**
   * Opens the repository the vault sits in, and refuses now — before serving
   * starts — when it cannot commit: not a repository, a detached HEAD, no
   * committer identity, a remote asked for that is not there. An operator who
   * asked for `--git` should learn at startup, not on the first write.
   */
  static async open(root: string, opts: GitOptions = {}): Promise<VaultGit> {
    try {
      await git(root, ["rev-parse", "--git-dir"]);
    } catch {
      throw new Error(`--git needs a git repository at ${root}`);
    }
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch === "HEAD") throw new Error(`--git needs a branch checked out at ${root} (HEAD is detached)`);
    for (const key of ["user.name", "user.email"]) {
      const value = await git(root, ["config", key]).catch(() => "");
      if (value.trim() === "") {
        throw new Error(`--git needs git ${key} configured for ${root}: the committer is whoever runs this server`);
      }
    }
    const remote = opts.push ? (opts.remote ?? "origin") : undefined;
    if (remote) {
      try {
        await git(root, ["remote", "get-url", remote]);
      } catch {
        throw new Error(`--git-push: remote "${remote}" is not configured at ${root}`);
      }
    }
    return new VaultGit(root, branch, remote);
  }

  /**
   * Stages the given vault-relative paths and commits them, authored by
   * `author` (an identity name, never a person's address). A write that left
   * the file byte-identical — an overwrite with the same content, the same
   * day — has nothing to commit and says so instead of failing.
   */
  commit(paths: string[], author: string, subject: string, body?: string): Promise<CommitOutcome> {
    const job = async (): Promise<CommitOutcome> => {
      await git(this.root, ["add", "--", ...paths]);
      const staged = await git(this.root, ["diff", "--cached", "--quiet", "--", ...paths]).then(
        () => false,
        (err: ExecError) => {
          if (err.code === 1) return true;
          throw err;
        },
      );
      if (!staged) return { skipped: "nothing changed" };
      const message = body ? `${subject}\n\n${body}` : subject;
      await git(this.root, ["commit", "-q", "--author", `${author} <${author}@manent>`, "-m", message]);
      const sha = (await git(this.root, ["rev-parse", "--short", "HEAD"])).trim();
      if (this.remote) this.schedulePush();
      return { sha };
    };
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Pushes now, fast-forward only. Public for scripts; the server pushes on its own after each commit. */
  push(): Promise<PushOutcome> {
    const job = async (): Promise<PushOutcome> => {
      if (!this.remote) return { pushed: false, error: "no remote configured" };
      const remote = this.remote;
      const ref = `refs/heads/${this.branch}`;
      try {
        const exists = await git(this.root, ["ls-remote", "--exit-code", "--heads", remote, this.branch]).then(
          () => true,
          (err: ExecError) => {
            if (err.code === 2) return false;
            throw err;
          },
        );
        if (exists) {
          await git(this.root, ["fetch", "-q", remote, this.branch]);
          const ancestor = await git(this.root, ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"]).then(
            () => true,
            (err: ExecError) => {
              if (err.code === 1) return false;
              throw err;
            },
          );
          if (!ancestor) {
            console.error(
              `[manent] git: ${remote}/${this.branch} has commits this vault does not — not pushing, and never with force. Pull and resolve by hand.`,
            );
            return (this.lastPush = { pushed: false, diverged: true });
          }
        }
        await git(this.root, ["push", "-q", remote, `HEAD:${ref}`]);
        return (this.lastPush = { pushed: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[manent] git push failed: ${message}`);
        return (this.lastPush = { pushed: false, error: message });
      }
    };
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Waits for every queued commit and any pending push: called on close, and by tests. */
  async flush(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
      this.pushPending = this.push();
    }
    await this.queue;
    await this.pushPending;
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    // unref: a pending push must not keep a process alive that is shutting
    // down; `close()` flushes it explicitly instead.
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.pushPending = this.push();
    }, this.pushDelayMs);
    this.pushTimer.unref();
  }
}

interface ExecError extends Error {
  code?: number | string;
  stderr?: string;
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as ExecError;
    // Keep the exit code for the callers that branch on it; the message says what git said.
    const detail = (e.stderr ?? "").trim();
    const wrapped: ExecError = new Error(`git ${args[0]}: ${detail || e.message}`);
    wrapped.code = e.code;
    throw wrapped;
  }
}
