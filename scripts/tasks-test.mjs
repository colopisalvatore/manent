// The tasks extension (io.modelcontextprotocol/tasks) on the modern path.
// The invariants under test: a long call comes back as a handle only when the
// client says it can hold one, a task belongs to the identity that started it
// and to nobody else, cancellation never invents a result, and the answer that
// arrives is the same one the inline call would have given.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../packages/server/dist/tasks.js";

const cli = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const settle = () => new Promise((r) => setImmediate(r));

console.log("── the store ──");
{
  const store = new TaskStore();
  let release;
  const held = new Promise((r) => (release = r));
  const created = store.create("owner", async () => {
    await held;
    return { content: [{ type: "text", text: "done" }] };
  });
  ok("a task starts working, with a handle and a poll hint", created.status === "working" && !!created.taskId && created.pollIntervalMs > 0);
  ok("its owner can read it", store.get("owner", created.taskId)?.status === "working");
  ok("another identity is told it does not exist", store.get("tech", created.taskId) === undefined);
  ok("nor can another identity cancel it", store.cancel("tech", created.taskId) === undefined);
  ok("update on a working task says what is actually true", store.update("owner", created.taskId).reason === "not-waiting");
  ok("update on an unknown task is a not-found", store.update("owner", "nope").reason === "not-found");

  release();
  await settle();
  const done = store.get("owner", created.taskId);
  ok("the result arrives on the task", done.status === "completed" && done.result.content[0].text === "done", JSON.stringify(done.result));
  ok("the timestamps moved", done.lastUpdatedAt >= done.createdAt);
}

{
  const store = new TaskStore();
  let release;
  const held = new Promise((r) => (release = r));
  const task = store.create("owner", async () => {
    await held;
    return { content: [{ type: "text", text: "too late" }] };
  });
  const cancelled = store.cancel("owner", task.taskId);
  ok("cancel ends a working task", cancelled.status === "cancelled");
  release();
  await settle();
  ok("work finishing afterwards does not resurrect it", store.get("owner", task.taskId).status === "cancelled");

  const failing = store.create("owner", async () => {
    throw new Error("the vault was unreadable");
  });
  await settle();
  const failed = store.get("owner", failing.taskId);
  ok("a thrown error becomes a failed task, with the reason", failed.status === "failed" && failed.error.message.includes("unreadable"), JSON.stringify(failed.error));

  const done = store.create("owner", async () => ({ content: [{ type: "text", text: "x" }] }));
  await settle();
  ok("cancelling a finished task leaves it finished", store.cancel("owner", done.taskId).status === "completed");
}

{
  // A handle is not a log: the record goes when its time is up.
  let clock = 1_000;
  const store = new TaskStore({ ttlMs: 500, now: () => clock });
  const task = store.create("owner", async () => ({ content: [{ type: "text", text: "x" }] }));
  await settle();
  ok("the record lives while its ttl runs", store.get("owner", task.taskId)?.status === "completed");
  ok("the ttl is on the wire", task.ttlMs === 500);
  clock += 501;
  ok("and is gone after it", store.get("owner", task.taskId) === undefined && store.size() === 0);
}

console.log("\n── over HTTP, modern era ──");
const root = await mkdtemp(join(tmpdir(), "manent-tasks-"));
const vault = join(root, "vault");
await mkdir(join(vault, "memory"), { recursive: true });
const note = (name, fm, body) => writeFile(join(vault, "memory", `${name}.md`), `---\nname: ${name}\n${fm}\n---\n\n${body}\n`, "utf8");
const SHARED = `Il backup gira alle tre di notte, incrementale sul giorno prima, con un dump completo la
domenica. Lo snapshot copre il database e la cartella degli allegati, non copre la cache dei vettori
ne i file temporanei, che si ricostruiscono da soli.`;
await note("backup-uno", "description: come gira il backup notturno\ntype: reference\naudience: [tech]", SHARED);
await note("backup-due", "description: il backup notturno, copia cresciuta\ntype: reference\naudience: [tech]", `${SHARED}\n\nDa gennaio anche fuori sede.`);
await note("prezzo-nuovo", "description: il listino dal 2026\ntype: reference\naudience: [tech]\ncontradicts: [prezzo-vecchio]", "Quaranta euro.");
await note("prezzo-vecchio", "description: il listino fino al 2025\ntype: reference\naudience: [tech]\ncontradicts: [prezzo-nuovo]", "Trenta euro.");
await note("solo-product", "description: nota che solo product puo vedere\ntype: reference\naudience: [product]", "Riservata al prodotto.");

const MASTER = "master-token-0123456789abcdef";
const agents = {
  tech: { token: "tech-token-0123456789abcdef", read: ["tech"] },
  product: { token: "product-token-0123456789abcdef", read: ["product"] },
};
await writeFile(join(root, "agents.json"), JSON.stringify(agents), "utf8");
const PORT = 3973;
const child = spawn("node", [cli, "serve", vault, "--http", String(PORT), "--token", MASTER, "--agents", join(root, "agents.json")], {
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
await new Promise((r) => setTimeout(r, 2500));

const base = `http://127.0.0.1:${PORT}`;
const post = (token, body) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const VERSION = "io.modelcontextprotocol/protocolVersion";
const CAPS = "io.modelcontextprotocol/clientCapabilities";
const plain = { [VERSION]: "2026-07-28" };
const withTasks = { [VERSION]: "2026-07-28", [CAPS]: { extensions: { "io.modelcontextprotocol/tasks": {} } } };

try {
  const discover = await post(MASTER, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: plain } });
  ok("the server declares the extension", !!discover.result?.capabilities?.extensions?.["io.modelcontextprotocol/tasks"], JSON.stringify(discover.result?.capabilities));

  const inline = await post(MASTER, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { _meta: plain, name: "brain_curate", arguments: {} },
  });
  ok("a client that says nothing gets the answer inline", inline.result?.resultType === "complete", JSON.stringify(inline.result).slice(0, 120));
  const inlineReport = JSON.parse(inline.result.content[0].text);
  ok("the inline report has all three sections", !!inlineReport.duplicates && !!inlineReport.contradictions && !!inlineReport.communities);

  const created = await post(MASTER, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { _meta: withTasks, name: "brain_curate", arguments: {} },
  });
  ok("a client that speaks tasks gets a handle", created.result?.resultType === "task" && created.result.status === "working", JSON.stringify(created.result).slice(0, 160));
  const taskId = created.result.taskId;

  let polled;
  for (let i = 0; i < 40; i++) {
    polled = await post(MASTER, { jsonrpc: "2.0", id: 4, method: "tasks/get", params: { _meta: plain, taskId } });
    if (polled.result?.status !== "working") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok("polling ends in a completed task", polled.result?.status === "completed", JSON.stringify(polled.result).slice(0, 160));
  const taskReport = JSON.parse(polled.result.result.content[0].text);
  ok("the task's answer is the inline answer", JSON.stringify(taskReport) === JSON.stringify(inlineReport));
  ok("the vault's real pairs are in it", taskReport.duplicates.some((p) => [p.a, p.b].sort().join() === "backup-due,backup-uno"), JSON.stringify(taskReport.duplicates));
  ok("so is the declared contradiction", taskReport.contradictions.some((c) => c.kind === "declared"));

  const stolen = await post(agents.tech.token, { jsonrpc: "2.0", id: 5, method: "tasks/get", params: { _meta: plain, taskId } });
  ok("another identity cannot read the task", !!stolen.error && stolen.error.message.includes("Task not found"), JSON.stringify(stolen).slice(0, 140));
  const stolenCancel = await post(agents.tech.token, { jsonrpc: "2.0", id: 6, method: "tasks/cancel", params: { _meta: plain, taskId } });
  ok("nor cancel it", !!stolenCancel.error);

  // An agent's task runs on the agent's view: what it may not read is not curated.
  const agentTask = await post(agents.tech.token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { _meta: withTasks, name: "brain_curate", arguments: { reports: ["duplicates"] } },
  });
  let agentPolled;
  for (let i = 0; i < 40; i++) {
    agentPolled = await post(agents.tech.token, { jsonrpc: "2.0", id: 8, method: "tasks/get", params: { _meta: plain, taskId: agentTask.result.taskId } });
    if (agentPolled.result?.status !== "working") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const agentReport = JSON.parse(agentPolled.result.result.content[0].text);
  ok("an agent curates only what it may read", agentReport.notes === 4, String(agentReport.notes));
  ok("and only the reports it asked for", !agentReport.communities && !agentReport.contradictions);

  const unknown = await post(MASTER, { jsonrpc: "2.0", id: 9, method: "tasks/get", params: { _meta: plain, taskId: "does-not-exist" } });
  ok("an unknown task id is an error, not an empty task", !!unknown.error);
  const update = await post(MASTER, { jsonrpc: "2.0", id: 10, method: "tasks/update", params: { _meta: plain, taskId, inputResponses: {} } });
  ok("tasks/update says why it cannot apply here", !!update.error && update.error.message.includes("not waiting for input"), JSON.stringify(update.error).slice(0, 160));
} finally {
  child.kill();
}

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall tasks tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
