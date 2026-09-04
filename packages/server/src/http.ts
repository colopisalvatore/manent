import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadBrainContext, type GapsOptions, type RetrieverName } from "./context.js";
import { LEGACY_VERSIONS, serveLegacyHttp } from "./legacy.js";
import { handleModernRequest, isModernRequest, MODERN_VERSIONS } from "./modern.js";
import { handleOAuth, verifyAccessToken } from "./oauth.js";

export interface HttpOptions {
  port: number;
  /** bind address — defaults to 127.0.0.1 so only a local tunnel/proxy can reach it */
  host?: string;
  /** required bearer token; also the password of the OAuth consent page */
  token: string;
  /** extra hosts allowed as OAuth redirect targets (claude.ai is allowed by default) */
  allowedRedirectHosts?: string[];
  /**
   * Pin the protocol era instead of detecting it per request:
   * "legacy" (handshake, SDK) or "modern" (2026-07-28, native). Default "auto".
   */
  era?: "auto" | "legacy" | "modern";
  /** ranking strategy; "fused" scores best but needs the embedding model */
  retriever?: RetrieverName;
  /** embedding model id for dense/fused */
  model?: string;
  /** allow the write tools; off by default — this server is network-reachable */
  writable?: boolean;
  /** record searches into a gap register */
  gaps?: GapsOptions;
}

/** Public origin as seen by the client, honouring the tunnel/proxy headers. */
function externalOrigin(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Streamable HTTP endpoint over a vault, serving two distinct protocol eras.
 *
 * The eras are separate implementations, not a blend: `./modern.ts` implements
 * revision 2026-07-28 natively (no handshake, no sessions, `resultType` and
 * caching hints), while `./legacy.ts` serves the handshake revisions through
 * the official SDK. This router only decides which one answers a request; the
 * tool definitions they share live in `./tools.ts`, so the two can never
 * expose different capabilities.
 *
 * Auth, two accepted forms:
 *   1. `Authorization: Bearer <token>` — the vault token or an OAuth-issued one
 *   2. `/t/<token>/mcp` path prefix, for clients that can set neither headers
 *      nor complete OAuth. A capability URL is a credential: treat it like a
 *      password and rotate by restarting with a new token.
 */
export async function serveHttp(root: string, opts: HttpOptions): Promise<Server> {
  if (!opts.token || opts.token.length < 16) {
    throw new Error("http mode requires a token of at least 16 chars (--token or MANENT_HTTP_TOKEN)");
  }
  const ctx = await loadBrainContext(root, {
    retriever: opts.retriever,
    model: opts.model,
    writable: opts.writable,
    gaps: opts.gaps,
  });
  const pinned = opts.era ?? "auto";

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = url.pathname;

      // Request log — tokens in the path are masked. Without this, diagnosing
      // a client that "cannot reach the server" is pure guesswork.
      const shown = path.replace(/^\/t\/[^/]+/, "/t/***");
      let era = "-";
      res.on("finish", () => {
        console.log(
          `${req.method} ${shown} → ${res.statusCode}  era=${era}  ua=${req.headers["user-agent"] ?? "-"}  accept=${req.headers.accept ?? "-"}`,
        );
      });

      // Browser-side clients preflight before posting; a 405 there reads as
      // "server unreachable".
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": req.headers.origin ?? "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers":
            "content-type, authorization, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }
      if (req.headers.origin) {
        res.setHeader("access-control-allow-origin", req.headers.origin);
        res.setHeader("access-control-expose-headers", "mcp-session-id");
      }

      // OAuth endpoints are public by design — discovery is what lets clients
      // that require OAuth (claude.ai) connect at all.
      if (
        await handleOAuth(req, res, path.replace(/^\/t\/[^/]+/, ""), {
          masterToken: opts.token,
          allowedRedirectHosts: opts.allowedRedirectHosts,
        })
      ) {
        return;
      }

      let provided: string | undefined;
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) provided = auth.slice("Bearer ".length).trim();
      const pathToken = path.match(/^\/t\/([^/]+)(\/.*)$/);
      if (pathToken) {
        provided ??= decodeURIComponent(pathToken[1]);
        path = pathToken[2];
      }
      // Accept either the vault token itself or an OAuth-issued access token.
      const authorized =
        provided !== undefined &&
        (safeEqual(provided, opts.token) || verifyAccessToken(opts.token, provided));
      if (!authorized) {
        // Point unauthenticated clients at the metadata that tells them how to
        // authenticate (RFC 9728) — without it they cannot start the flow.
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="manent", resource_metadata="${externalOrigin(req)}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (path !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found — MCP endpoint is /mcp" }));
        return;
      }

      const body = await readJsonBody(req);

      // ── Era routing: exactly one implementation answers ──────────────────
      const useModern = pinned === "modern" || (pinned === "auto" && isModernRequest(body));
      era = useModern ? "modern" : "legacy";

      if (useModern) {
        const response = await handleModernRequest(body, ctx);
        if (!response) {
          res.writeHead(202).end(); // notification: accepted, nothing to return
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      // Legacy path. When the era is pinned to legacy, a modern request gets the
      // 4xx-without-modern-error-body that makes dual-era clients fall back.
      if (pinned === "legacy" && isModernRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "legacy_protocol_only",
            message: "This endpoint is pinned to the initialize-handshake revisions.",
            supportedVersions: LEGACY_VERSIONS,
          }),
        );
        return;
      }
      await serveLegacyHttp(req, res, body, ctx);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => httpServer.listen(opts.port, host, resolve));
  console.log(
    `manent MCP endpoint on http://${host}:${opts.port}/mcp — era=${pinned} (legacy ${LEGACY_VERSIONS.join(", ")} | modern ${MODERN_VERSIONS.join(", ")}), auth required`,
  );
  return httpServer;
}
