// Both protocol eras, exercised separately: legacy (handshake revisions, via the
// official SDK) and modern (2026-07-28, native). Also covers auto-routing and
// the dual-era regression where claude.ai's legacy initialize carried the
// modern Mcp-Method header and was rejected.
import { spawn } from "node:child_process";

const TOKEN = "test-master-token-abcdefgh";
const VAULT = ".smoke-vault";

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

// Tracks the tool set in packages/server/src/tools.ts. Checked by name, not by a
// magic count, so adding a tool needs one edit here, not three scattered fixes.
// These servers start without --writable, so the write tools must NOT be
// advertised: a read-only vault should not offer a tool that can only fail.
const EXPECTED_TOOLS = [
  "brain_search",
  "brain_read",
  "brain_neighbors",
  "brain_list",
  "brain_read_raw",
  "brain_grep",
  "brain_feedback",
  "brain_curate",
  "brain_quarantine",
  "brain_gaps",
  "brain_graph",
];
const WRITE_TOOLS = ["brain_write", "brain_append"];
const hasAllTools = (list) =>
  Array.isArray(list) &&
  list.length === EXPECTED_TOOLS.length &&
  EXPECTED_TOOLS.every((n) => list.some((t) => t.name === n)) &&
  WRITE_TOOLS.every((n) => !list.some((t) => t.name === n));

async function withServer(port, era, fn) {
  const args = ["packages/cli/dist/index.js", "serve", VAULT, "--http", String(port), "--token", TOKEN];
  if (era) args.push("--era", era);
  const child = spawn("node", args, { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.on("data", () => {});
  await new Promise((r) => setTimeout(r, 2500));
  try {
    await fn((body, extraHeaders = {}) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    child.kill();
  }
}

const LEGACY_INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-client", version: "1" } },
};
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

console.log("── era=legacy (pinned) ──");
await withServer(3951, "legacy", async (post) => {
  const init = await post(LEGACY_INIT);
  const initBody = await init.json();
  ok("initialize → 200, version negotiated", init.status === 200 && initBody.result?.protocolVersion === "2025-11-25");

  // The claude.ai regression: legacy handshake plus modern transport headers.
  const dual = await post(LEGACY_INIT, { "mcp-method": "initialize", "mcp-name": "manent" });
  ok("dual-era initialize (Mcp-Method header) → 200", dual.status === 200, `status=${dual.status}`);

  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const toolsBody = await tools.json();
  ok("tools/list → all tools", tools.status === 200 && hasAllTools(toolsBody.result?.tools));

  const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "brain_search", arguments: { query: "example lesson", k: 2 } } });
  const callBody = await call.json();
  ok("tools/call brain_search → hit", call.status === 200 && callBody.result?.content?.[0]?.text?.includes("example-lesson"));

  const modern = await post({ jsonrpc: "2.0", id: 4, method: "server/discover", params: { _meta: MODERN_META } });
  ok("modern request on pinned legacy → 400 fallback signal", modern.status === 400);
});

console.log("\n── era=modern (pinned) ──");
await withServer(3952, "modern", async (post) => {
  const disc = await post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN_META } });
  const discBody = await disc.json();
  ok(
    "server/discover → supportedVersions + resultType + serverInfo",
    disc.status === 200 &&
      discBody.result?.supportedVersions?.includes("2026-07-28") &&
      discBody.result?.resultType === "complete" &&
      discBody.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "manent",
  );
  ok("server/discover advertises caching hints", !!discBody.result?.ttlMs && !!discBody.result?.cacheScope);

  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: MODERN_META } });
  const toolsBody = await tools.json();
  ok(
    "tools/list → all tools with JSON Schema + cache fields",
    tools.status === 200 &&
      hasAllTools(toolsBody.result?.tools) &&
      toolsBody.result.tools[0].inputSchema?.type === "object" &&
      toolsBody.result.resultType === "complete" &&
      !!toolsBody.result.ttlMs,
  );

  const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: MODERN_META, name: "brain_search", arguments: { query: "example lesson", k: 2 } } });
  const callBody = await call.json();
  ok("tools/call brain_search → hit, no handshake needed", call.status === 200 && callBody.result?.content?.[0]?.text?.includes("example-lesson"));

  const bad = await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } });
  const badBody = await bad.json();
  ok(
    "unknown version → -32022 with supported list",
    badBody.error?.code === -32022 && Array.isArray(badBody.error?.data?.supported),
  );

  const unknown = await post({ jsonrpc: "2.0", id: 5, method: "nope/nope", params: { _meta: MODERN_META } });
  ok("unknown method → -32601", (await unknown.json()).error?.code === -32601);
});

console.log("\n── era=auto (default) ──");
await withServer(3953, null, async (post) => {
  const legacy = await post(LEGACY_INIT, { "mcp-method": "initialize" });
  ok("legacy initialize routed to legacy → 200", legacy.status === 200);

  const modern = await post({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: MODERN_META } });
  const modernBody = await modern.json();
  ok("server/discover routed to modern → DiscoverResult", modern.status === 200 && !!modernBody.result?.supportedVersions);

  const modernCall = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: MODERN_META, name: "brain_read", arguments: { name: "example-lesson" } } });
  ok("modern tools/call routed to modern → note body", (await modernCall.json()).result?.content?.[0]?.text?.includes("Feedback notes"));

  const legacyTools = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  ok("bare tools/list routed to legacy → all tools", hasAllTools((await legacyTools.json()).result?.tools));
});

console.log(failures === 0 ? "\nall era tests passed" : `\n${failures} FAILURES`);
if (failures > 0) process.exitCode = 1;
