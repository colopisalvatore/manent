import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadVault, promoteNote, reviewQueue, WriteRefused, type QueueEntry } from "@manent/core";
import type { NoteStatus } from "@manent/spec";

const run = promisify(execFile);

export interface PromoteCliOptions {
  /** the note to promote; unset prints the review queue */
  note?: string;
  /** queue filter: only what this identity wrote */
  author?: string;
  status?: NoteStatus;
  /** comma-separated audience labels */
  audience?: string;
  /** vault-relative directory to move the note to */
  to?: string;
  dryRun?: boolean;
  /** stage the note and commit it in the vault repository */
  commit?: boolean;
  json?: boolean;
  limit?: number;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function formatQueue(rows: QueueEntry[]): string {
  if (rows.length === 0) return "nothing in quarantine: no agent note is waiting for a person";
  const lines = [
    `${pad("age", 5)} ${pad("name", 28)} ${pad("author", 14)} ${pad("audience", 16)} ${pad("path", 34)} description`,
  ];
  for (const e of rows) {
    lines.push(
      `${pad(`${e.ageDays}d`, 5)} ${pad(clip(e.name, 28), 28)} ${pad(clip(e.author ?? "-", 14), 14)} ` +
        `${pad(clip(e.audience.join(","), 16), 16)} ${pad(clip(e.relPath, 34), 34)} ${clip(e.description, 60)}`,
    );
  }
  lines.push("", "age = days since the note was written · oldest first");
  lines.push("promote one:  manent promote <vault> --note <name> --audience tech,product --to memory --commit");
  return lines.join("\n");
}

export async function runPromoteCommand(root: string, opts: PromoteCliOptions): Promise<number> {
  try {
    if (!opts.note) {
      const rows = await reviewQueue(await loadVault(root), { author: opts.author });
      const shown = opts.limit != null ? rows.slice(0, opts.limit) : rows;
      console.log(opts.json ? JSON.stringify(shown, null, 2) : formatQueue(shown));
      return 0;
    }

    // The repository is checked before the note is touched: a promotion that
    // cannot be committed should not leave the vault half-moved.
    if (opts.commit && !opts.dryRun && !(await isGitRepo(root))) {
      console.error(`--commit needs a git repository at ${root}`);
      return 1;
    }

    const res = await promoteNote(root, {
      name: opts.note,
      status: opts.status,
      audience: opts.audience?.split(",").map((a) => a.trim()).filter(Boolean),
      dir: opts.to,
      dryRun: opts.dryRun,
    });

    if (opts.commit && !opts.dryRun) {
      await run("git", ["-C", root, "add", "--", ...res.paths]);
      await run("git", ["-C", root, "commit", "-m", res.commitMessage]);
    }

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    const head = res.dryRun ? "would promote" : "promoted";
    console.log(`${head} ${res.name}: ${res.from.status ?? "active"} → ${res.to.status}, audience ${res.to.audience.join(", ")}`);
    if (res.moved) console.log(`${res.dryRun ? "would move" : "moved"} ${res.from.relPath} → ${res.to.relPath}`);
    console.log();
    console.log(res.commitMessage.trimEnd());
    if (!opts.commit) {
      console.log();
      console.log(`commit it:  git -C ${root} add -- ${res.paths.join(" ")} && git -C ${root} commit -F -`);
    } else if (!res.dryRun) {
      console.log();
      console.log("committed");
    }
    return 0;
  } catch (err) {
    // A refusal is an answer, not a crash: it says what was wrong with the ask.
    if (err instanceof WriteRefused) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

const isGitRepo = (root: string): Promise<boolean> =>
  run("git", ["-C", root, "rev-parse", "--git-dir"]).then(
    () => true,
    () => false,
  );
