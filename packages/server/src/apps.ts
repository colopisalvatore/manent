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
