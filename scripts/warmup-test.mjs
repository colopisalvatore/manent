// The service restarts on every vault sync, so a dense ranker must never block
// startup: the server has to answer immediately with lexical results and upgrade
// itself in the background. This test fails if startup ever becomes blocking.
import { spawn } from "node:child_process";

const TOKEN = "test-master-token-abcdefgh";
const PORT = 3961;
const VAULT = ".smoke-vault";

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const child = spawn(
  "node",
  ["packages/cli/dist/index.js", "serve", VAULT, "--http", String(PORT), "--token", TOKEN, "--retriever", "fused"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));
child.stdout.on("data", () => {});

const call = () =>
  fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        name: "brain_search",
        arguments: { query: "example lesson", k: 2 },
      },
    }),
  });

// Wait only for the port, then time the first answer.
const t0 = Date.now();
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const r = await call();
    if (r.status === 200) {
      up = true;
      const elapsed = (Date.now() - t0) / 1000;
      const hits = JSON.parse((await r.json()).result.content[0].text).hits;
      ok(`answers within 10s of launch (${elapsed.toFixed(1)}s)`, elapsed < 10, `hits=${hits.length}`);
      ok("serves lexical results before the model is loaded", hits[0]?.via === "bm25", `via=${hits[0]?.via}`);
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (!up) ok("server came up", false);

// Then wait for the dense upgrade and confirm the ranker changed.
for (let i = 0; i < 200; i++) {
  if (stderr.includes("ranker ready") || stderr.includes("ranker unavailable")) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (stderr.includes("ranker unavailable")) {
  console.log("SKIP  dense upgrade (embedding model not installed here)");
} else {
  const hits = JSON.parse((await (await call()).json()).result.content[0].text).hits;
  ok("upgrades to the fused ranker once warm", hits[0]?.via?.includes("dense"), `via=${hits[0]?.via}`);
}

child.kill();
if (failures > 0) process.exitCode = 1;
