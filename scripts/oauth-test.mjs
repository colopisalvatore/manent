// End-to-end OAuth 2.1 flow test against the local Manent HTTP server.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const TOKEN = "test-master-token-abcdefgh";
const PORT = 3941;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(
  "node",
  ["<repo>/packages/cli/dist/index.js", "serve", "<repo>/.smoke-vault", "--http", String(PORT), "--token", TOKEN],
  { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } },
);
child.stdout.on("data", () => {});
await new Promise((r) => setTimeout(r, 2500));

const b64url = (b) => Buffer.from(b).toString("base64url");
const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);

try {
  // 1. protected resource metadata
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  const prmBody = await prm.json();
  ok("resource metadata 200 + authorization_servers", prm.status === 200 && Array.isArray(prmBody.authorization_servers));

  // 2. AS metadata
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  ok("AS metadata has endpoints + S256", !!asm.authorize_endpoint || !!asm.authorization_endpoint, JSON.stringify(asm.code_challenge_methods_supported));

  // 3. dynamic client registration
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  });
  const regBody = await reg.json();
  ok("register 201 + client_id", reg.status === 201 && !!regBody.client_id);

  // 4. PKCE
  const verifier = b64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const q = new URLSearchParams({
    client_id: regBody.client_id, redirect_uri: redirectUri, state: "xyz",
    code_challenge: challenge, code_challenge_method: "S256", response_type: "code",
  });

  // 4a. consent page renders
  const page = await fetch(`${BASE}/authorize?${q}`);
  ok("consent page 200 html", page.status === 200 && (await page.text()).includes("Vault token"));

  // 4b. wrong token rejected
  const bad = await fetch(`${BASE}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(q), vault_token: "wrong" }),
  });
  ok("wrong vault token → 401, no redirect", bad.status === 401);

  // 4c. correct token → redirect with code
  const good = await fetch(`${BASE}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(q), vault_token: TOKEN }),
  });
  const loc = good.headers.get("location") ?? "";
  const code = new URL(loc).searchParams.get("code");
  ok("consent → 302 with code + state", good.status === 302 && !!code && new URL(loc).searchParams.get("state") === "xyz");

  // 5. wrong PKCE verifier rejected
  const badTok = await fetch(`${BASE}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: regBody.client_id, redirect_uri: redirectUri, code_verifier: "nope" }),
  });
  ok("bad PKCE verifier → 400", badTok.status === 400);

  // 6. fresh code + correct verifier → access token
  const good2 = await fetch(`${BASE}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(q), vault_token: TOKEN }),
  });
  const code2 = new URL(good2.headers.get("location")).searchParams.get("code");
  const tok = await fetch(`${BASE}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code2, client_id: regBody.client_id, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  const tokBody = await tok.json();
  ok("token exchange 200 + Bearer", tok.status === 200 && tokBody.token_type === "Bearer" && !!tokBody.access_token);

  // 7. code is single use
  const replay = await fetch(`${BASE}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code2, client_id: regBody.client_id, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  ok("code replay → 400", replay.status === 400);

  // 8. access token works on /mcp
  const call = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokBody.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const callBody = await call.json();
  ok("access token → tools/list works", call.status === 200 && callBody.result?.tools?.length === 3);

  // 9. forged access token rejected
  const forged = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer someclient.ZmFrZQ" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  ok("forged access token → 401 + WWW-Authenticate", forged.status === 401 && !!forged.headers.get("www-authenticate"));

  // 10. disallowed redirect_uri rejected
  const evil = await fetch(`${BASE}/authorize?` + new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/cb" }));
  ok("disallowed redirect_uri → 400", evil.status === 400);
} finally {
  child.kill();
}
