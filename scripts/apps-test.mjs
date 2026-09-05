// MCP Apps (io.modelcontextprotocol/ui): the two views, and the promises made
// about them. The invariants under test: the pages are self-contained (nothing
// is fetched from anywhere, so there is no origin to trust), each is bound to
// the tool whose answer it lays out, and neither can do anything the tool
// itself would not — the register stays the owner's, and no page writes.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

// The register lives in node:sqlite (Node 22.5+); without it the server runs
// without one, and the gap tool's refusal is the thing worth checking.
let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

const root = await mkdtemp(join(tmpdir(), "manent-apps-"));
const vault = join(root, "vault");
await mkdir(join(vault, "memory"), { recursive: true });
await mkdir(join(vault, "quarantine", "tech"), { recursive: true });
const note = (rel, fm, body) => writeFile(join(vault, rel), `---\n${fm}\n---\n\n${body}\n`, "utf8");
await note(
  "memory/runbook.md",
  "name: runbook\ndescription: come si riavvia il servizio\ntype: reference\naudience: [tech]\ncreated: 2026-07-01",
  "systemctl restart manent-brain",
);
await note(
  "quarantine/tech/backup-window.md",
  "name: backup-window\ndescription: proposta di spostare la finestra di backup\ntype: reference\nstatus: quarantine\nauthor: tech\naudience: [private]\ncreated: 2026-08-20",
  "Spostare il backup alle 04:30.",
);

const MASTER = "master-token-0123456789abcdef";
const agents = { tech: { token: "tech-token-0123456789abcdef", read: ["tech"] } };
await writeFile(join(root, "agents.json"), JSON.stringify(agents), "utf8");
const PORT = 3975;
const args = [cli, "serve", vault, "--http", String(PORT), "--token", MASTER, "--agents", join(root, "agents.json")];
if (hasSqlite) args.push("--gaps", join(root, "gaps.sqlite"));
const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
await new Promise((r) => setTimeout(r, 2500));

const base = `http://127.0.0.1:${PORT}`;
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const post = (token, body) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const call = (token, name, args2 = {}) =>
  post(token, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { _meta: META, name, arguments: args2 } });

try {
  console.log("── declaration and linkage ──");
  const discover = await post(MASTER, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } });
  const ui = discover.result?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
  ok("the server declares the ui extension with its mime type", ui?.mimeTypes?.includes("text/html;profile=mcp-app"), JSON.stringify(ui));
  ok("and resources alongside tools", !!discover.result?.capabilities?.resources);

  const resources = (await post(MASTER, { jsonrpc: "2.0", id: 2, method: "resources/list", params: { _meta: META } })).result?.resources ?? [];
  ok("every app is listed", resources.length === 3 && resources.every((r) => r.uri.startsWith("ui://")), JSON.stringify(resources.map((r) => r.uri)));
  ok("with the mime type the extension defines", resources.every((r) => r.mimeType === "text/html;profile=mcp-app"));
  ok("and no page in the listing", resources.every((r) => r.text === undefined && r.html === undefined));

  const tools = (await post(MASTER, { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: META } })).result?.tools ?? [];
  const linked = tools.filter((t) => t._meta?.ui?.resourceUri);
  ok(
    "exactly the tools with a page carry a ui resource",
    linked.map((t) => t.name).sort().join(",") === "brain_gaps,brain_graph,brain_quarantine",
    JSON.stringify(linked.map((t) => t.name)),
  );
  ok(
    "every link points at a resource that exists",
    linked.every((t) => resources.some((r) => r.uri === t._meta.ui.resourceUri)),
    JSON.stringify(linked.map((t) => t._meta.ui.resourceUri)),
  );
  ok("plain tools carry no ui metadata", tools.find((t) => t.name === "brain_search")?._meta === undefined);

  console.log("\n── the pages ──");
  for (const uri of resources.map((r) => r.uri)) {
    const read = (await post(MASTER, { jsonrpc: "2.0", id: 4, method: "resources/read", params: { _meta: META, uri } })).result;
    const page = read?.contents?.[0];
    ok(`${uri} reads back as one html page`, page?.mimeType === "text/html;profile=mcp-app" && page.text.startsWith("<!DOCTYPE html>"));
    ok(`${uri} speaks the app handshake`, page.text.includes("ui/initialize") && page.text.includes("ui/notifications/initialized"));
    ok(`${uri} asks the host for its data, not the network`, page.text.includes('"tools/call"') && !/fetch\s*\(/.test(page.text));
    ok(`${uri} loads nothing from anywhere`, !/<script[^>]+src=/i.test(page.text) && !/<link/i.test(page.text) && !/https?:\/\//.test(page.text));
    ok(`${uri} declares an empty csp, because it needs none`, Array.isArray(page._meta?.ui?.csp?.connectDomains) && page._meta.ui.csp.connectDomains.length === 0);
    ok(`${uri} escapes what it renders`, page.text.includes("&amp;") && page.text.includes("&lt;"));
    // A page is shipped, not built: a syntax error in it would only be found by
    // the person it broke in front of. Compiled here, never run.
    const script = page.text.slice(page.text.lastIndexOf("<script>") + 8, page.text.lastIndexOf("</script>"));
    let syntax = "";
    try {
      new Function(script);
    } catch (err) {
      syntax = err.message;
    }
    ok(`${uri} is valid javascript`, syntax === "", syntax);
  }
  // The graph page's only real logic is where it puts the dots. Run it here on
  // a ring: a NaN would draw an empty picture that every protocol assertion
  // above would still call a pass.
  {
    const page = (await post(MASTER, { jsonrpc: "2.0", id: 6, method: "resources/read", params: { _meta: META, uri: "ui://manent/graph" } })).result.contents[0].text;
    const src = page.slice(page.indexOf("function layout"), page.indexOf("function render"));
    const layout = new Function("current", `${src}; return layout;`)(null);
    // Three clusters loosely joined: the shape a vault actually has.
    const nodes = [];
    const edges = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 20; i++) {
        const name = `c${c}-${i}`;
        nodes.push({ name, degree: 3 });
        if (i > 0) edges.push({ from: name, to: `c${c}-${i - 1}` });
        if (i % 5 === 0) edges.push({ from: name, to: `c${c}-0` });
      }
      if (c > 0) edges.push({ from: `c${c}-0`, to: `c${c - 1}-0` });
    }
    const pos = layout(nodes, edges, 800, 520);
    const index = new Map(nodes.map((n, i) => [n.name, i]));
    const dist = (a, b) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
    ok("every node lands somewhere real", pos.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), JSON.stringify(pos.slice(0, 2)));
    ok("and inside the canvas", pos.every((p) => p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 520));
    ok("no two nodes sit on top of each other", new Set(pos.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size === pos.length);
    const again = layout(nodes, edges, 800, 520);
    ok("the same neighbourhood draws the same way twice", JSON.stringify(again) === JSON.stringify(pos));

    const clamped = pos.filter((p) => p.x <= 25 || p.x >= 775 || p.y <= 25 || p.y >= 495).length;
    ok("the drawing is not a rim of dots on the border", clamped < nodes.length / 4, `${clamped}/${nodes.length} clamped`);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const linked = mean(edges.map((e) => dist(index.get(e.from), index.get(e.to))));
    const anyPair = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) anyPair.push(dist(i, j));
    ok("linked notes end up near each other", linked < mean(anyPair) / 2, `linked ${linked.toFixed(0)} vs any pair ${mean(anyPair).toFixed(0)}`);
  }

  const missing = await post(MASTER, { jsonrpc: "2.0", id: 5, method: "resources/read", params: { _meta: META, uri: "ui://manent/nope" } });
  ok("an unknown resource is an error", !!missing.error && missing.error.message.includes("Unknown resource"));

  console.log("\n── what the pages are shown ──");
  const queue = JSON.parse((await call(MASTER, "brain_quarantine")).result.content[0].text);
  ok("the queue holds the quarantined note", queue.waiting === 1 && queue.queue[0].name === "backup-window", JSON.stringify(queue).slice(0, 160));
  ok("with what a person decides on", queue.queue[0].author === "tech" && typeof queue.queue[0].ageDays === "number" && queue.queue[0].audience.includes("private"));
  const agentQueue = JSON.parse((await call(agents.tech.token, "brain_quarantine")).result.content[0].text);
  ok("an agent's queue is empty: quarantined notes are private", agentQueue.waiting === 0, JSON.stringify(agentQueue));

  const whole = JSON.parse((await call(MASTER, "brain_graph")).result.content[0].text);
  ok("without a centre the graph is the most linked notes", whole.center === null && whole.nodes.length === 2 && whole.total === 2, JSON.stringify(whole).slice(0, 160));
  ok("nodes carry what the drawing needs", whole.nodes.every((n) => typeof n.degree === "number" && "type" in n));
  const around = JSON.parse((await call(MASTER, "brain_graph", { center: "runbook", depth: 1 })).result.content[0].text);
  ok("a centre gives its neighbourhood", around.center === "runbook" && around.nodes[0].name === "runbook", JSON.stringify(around).slice(0, 160));
  const missingCenter = await call(MASTER, "brain_graph", { center: "mai-scritta" });
  ok("an unknown centre is refused, not drawn empty", missingCenter.result?.isError === true && missingCenter.result.content[0].text.includes("Note not found"));
  const agentGraph = JSON.parse((await call(agents.tech.token, "brain_graph")).result.content[0].text);
  ok("an agent's graph holds only what it may read", agentGraph.nodes.every((n) => n.name !== "backup-window"), JSON.stringify(agentGraph.nodes.map((n) => n.name)));

  const agentGaps = await call(agents.tech.token, "brain_gaps");
  ok("the register is the owner's", agentGaps.result?.isError === true && agentGaps.result.content[0].text.includes("owner's"), JSON.stringify(agentGaps.result).slice(0, 140));

  if (hasSqlite) {
    await call(MASTER, "brain_search", { query: "una domanda che il vault non sa" });
    const gaps = JSON.parse((await call(MASTER, "brain_gaps")).result.content[0].text);
    ok("the owner sees the open gaps", Array.isArray(gaps.gaps) && gaps.gaps.length >= 1, JSON.stringify(gaps).slice(0, 160));
    ok("each row carries what the page shows", gaps.gaps[0].query && typeof gaps.gaps[0].count === "number");
  } else {
    const noRegister = await call(MASTER, "brain_gaps");
    ok("without a register the tool says how to get one", noRegister.result?.isError === true && noRegister.result.content[0].text.includes("--gaps"));
  }
} finally {
  child.kill();
  // Windows keeps the register file locked until the process is really gone.
  await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
}

await rm(root, { recursive: true, force: true }).catch(() => {});
console.log(failures === 0 ? "\nall apps tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
