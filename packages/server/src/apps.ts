/**
 * MCP Apps: `io.modelcontextprotocol/ui`, the two views worth having.
 *
 * Some answers are lists a person acts on, one row at a time — the notes an
 * agent wrote and nobody has promoted, the questions the brain could not
 * answer. As text in a transcript those are a wall the reader skims; as a small
 * page they are a work queue, sorted, with the number that matters in front.
 * That is all an app is here: the same tool result, laid out.
 *
 * Two rules hold for both pages, and they are the reason this is safe to
 * render inside somebody's chat:
 *
 * - **Nothing is loaded from anywhere.** No script tag with a src, no font, no
 *   stylesheet, no fetch. The page is the resource, so its CSP needs no
 *   `connectDomains` and there is no origin to trust but the host's own frame.
 * - **The page decides nothing.** It reads a tool result and it may ask for the
 *   same tool again. Promoting a note or closing a gap is a write, and writes
 *   go through the gate and the person's confirmation, never through a button
 *   that a page could press on its own.
 */

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

export interface AppResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  html: string;
}

/** The bridge every app speaks: JSON-RPC over postMessage, with the host as peer. */
const BRIDGE = `
const pending = new Map();
let nextId = 1;
const send = (msg) => window.parent.postMessage(msg, "*");
function call(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message ?? "call failed")) : resolve(msg.result);
    return;
  }
  if (msg.method === "ui/notifications/tool-result") render(msg.params);
});
async function boot(toolName) {
  const hello = await call("ui/initialize", {
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    clientInfo: { name: "manent-app", version: "0.0.1" },
    protocolVersion: "2026-01-26",
  });
  notify("ui/notifications/initialized", {});
  applyTheme(hello?.hostContext);
  document.getElementById("refresh").addEventListener("click", () => refresh(toolName));
  // The host pushes the result that opened this app; if it does not, ask.
  setTimeout(() => { if (!document.body.dataset.rendered) refresh(toolName); }, 400);
}
async function refresh(toolName) {
  setStatus("reading the vault…");
  try {
    render(await call("tools/call", { name: toolName, arguments: {} }));
  } catch (err) {
    setStatus(err.message);
  }
}
function applyTheme(hostContext) {
  if (hostContext?.theme === "dark") document.documentElement.dataset.theme = "dark";
  for (const [k, v] of Object.entries(hostContext?.styles?.variables ?? {})) {
    document.documentElement.style.setProperty(k.startsWith("--") ? k : "--" + k, v);
  }
}
function payload(params) {
  if (params?.structuredContent) return params.structuredContent;
  const text = params?.content?.find((c) => c.type === "text")?.text;
  try { return text ? JSON.parse(text) : undefined; } catch { return undefined; }
}
function setStatus(message) { document.getElementById("status").textContent = message; }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
`;

const STYLE = `
:root {
  --app-fg: #16130f;
  --app-muted: #6b625a;
  --app-bg: #faf9f7;
  --app-card: #ffffff;
  --app-line: #e4dfd8;
  --app-accent: #8a5a2b;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --app-fg: #ece7e1;
  --app-muted: #9d948a;
  --app-bg: #17151300;
  --app-card: #221f1c;
  --app-line: #34302b;
  --app-accent: #d8a26a;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  background: var(--app-bg);
  color: var(--app-fg);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
#status { color: var(--app-muted); font-size: 12px; flex: 1; }
button {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--app-line); background: var(--app-card); color: var(--app-fg); cursor: pointer;
}
button:hover { border-color: var(--app-accent); color: var(--app-accent); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
li {
  background: var(--app-card); border: 1px solid var(--app-line); border-radius: 8px;
  padding: 10px 12px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: baseline;
}
.count {
  font-variant-numeric: tabular-nums; font-weight: 600; color: var(--app-accent);
  min-width: 3ch; text-align: right;
}
.name { font-weight: 600; word-break: break-word; }
.meta { grid-column: 2; color: var(--app-muted); font-size: 12px; }
.empty { color: var(--app-muted); padding: 24px 0; text-align: center; }
.meta { color: var(--app-muted); font-size: 12px; }
svg { width: 100%; height: auto; display: block; margin-top: 8px; }
.edge { stroke: var(--app-line); stroke-width: 1; }
.edge.supersedes, .edge.contradicts { stroke: var(--app-accent); stroke-dasharray: 3 3; }
.node circle { fill: var(--app-card); stroke: var(--app-muted); stroke-width: 1.5; cursor: pointer; }
.node:hover circle, .node:focus circle { stroke: var(--app-accent); stroke-width: 2.5; outline: none; }
.node.is-center circle { fill: var(--app-accent); stroke: var(--app-accent); }
.node.is-quarantine circle { stroke-dasharray: 2 2; }
.node text { fill: var(--app-fg); font-size: 11px; pointer-events: none; }
.card {
  background: var(--app-card); border: 1px solid var(--app-line); border-radius: 8px;
  padding: 10px 12px; margin-top: 8px; display: flex; flex-direction: column; gap: 4px;
}
.row { display: flex; gap: 8px; margin-top: 6px; }
`;

const page = (title: string, body: string, script: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <span id="status"></span>
  <button id="refresh" type="button">Refresh</button>
</header>
${body}
<script>
${BRIDGE}
${script}
</script>
</body>
</html>
`;

const QUARANTINE_APP = page(
  "Waiting for a person",
  `<ul id="rows"></ul>`,
  `
function render(params) {
  const data = payload(params);
  const rows = Array.isArray(data?.queue) ? data.queue : [];
  document.body.dataset.rendered = "1";
  setStatus(rows.length === 0 ? "nothing in quarantine" : rows.length + " waiting, oldest first");
  document.getElementById("rows").innerHTML = rows.length === 0
    ? '<li class="empty">No agent note is waiting. Everything written has been promoted or was written by you.</li>'
    : rows.map((r) => (
        '<li><span class="count">' + esc(r.ageDays) + 'd</span>' +
        '<span class="name">' + esc(r.name) + '</span>' +
        '<span class="meta">' + esc(r.description) + '</span>' +
        '<span class="meta">' + esc(r.author ?? "unknown") + ' · ' + esc((r.audience ?? []).join(", ")) + ' · ' + esc(r.relPath) + '</span>' +
        '<span class="meta">promote it: manent promote &lt;vault&gt; --note ' + esc(r.name) + ' --audience &lt;labels&gt; --to &lt;folder&gt; --commit</span></li>'
      )).join("");
}
boot("brain_quarantine");
`,
);

const GAPS_APP = page(
  "Questions the brain could not answer",
  `<ul id="rows"></ul>`,
  `
function render(params) {
  const data = payload(params);
  const rows = Array.isArray(data?.gaps) ? data.gaps : [];
  document.body.dataset.rendered = "1";
  setStatus(rows.length === 0 ? "no open gap" : rows.length + " open, most asked first");
  document.getElementById("rows").innerHTML = rows.length === 0
    ? '<li class="empty">Every search was followed by a read, or the register is empty.</li>'
    : rows.map((g) => (
        '<li><span class="count">' + esc(g.count) + '</span>' +
        '<span class="name">' + esc(g.query) + '</span>' +
        '<span class="meta">asked ' + esc(g.count) + '× · read ' + esc(g.followed) + '× · best score ' + esc(g.topScore ?? "-") + ' · ' + esc((g.agents ?? []).join(", ")) + '</span>' +
        '<span class="meta">close it by writing the note that answers it, then: manent gaps &lt;vault&gt; --gaps &lt;db&gt; --close ' + esc(g.id) + ' --note &lt;name&gt;</span></li>'
      )).join("");
}
boot("brain_gaps");
`,
);

const GRAPH_APP = page(
  "What this note is part of",
  `<div id="hint" class="meta">A vault is a graph. This is the part of it around one note.</div>
<svg id="canvas" viewBox="0 0 800 520" role="img" aria-label="wikilink neighbourhood"></svg>
<div id="detail"></div>`,
  `
let current = null;
// A layout nobody can act on is one that moves between runs, so there is no
// randomness here: positions start on a circle in name order and are relaxed by
// a fixed number of steps. The same neighbourhood always draws the same way.
function layout(nodes, edges, width, height) {
  const n = nodes.length;
  const k = Math.sqrt((width * height) / Math.max(n, 1)) * 0.6;
  const index = new Map(nodes.map((node, i) => [node.name, i]));
  const pos = nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1);
    const radius = node.name === current ? 0 : Math.min(width, height) * 0.36;
    return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
  });
  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined);
  let temperature = Math.min(width, height) / 8;
  for (let step = 0; step < 220; step++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d = Math.hypot(dx, dy) || 0.01;
        // Beyond a couple of ideal spacings a node says nothing about another,
        // and summing every far pair is what inflates the whole drawing until
        // it parks on the border: measured, 40 of 60 nodes clamped without this.
        if (d > 2.5 * k) continue;
        // Two notes at the same spot need a push in some direction; a fixed one
        // keeps the drawing reproducible.
        if (d < 0.02) { dx = (i - j) * 0.01; dy = 0.01; d = Math.hypot(dx, dy); }
        const force = (k * k) / d;
        disp[i].x += (dx / d) * force; disp[i].y += (dy / d) * force;
        disp[j].x -= (dx / d) * force; disp[j].y -= (dy / d) * force;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const force = (d * d) / k;
      disp[a].x -= (dx / d) * force; disp[a].y -= (dy / d) * force;
      disp[b].x += (dx / d) * force; disp[b].y += (dy / d) * force;
    }
    for (let i = 0; i < n; i++) {
      if (nodes[i].name === current) continue; // the centre stays in the middle
      // A weak pull to the middle: without it repulsion alone parks every node
      // on the border, which draws a ring of dots and no structure.
      disp[i].x += (width / 2 - pos[i].x) * 0.06;
      disp[i].y += (height / 2 - pos[i].y) * 0.06;
      const d = Math.hypot(disp[i].x, disp[i].y) || 1;
      pos[i].x += (disp[i].x / d) * Math.min(d, temperature);
      pos[i].y += (disp[i].y / d) * Math.min(d, temperature);
      pos[i].x = Math.max(24, Math.min(width - 24, pos[i].x));
      pos[i].y = Math.max(24, Math.min(height - 24, pos[i].y));
    }
    temperature *= 0.975;
  }
  return pos;
}
function render(params) {
  const data = payload(params);
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];
  current = data?.center ?? null;
  document.body.dataset.rendered = "1";
  setStatus(
    nodes.length === 0
      ? "nothing to draw"
      : (current ? current + " · " : "the most linked notes · ") + nodes.length + " of " + (data.total ?? nodes.length) + " notes, " + edges.length + " links",
  );
  const W = 800, H = 520;
  const pos = layout(nodes, edges, W, H);
  const at = new Map(nodes.map((node, i) => [node.name, pos[i]]));
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));
  const parts = [];
  for (const e of edges) {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) continue;
    parts.push('<line class="edge ' + esc(e.kind) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"></line>');
  }
  for (const node of nodes) {
    const p = at.get(node.name);
    const r = 4 + 7 * Math.sqrt(node.degree / maxDegree);
    const cls = "node" + (node.name === current ? " is-center" : "") + (node.status === "quarantine" ? " is-quarantine" : "");
    parts.push(
      '<g class="' + cls + '" data-name="' + esc(node.name) + '" tabindex="0">' +
      '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) + '"></circle>' +
      '<title>' + esc(node.name) + (node.description ? " — " + esc(node.description) : "") + '</title>' +
      (node.degree >= maxDegree / 3 || node.name === current
        ? '<text x="' + (p.x + r + 3).toFixed(1) + '" y="' + (p.y + 4).toFixed(1) + '">' + esc(node.name.length > 26 ? node.name.slice(0, 25) + "…" : node.name) + '</text>'
        : "") +
      '</g>',
    );
  }
  const canvas = document.getElementById("canvas");
  canvas.innerHTML = parts.join("");
  for (const g of canvas.querySelectorAll(".node")) {
    g.addEventListener("click", () => select(g.dataset.name, nodes));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") select(g.dataset.name, nodes); });
  }
  document.getElementById("detail").innerHTML = "";
}
function select(name, nodes) {
  const node = nodes.find((x) => x.name === name);
  document.getElementById("detail").innerHTML =
    '<div class="card"><div class="name">' + esc(name) + '</div>' +
    '<div class="meta">' + esc(node?.description ?? "") + '</div>' +
    '<div class="meta">' + esc(node?.type ?? "note") + ' · ' + esc(node?.degree ?? 0) + ' links' + (node?.status ? ' · ' + esc(node.status) : '') + '</div>' +
    '<div class="row"><button type="button" id="recenter">Centre on it</button>' +
    '<button type="button" id="ask">Ask about it</button></div></div>';
  document.getElementById("recenter").addEventListener("click", async () => {
    setStatus("walking to " + name + "…");
    try { render(await call("tools/call", { name: "brain_graph", arguments: { center: name } })); }
    catch (err) { setStatus(err.message); }
  });
  // The one thing a page may hand back to the conversation: a question. Reading
  // and writing stay with the tools, where the gate and the person are.
  document.getElementById("ask").addEventListener("click", () => {
    call("ui/message", { role: "user", content: { type: "text", text: "Read the note " + name + " and tell me what it says." } }).catch(() => {});
  });
}
boot("brain_graph");
`,
);

export const APP_RESOURCES: AppResource[] = [
  {
    uri: "ui://manent/quarantine",
    name: "quarantine review queue",
    description: "The notes agents wrote that are waiting for a person, oldest first.",
    mimeType: APP_MIME_TYPE,
    html: QUARANTINE_APP,
  },
  {
    uri: "ui://manent/gaps",
    name: "gap register",
    description: "The questions the brain could not answer, by how often they were asked.",
    mimeType: APP_MIME_TYPE,
    html: GAPS_APP,
  },
  {
    uri: "ui://manent/graph",
    name: "graph explorer",
    description: "The wikilink neighbourhood around a note: what it is part of, and what to open next.",
    mimeType: APP_MIME_TYPE,
    html: GRAPH_APP,
  },
];

export const findAppResource = (uri: string): AppResource | undefined => APP_RESOURCES.find((r) => r.uri === uri);

/** What `resources/list` shows: everything but the page itself. */
export const appResourceList = () => APP_RESOURCES.map(({ html: _html, ...rest }) => rest);

/**
 * What `resources/read` returns. The CSP is empty on purpose: the page loads
 * nothing, so there is no domain to allow, and a host that honours the
 * declaration will refuse anything the page tries anyway.
 */
export function readAppResource(uri: string): { contents: Array<Record<string, unknown>> } | undefined {
  const app = findAppResource(uri);
  if (!app) return undefined;
  return {
    contents: [
      {
        uri: app.uri,
        mimeType: app.mimeType,
        text: app.html,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      },
    ],
  };
}
