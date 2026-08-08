// Era-detection regression test: a dual-era client (legacy initialize plus the
// modern Mcp-Method header, as claude.ai sends) must be served, not rejected.
import { spawn } from "node:child_process";

const TOKEN = "test-master-token-abcdefgh";
const PORT = 3943;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

const child = spawn(
  "node",
  ["packages/cli/dist/index.js", "serve", ".smoke-vault", "--http", String(PORT), "--token", TOKEN],
  { stdio: ["ignore", "pipe", "inherit"] },
);
child.stdout.on("data", () => {});
await new Promise((r) => setTimeout(r, 2500));

const post = (body, extraHeaders = {}) =>
  fetch(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

try {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dual-era", version: "1" } } };

  const plain = await post(init);
  ok("legacy initialize → 200", plain.status === 200);

  // The regression: legacy initialize carrying the modern transport header.
  const dual = await post(init, { "mcp-method": "initialize", "mcp-name": "manent" });
  const dualBody = await dual.json();
  ok(
    "dual-era initialize (Mcp-Method header) → 200 + serverInfo",
    dual.status === 200 && dualBody.result?.serverInfo?.name === "manent",
    `status=${dual.status}`,
  );

  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-method": "tools/list" });
  const toolsBody = await tools.json();
  ok("tools/list with Mcp-Method header → 3 tools", tools.status === 200 && toolsBody.result?.tools?.length === 3);

  const modern = await post({ jsonrpc: "2.0", id: 3, method: "server/discover", params: {} });
  ok("modern server/discover → 400 fallback signal", modern.status === 400);
} finally {
  child.kill();
}

if (failures > 0) process.exitCode = 1;
