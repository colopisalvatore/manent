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
