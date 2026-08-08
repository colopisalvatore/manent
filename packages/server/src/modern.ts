import type { BrainContext } from "./context.js";
import { BRAIN_TOOLS, findTool } from "./tools.js";

/**
 * Modern era: MCP revision 2026-07-28 and later, implemented natively.
 *
 * No handshake, no sessions — every request carries its own protocol version
 * and is served on its own. Results declare `resultType`, and list results
 * carry the caching hints that revision requires. This path does not use the
 * official SDK, which still speaks the legacy revisions; see `./legacy.ts`.
 */

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const SERVER_INFO = { name: "manent", version: "0.0.1" } as const;

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

/** Error codes reserved for the specification (see the 2026-07-28 allocation policy). */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const LIST_TTL_MS = 300_000;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Reads the per-request protocol version from `_meta` (body or params). */
export function declaredProtocolVersion(body: Record<string, unknown>): string | undefined {
  const params = (body.params ?? {}) as Record<string, unknown>;
  const meta = {
    ...((body._meta as Record<string, unknown>) ?? {}),
    ...((params._meta as Record<string, unknown>) ?? {}),
  };
  const v = meta[PROTOCOL_VERSION_KEY];
  return typeof v === "string" ? v : undefined;
}

/**
 * True when a request belongs to the modern era: an RPC that only exists there,
 * or an explicitly declared 2026+ protocol version.
 *
 * Deliberately NOT keyed on the `Mcp-Method` transport header — dual-era
 * clients send it with a legacy `initialize` too, and treating it as a modern
 * marker rejects their handshake.
 */
export function isModernRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.method === "initialize" || b.method === "notifications/initialized") return false;
  if (b.method === "server/discover" || b.method === "subscriptions/listen") return true;
  const declared = declaredProtocolVersion(b);
  return declared !== undefined && declared >= "2026-";
}

const withMeta = (result: Record<string, unknown>): Record<string, unknown> => ({
  resultType: "complete",
  ...result,
  _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
});

export function handleModernRequest(body: unknown, ctx: BrainContext): JsonRpcResponse | undefined {
  if (!body || typeof body !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: INVALID_PARAMS, message: "expected a JSON-RPC object" } };
  }
  const b = body as Record<string, unknown>;
  const id = (b.id ?? null) as string | number | null;
  const method = String(b.method ?? "");

  // Notifications carry no id and expect no response.
  if (b.id === undefined && method.startsWith("notifications/")) return undefined;

  const declared = declaredProtocolVersion(b);
  if (declared !== undefined && !MODERN_VERSIONS.includes(declared as (typeof MODERN_VERSIONS)[number])) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: "Unsupported protocol version",
        data: { supported: [...MODERN_VERSIONS], requested: declared },
      },
    };
  }

  switch (method) {
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id,
        result: withMeta({
          supportedVersions: [...MODERN_VERSIONS],
          capabilities: { tools: {} },
          instructions:
            "File-first memory vault. Search with brain_search, open a note with brain_read, walk its links with brain_neighbors.",
          ttlMs: LIST_TTL_MS,
          cacheScope: "private",
        }),
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: withMeta({
          tools: BRAIN_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchemaJson,
          })),
          ttlMs: LIST_TTL_MS,
          cacheScope: "private",
        }),
      };

    case "tools/call": {
      const params = (b.params ?? {}) as Record<string, unknown>;
      const tool = findTool(String(params.name ?? ""));
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(params.name)}` },
        };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const out = tool.run(args, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: withMeta({ content: out.content, ...(out.isError ? { isError: true } : {}) }),
      };
    }

    default:
      return { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  }
}
