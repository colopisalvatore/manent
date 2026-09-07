// Every memory write is a commit. The invariant under test: with --git, a
// write leaves nothing untracked, the commit is authored by the identity that
// wrote it, a push is fast-forward only, and a remote that moved on is
// reported and left alone.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadBrainContext } from "../packages/server/dist/context.js";
import { VaultGit } from "../packages/server/dist/git.js";
import { findTool } from "../packages/server/dist/tools.js";

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "manent-git-"));
const vault = join(root, "vault");
const remote = join(root, "remote.git");
const other = join(root, "other");

// A vault that is a repository, with a committer, and an empty bare remote.
await exec("git", ["init", "-q", "-b", "main", vault]);
await git(vault, "config", "user.name", "manent (test)");
await git(vault, "config", "user.email", "manent@test");
await writeFile(join(vault, "seed.md"), "---\nname: seed\ndescription: nota di partenza\ntype: reference\n---\ncorpo\n", "utf8");
await git(vault, "add", "-A");
await git(vault, "commit", "-q", "-m", "seed");
await exec("git", ["init", "-q", "--bare", "-b", "main", remote]);
await git(vault, "remote", "add", "origin", remote);

async function callAsync(ctx, tool, args) {
  const res = await findTool(tool).run(args, ctx);
  return { raw: res, json: res.isError ? undefined : JSON.parse(res.content[0].text) };
}

console.log("── open() refuses what it cannot commit into ──");
await VaultGit.open(join(root), {}).then(
  () => ok("a directory that is not a repository is refused", false),
  (err) => ok("a directory that is not a repository is refused", /needs a git repository/.test(err.message), err.message),
);
await VaultGit.open(vault, { push: true, remote: "nowhere" }).then(
  () => ok("a remote that is not configured is refused", false),
  (err) => ok("a remote that is not configured is refused", /remote "nowhere"/.test(err.message), err.message),
);

console.log("\n── every write is a commit ──");
const ctx = await loadBrainContext(vault, { writable: true, git: { push: true } });
ctx.git.pushDelayMs = 50;
const head0 = await git(vault, "rev-parse", "HEAD");

const w1 = await callAsync(ctx, "brain_write", { name: "cache-warmup", dir: "memory", description: "come si scalda la cache", type: "reference", body: "si scalda cosi" });
ok("the write reports its commit", typeof w1.json?.git?.sha === "string", JSON.stringify(w1.json?.git));
ok("HEAD moved", (await git(vault, "rev-parse", "HEAD")) !== head0);
const [an, ae, subject] = (await git(vault, "log", "-1", "--format=%an|%ae|%s")).split("|");
ok("authored by the identity, not by a person", an === "owner" && ae === "owner@manent", `${an} <${ae}>`);
ok("subject names the mode, the note and the identity", subject === "create(cache-warmup): by owner", subject);
ok("committed by the repository's configured user", (await git(vault, "log", "-1", "--format=%cn")) === "manent (test)");
ok("nothing left untracked", (await git(vault, "status", "--porcelain")) === "");

const tech = ctx.forIdentity({ name: "tech", owner: false, read: ["tech"], writeDir: "quarantine/tech" });
const w2 = await callAsync(tech, "brain_write", { name: "proposta", description: "una proposta", type: "reference", body: "da rivedere" });
ok("an agent's quarantine write is committed too", typeof w2.json?.git?.sha === "string", JSON.stringify(w2.json));
const [an2, subject2, body2] = (await git(vault, "log", "-1", "--format=%an|%s|%b")).split("|");
ok("authored by the agent", an2 === "tech", an2);
ok("the message says it waits for promotion", /quarantine/.test(body2) && /promote/.test(body2), body2.slice(0, 80));
ok("the file it names is the one committed", (await git(vault, "show", "--name-only", "--format=", "HEAD")) === "quarantine/tech/proposta.md");

const w3 = await callAsync(ctx, "brain_append", { name: "cache-warmup", body: "e anche cosi" });
ok("an append is its own commit", w3.json?.git?.sha && (await git(vault, "log", "-1", "--format=%s")) === "append(cache-warmup): by owner");

const headBefore = await git(vault, "rev-parse", "HEAD");
const w4 = await callAsync(ctx, "brain_write", { name: "cache-warmup", dir: "memory", mode: "overwrite", description: "come si scalda la cache", type: "reference", body: "si scalda cosi\n\ne anche cosi" });
ok("an overwrite that changes nothing commits nothing", w4.json?.git?.skipped === "nothing changed" && (await git(vault, "rev-parse", "HEAD")) === headBefore, JSON.stringify(w4.json?.git));

console.log("\n── push: fast-forward only ──");
await ctx.git.flush();
ok("the remote received every commit", (await git(remote, "rev-parse", "main")) === (await git(vault, "rev-parse", "HEAD")));
ok("the last push is recorded as pushed", ctx.git.lastPush?.pushed === true, JSON.stringify(ctx.git.lastPush));

// Someone else commits to the remote: the vault is now behind.
await exec("git", ["clone", "-q", remote, other]);
await git(other, "config", "user.name", "someone");
await git(other, "config", "user.email", "someone@test");
await writeFile(join(other, "elsewhere.md"), "---\nname: elsewhere\ndescription: scritta altrove\ntype: reference\n---\naltrove\n", "utf8");
await git(other, "add", "-A");
await git(other, "commit", "-q", "-m", "written elsewhere");
await git(other, "push", "-q", "origin", "main");
const theirs = await git(remote, "rev-parse", "main");

const w5 = await callAsync(ctx, "brain_write", { name: "dopo", dir: "memory", description: "scritta dopo la divergenza", type: "reference", body: "dopo" });
ok("the write still commits locally", typeof w5.json?.git?.sha === "string");
await ctx.git.flush();
ok("a remote that moved on is not overwritten", (await git(remote, "rev-parse", "main")) === theirs);
ok("the push reports the divergence, no force", ctx.git.lastPush?.pushed === false && ctx.git.lastPush?.diverged === true, JSON.stringify(ctx.git.lastPush));

// Resolved by hand — a rebase — and the next push goes through.
await git(vault, "pull", "-q", "--rebase", "origin", "main");
const out = await ctx.git.push();
ok("after a rebase the push is fast-forward again", out.pushed === true && (await git(remote, "rev-parse", "main")) === (await git(vault, "rev-parse", "HEAD")), JSON.stringify(out));

console.log("\n── without --git nothing changes ──");
const plain = await loadBrainContext(vault, { writable: true });
const w6 = await callAsync(plain, "brain_write", { name: "untracked", dir: "memory", description: "senza git", type: "reference", body: "x" });
ok("a plain server does not commit", w6.json && w6.json.git === undefined && /untracked\.md/.test(await git(vault, "status", "--porcelain")));

await ctx.close();
await plain.close();
await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall git tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
