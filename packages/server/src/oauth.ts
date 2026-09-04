import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Minimal OAuth 2.1 authorization server, sized for one vault.
 *
 * Clients such as claude.ai will not talk to a remote MCP server that has no
 * discoverable OAuth metadata, so bearer-only is not enough. A static token
 * plays the role of the login password: the owner pastes the vault token, an
 * agent pastes its own, and the server issues an access token that names who
 * it was issued to.
 *
 * Access tokens are HMAC-derived from the master token rather than stored, so
 * they survive restarts (this service restarts whenever the vault syncs) with
 * no persistence layer. Authorization codes are short-lived and in-memory:
 * losing them to a restart only costs a re-authorization.
 */

const CODE_TTL_MS = 5 * 60_000;
const DEFAULT_ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com", "localhost", "127.0.0.1"];
export const OWNER_SUBJECT = "owner";

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  subject: string;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();

const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();

function constantTimeEqual(a: string, b: string): boolean {
  const ba = sha256(a);
  const bb = sha256(b);
  return timingSafeEqual(ba, bb);
}

/**
 * access token = <subject>~<clientId>.<HMAC(master, subject~clientId)>
 *
 * The owner's tokens keep the older two-part form <clientId>.<HMAC(master,
 * clientId)>: a connector authorized before identities existed stays valid
 * across the upgrade instead of asking its user to log in again.
 */
export function mintAccessToken(masterToken: string, clientId: string, subject: string = OWNER_SUBJECT): string {
  const id = subject === OWNER_SUBJECT ? clientId : `${subject}~${clientId}`;
  const mac = createHmac("sha256", masterToken).update(id).digest();
  return `${id}.${b64url(mac)}`;
}

/** The subject an access token was issued to, or undefined when it does not verify. */
export function subjectOfAccessToken(masterToken: string, presented: string): string | undefined {
  const dot = presented.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const id = presented.slice(0, dot);
  const tilde = id.indexOf("~");
  const subject = tilde > 0 ? id.slice(0, tilde) : OWNER_SUBJECT;
  const clientId = tilde > 0 ? id.slice(tilde + 1) : id;
  if (!clientId) return undefined;
  return constantTimeEqual(presented, mintAccessToken(masterToken, clientId, subject)) ? subject : undefined;
}

export function verifyAccessToken(masterToken: string, presented: string): boolean {
  return subjectOfAccessToken(masterToken, presented) !== undefined;
}

function externalOrigin(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function redirectUriAllowed(raw: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !localhost) return false;
  return allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function consentPage(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Manent — authorize access</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.25rem}
 h1{font-size:1.25rem;margin:0 0 .25rem} p{opacity:.75;margin:.25rem 0 1.5rem}
 label{display:block;font-size:.875rem;margin-bottom:.375rem}
 input[type=password]{width:100%;padding:.6rem .7rem;font:inherit;border:1px solid #8886;border-radius:.5rem;background:transparent;color:inherit}
 button{margin-top:1rem;width:100%;padding:.65rem;font:inherit;font-weight:600;border:0;border-radius:.5rem;background:#2f6feb;color:#fff;cursor:pointer}
 .err{color:#c0392b;font-size:.875rem;margin-top:.75rem}
 code{font-size:.8125rem;opacity:.7}
</style>
<h1>Authorize access to this vault</h1>
<p>A client is asking to read this Manent brain. Paste your access token — the vault token, or the token of the agent you are connecting — to approve.</p>
<form method="post">${hidden}
 <label for="t">Access token</label>
 <input id="t" name="vault_token" type="password" autocomplete="off" autofocus required>
 <button type="submit">Approve access</button>
 ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
</form>`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (v != null) sp.set(k, String(v));
      return sp;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

export interface OAuthOptions {
  masterToken: string;
  allowedRedirectHosts?: string[];
  /**
   * Maps a token pasted on the consent page to the subject it identifies.
   * Default: the master token is the owner, anything else is refused.
   */
  resolveSubject?: (presented: string) => string | undefined;
}

/**
 * Handles the OAuth endpoints. Returns true when the request was handled.
 * These endpoints are public by design — that is what makes discovery work.
 */
export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  opts: OAuthOptions,
): Promise<boolean> {
  const origin = externalOrigin(req);
  const allowedHosts = opts.allowedRedirectHosts ?? DEFAULT_ALLOWED_REDIRECT_HOSTS;
  const resolveSubject = opts.resolveSubject ?? ((t: string) => (constantTimeEqual(t, opts.masterToken) ? OWNER_SUBJECT : undefined));

  // Resource metadata may be probed at a path-suffixed URL too.
  if (path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/")) {
    json(res, 200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["brain.read"],
    });
    return true;
  }

  if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["brain.read"],
    });
    return true;
  }

  // Dynamic client registration — public clients, no secret issued.
  if (path === "/register" && req.method === "POST") {
    const form = await readForm(req);
    const clientId = randomUUID();
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: form.getAll("redirect_uris"),
      client_name: form.get("client_name") ?? "mcp-client",
    });
    return true;
  }

  if (path === "/authorize") {
    const url = new URL(req.url ?? "/", origin);
    const src = req.method === "POST" ? await readForm(req) : url.searchParams;
    const clientId = src.get("client_id") ?? "";
    const redirectUri = src.get("redirect_uri") ?? "";
    const state = src.get("state") ?? "";
    const challenge = src.get("code_challenge") ?? "";
    const method = src.get("code_challenge_method") ?? "";
    const resource = src.get("resource") ?? "";

    if (!clientId || !redirectUriAllowed(redirectUri, allowedHosts)) {
      json(res, 400, { error: "invalid_request", error_description: "missing client_id or disallowed redirect_uri" });
      return true;
    }
    if (!challenge || method !== "S256") {
      json(res, 400, { error: "invalid_request", error_description: "PKCE S256 is required" });
      return true;
    }

    const carried = { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: method, resource };

    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(consentPage(carried));
      return true;
    }

    const presented = src.get("vault_token") ?? "";
    const subject = presented ? resolveSubject(presented) : undefined;
    if (!subject) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(consentPage(carried, "Wrong token. Try again."));
      return true;
    }

    const code = b64url(randomBytes(32));
    codes.set(code, { clientId, redirectUri, codeChallenge: challenge, subject, expiresAt: Date.now() + CODE_TTL_MS });
    for (const [k, v] of codes) if (v.expiresAt < Date.now()) codes.delete(k);

    const to = new URL(redirectUri);
    to.searchParams.set("code", code);
    if (state) to.searchParams.set("state", state);
    res.writeHead(302, { location: to.toString(), "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (path === "/token" && req.method === "POST") {
    const form = await readForm(req);
    if (form.get("grant_type") !== "authorization_code") {
      json(res, 400, { error: "unsupported_grant_type" });
      return true;
    }
    const code = form.get("code") ?? "";
    const entry = codes.get(code);
    codes.delete(code); // single use
    if (!entry || entry.expiresAt < Date.now()) {
      json(res, 400, { error: "invalid_grant", error_description: "unknown or expired code" });
      return true;
    }
    if (form.get("client_id") !== entry.clientId || form.get("redirect_uri") !== entry.redirectUri) {
      json(res, 400, { error: "invalid_grant", error_description: "client_id/redirect_uri mismatch" });
      return true;
    }
    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || b64url(sha256(verifier)) !== entry.codeChallenge) {
      json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return true;
    }
    json(res, 200, {
      access_token: mintAccessToken(opts.masterToken, entry.clientId, entry.subject),
      token_type: "Bearer",
      scope: "brain.read",
    });
    return true;
  }

  return false;
}
