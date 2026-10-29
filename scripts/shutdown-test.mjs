// Graceful shutdown over HTTP: SIGTERM (what `systemctl restart` sends — the
// brain-sync timer runs that on every change it pulls) must not sever a
// request already in flight, the way an unhandled SIGTERM otherwise kills
// the process at once. A real timing race (fire a request, hope it is still
// running when the signal lands) would be flaky, so this drives the "in
// flight" state directly: a raw socket sends full headers plus all but the
// last byte of the body, which leaves `readJsonBody`'s `for await` genuinely
// suspended — Node has accepted the connection and is mid-request — until
// the test supplies that last byte itself, on its own schedule.
//
// Windows has no POSIX signal delivery: `child.kill("SIGTERM")` there
// unconditionally terminates the process (confirmed directly — a bare
// `process.on("SIGTERM", ...)` child never sees it), so there is nothing
// this test can exercise on that platform. It skips there rather than
// failing on an OS limitation; CI (ubuntu-latest) and the deploy target
// (systemd, real SIGTERM) are where this matters and where it runs for real.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("SKIP  shutdown-test: Windows delivers no real SIGTERM to intercept (see file header)");
  process.exit(0);
}

const TOKEN = "shutdown-test-master-token-0123456789";
const PORT = 3985;

const cli = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
const vault = fileURLToPath(new URL("../.smoke-vault", import.meta.url));
if (!existsSync(vault)) spawnSync("node", [cli, "init", vault], { stdio: "inherit" });

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

/** Opens a socket, sends everything but `held` bytes of the request, and leaves it mid-flight. */
function sendPartial(body, held) {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, "127.0.0.1");
    sock.once("error", reject);
    sock.once("connect", () => {
      const head =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${PORT}\r\n` +
        `Authorization: Bearer ${TOKEN}\r\n` +
        `Content-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\n` +
        `Connection: close\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
      sock.write(head + body.slice(0, body.length - held));
      resolve(sock);
    });
  });
}

/** Reads one HTTP/1.1 response off a socket: status code and the JSON body. */
function readResponse(sock) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = buf.slice(0, headEnd);
      const status = Number.parseInt(head.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? "0", 10);
      const lenMatch = head.match(/content-length:\s*(\d+)/i);
      const bodyLen = lenMatch ? Number.parseInt(lenMatch[1], 10) : undefined;
      const bodySoFar = buf.slice(headEnd + 4);
      if (bodyLen === undefined || Buffer.byteLength(bodySoFar) >= bodyLen) {
        sock.off("data", onData);
        resolve({ status, body: bodySoFar });
      }
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.once("close", () => reject(new Error("socket closed before a full response arrived")));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForExit = (child, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const child = spawn("node", [cli, "serve", vault, "--http", String(PORT), "--token", TOKEN], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
await sleep(2500);

try {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "brain_list", arguments: {} },
  });

  // 1. Start a request, withholding its very last byte: accepted, mid-flight.
  const sock = await sendPartial(body, 1);
  await sleep(150);

  // 2. Ask the server to stop. A brand-new connection attempted right after
  //    must be refused — proof `close()` has already stopped accepting ones —
  //    while the one above, already in progress, must not be.
  child.kill("SIGTERM");
  await sleep(300);
  let newConnRefused = false;
  try {
    const probe = connect(PORT, "127.0.0.1");
    await new Promise((resolve, reject) => {
      probe.once("connect", () => reject(new Error("connected")));
      probe.once("error", resolve);
    });
    newConnRefused = true;
  } catch {
    newConnRefused = false;
  }
  ok("a new connection after SIGTERM is refused, not accepted", newConnRefused);

  // 3. Only now supply the withheld byte — the in-flight request still gets
  //    a real response, despite the server already shutting down.
  sock.write(body.slice(body.length - 1));
  const resp = await readResponse(sock);
  const parsed = resp.status === 200 ? JSON.parse(resp.body) : undefined;
  ok(
    "the request already in flight when SIGTERM arrived still completes",
    resp.status === 200 && parsed?.result?.content !== undefined,
    `status=${resp.status} body=${resp.body.slice(0, 120)}`,
  );

  // 4. The process exits well inside its own grace window, not hanging
  //    indefinitely and not instantly killed before step 3 could run.
  const exited = await waitForExit(child, 5000);
  ok("the process exits within its grace window once drained", exited);
  ok("it logs why it is waiting, not just dying silently", /draining in-flight requests/.test(stderr), stderr.slice(0, 200));
} finally {
  child.kill("SIGKILL");
}

console.log(failures === 0 ? "\nall shutdown tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
