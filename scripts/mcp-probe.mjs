// Probe the MCP stdio server: initialize → tools/list → brain_search call.
import { spawn } from "node:child_process";

const child = spawn("node", ["packages/cli/dist/index.js", "serve", ".smoke-vault"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

let buf = "";
const responses = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) responses.push(JSON.parse(line));
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0.0.1" },
  },
});

await waitFor(() => responses.some((r) => r.id === 1));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
await waitFor(() => responses.some((r) => r.id === 2));
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "brain_search", arguments: { query: "example lesson", k: 3 } },
});
await waitFor(() => responses.some((r) => r.id === 3));

const tools = responses.find((r) => r.id === 2).result.tools.map((t) => t.name);
const hit = JSON.parse(responses.find((r) => r.id === 3).result.content[0].text)[0];
console.log(`MCP probe OK — tools: [${tools.join(", ")}], search top hit: ${hit.name} (score ${hit.score})`);
child.kill();
process.exit(0);

async function waitFor(cond, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("MCP probe timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
