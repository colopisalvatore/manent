import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildBrainServer, loadBrainContext } from "./index.js";

export interface HttpOptions {
  port: number;
  /** bind address — defaults to 127.0.0.1 so only a local tunnel/proxy can reach it */
  host?: string;
  /** required bearer token; requests without it get 401 */
  token: string;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

/** Revisions the official SDK speaks today (handshake-based, "legacy" era). */
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/**
 * True when the request is written in the modern, handshake-free era
 * (2026-07-28+): the `server/discover` RPC, per-request protocol metadata,
 * or the transport headers that revision made mandatory.
 */
function isModernRequest(req: IncomingMessage, body: unknown): boolean {
  if (req.headers["mcp-method"] !== undefined) return true;
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.method === "server/discover" || b.method === "subscriptions/listen") return true;
  const params = (b.params ?? {}) as Record<string, unknown>;
  const meta = { ...((b._meta as object) ?? {}), ...((params._meta as object) ?? {}) } as Record<string, unknown>;
  const declared = meta["io.modelcontextprotocol/protocolVersion"];
  return typeof declared === "string" && declared >= "2026-";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Streamable HTTP endpoint over a vault. Stateless by design: one transport
 * per request, shared read-only brain context, JSON responses (no SSE
 * buffering issues behind tunnels/proxies).
 *
 * Auth, two accepted forms:
 *   1. `Authorization: Bearer <token>` header (preferred)
 *   2. `/t/<token>/mcp` path prefix — fallback for clients that cannot set
 *      headers. A capability URL is a credential: treat it like a password,
 *      rotate by restarting with a new token.
 */
export async function serveHttp(root: string, opts: HttpOptions): Promise<Server> {
  if (!opts.token || opts.token.length < 16) {
    throw new Error("http mode requires a token of at least 16 chars (--token or MANENT_HTTP_TOKEN)");
  }
  const ctx = await loadBrainContext(root);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = url.pathname;

      // Request log — tokens in the path are masked. Without this, diagnosing
      // a client that "cannot reach the server" is pure guesswork.
      const shown = path.replace(/^\/t\/[^/]+/, "/t/***");
      res.on("finish", () => {
        console.log(
          `${req.method} ${shown} → ${res.statusCode}  ua=${req.headers["user-agent"] ?? "-"}  accept=${req.headers.accept ?? "-"}`,
        );
      });

      // Browser-side clients preflight before posting; a 405 there reads as
      // "server unreachable".
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": req.headers.origin ?? "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, authorization, accept, mcp-protocol-version, mcp-session-id",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }
      if (req.headers.origin) {
        res.setHeader("access-control-allow-origin", req.headers.origin);
        res.setHeader("access-control-expose-headers", "mcp-session-id");
      }

      // Discovery probes must answer in the clear: a 401 here makes clients
      // (claude.ai) assume OAuth is available and attempt registration, which
      // then fails. A plain 404 tells them this server has no OAuth.
      if (path.startsWith("/.well-known/") || path === "/register") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no OAuth on this server — use bearer token or /t/<token>/mcp" }));
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
      if (!provided || !safeEqual(provided, opts.token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (path !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found — MCP endpoint is /mcp" }));
        return;
      }

      const body = await readJsonBody(req);
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        const params = (b.params ?? {}) as Record<string, unknown>;
        const meta = (b._meta ?? params._meta ?? {}) as Record<string, unknown>;
        console.log(
          `  rpc method=${String(b.method)} protocolVersion=${String(
            params.protocolVersion ?? meta["io.modelcontextprotocol/protocolVersion"] ?? "-",
          )} mcpMethodHeader=${String(req.headers["mcp-method"] ?? "-")}`,
        );
      }
      // Backward-compatibility signal for modern (2026-07-28+) clients.
      // This server speaks the legacy, handshake-based revisions via the
      // official SDK. Per the spec's HTTP fallback rule, a modern client
      // falls back to `initialize` when a modern request returns 4xx with no
      // recognized modern error body — a 200 carrying "Method not found"
      // instead reads as an unusable server.
      if (isModernRequest(req, body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "legacy_protocol_only",
            message:
              "This server implements the initialize-handshake protocol revisions. Retry with the legacy initialize flow.",
            supportedVersions: LEGACY_VERSIONS,
          }),
        );
        return;
      }

      const server = buildBrainServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => httpServer.listen(opts.port, host, resolve));
  return httpServer;
}
