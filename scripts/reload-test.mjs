// Hot reload: a note written to the vault while the server runs is findable
// without a restart; an edit changes what is served; a deletion removes it.
// Exercised over HTTP against a spawned server, the way a shared vault runs.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "manent-reload-"));
const vault = join(root, "vault");
await mkdir(join(vault, "memory"), { recursive: true });
const note = (name, description, body) =>
  writeFile(join(vault, "memory", `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntype: reference\n---\n${body}\n`, "utf8");
await note("seed", "nota iniziale sul deploy", "il deploy usa systemd");

const TOKEN = "reload-test-token-0123456789";
const PORT = 3981;
const child = spawn("node", ["packages/cli/dist/index.js", "serve", vault, "--http", String(PORT), "--token", TOKEN], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stdout.on("data", () => {});
child.stderr.on("data", (d) => (stderr += d.toString()));
await new Promise((r) => setTimeout(r, 2500));

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const search = async (query) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: META, name: "brain_search", arguments: { query, k: 5 } } }),
  });
  return JSON.parse((await r.json()).result.content[0].text).hits.map((h) => h.name);
};
/** Polls until the condition holds or the budget runs out; returns the elapsed ms. */
const until = async (cond, budgetMs = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (await cond()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 150));
  }
  return -1;
};

try {
  ok("baseline: the seed note is served", (await search("deploy systemd")).includes("seed"));
  ok("baseline: nothing about cron yet", !(await search("cron cpanel wrapper")).includes("cron-wrapper"));

  await note("cron-wrapper", "cpanel cron drops nested quoting; use a wrapper", "wrapper script per il cron di cpanel");
  const added = await until(async () => (await search("cron cpanel wrapper")).includes("cron-wrapper"));
  ok("a new file is served without a restart", added >= 0, `${added} ms`);

  await note("cron-wrapper", "backup notturno con rsync", "rsync ogni notte alle 3");
  const edited = await until(async () => (await search("backup notturno rsync")).includes("cron-wrapper"));
  ok("an edit changes what is served", edited >= 0, `${edited} ms`);
  // "wrapper" is in the slug and would still match: ask for words only the old body had.
  ok("the old wording is gone", !(await search("cpanel nested quoting")).includes("cron-wrapper"));

  await unlink(join(vault, "memory", "cron-wrapper.md"));
  const removed = await until(async () => !(await search("backup notturno rsync")).includes("cron-wrapper"));
  ok("a deleted file is no longer served", removed >= 0, `${removed} ms`);

  await note("burst-1", "prima nota della raffica", "a");
  await note("burst-2", "seconda nota della raffica", "b");
  await note("burst-3", "terza nota della raffica", "c");
  const burst = await until(async () => (await search("nota della raffica")).filter((n) => n.startsWith("burst-")).length === 3);
  ok("a burst of writes is served after one coalesced reload", burst >= 0, `${burst} ms`);
  await new Promise((r) => setTimeout(r, 800));
  const reloads = (stderr.match(/\[manent\] reloaded/g) ?? []).length;
  ok("reloads are coalesced, not one per file", reloads >= 3 && reloads <= 5, `${reloads} reloads for 6 file events`);
} finally {
  child.kill();
}

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall reload tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
