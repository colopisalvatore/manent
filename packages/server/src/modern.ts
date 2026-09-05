import type { BrainContext } from "./context.js";
import { TASKS_EXTENSION } from "./tasks.js";
import { callTool, findTool, toolsFor, type CallContext } from "./tools.js";

/**
 * Modern era: MCP revision 2026-07-28 and later, implemented natively.
 *
 * No handshake, no sessions — every request carries its own protocol version
 * and is served on its own. Results declare `resultType`, list results carry
 * the caching hints that revision requires, and a tool that needs the person's
 * answer returns `input_required` (multi round-trip request) instead of
 * blocking. This path does not use the official SDK, which still speaks the
 * legacy revisions; see `./legacy.ts`.
 */

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const SERVER_INFO = { name: "manent", version: "0.0.1" } as const;

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

/** Error codes reserved for the specification (see the 2026-07-28 allocation policy). */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** Whether this request's client said it speaks the tasks extension. */
function clientDoesTasks(body: Record<string, unknown>): boolean {
  const caps = requestMeta(body)[CLIENT_CAPABILITIES_KEY];
  if (!caps || typeof caps !== "object") return false;
  const extensions = (caps as Record<string, unknown>).extensions;
  return !!extensions && typeof extensions === "object" && TASKS_EXTENSION in (extensions as Record<string, unknown>);
}

const LIST_TTL_MS = 300_000;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** The per-request protocol fields, from `_meta` on the body or on the params. */
function requestMeta(body: Record<string, unknown>): Record<string, unknown> {
  const params = (body.params ?? {}) as Record<string, unknown>;
  return {
    ...((body._meta as Record<string, unknown>) ?? {}),
    ...((params._meta as Record<string, unknown>) ?? {}),
  };
}

/** Reads the per-request protocol version from `_meta` (body or params). */
export function declaredProtocolVersion(body: Record<string, unknown>): string | undefined {
  const v = requestMeta(body)[PROTOCOL_VERSION_KEY];
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

export async function handleModernRequest(
  body: unknown,
  ctx: BrainContext,
): Promise<JsonRpcResponse | undefined> {
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
          capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
          instructions:
            "File-first memory vault. Search with brain_search, open a note with brain_read, walk its links with brain_neighbors. " +
            "Writes, where allowed, ask the person to confirm and land in quarantine for agents. " +
            "brain_curate reads the whole vault at once: declare the tasks extension and it comes back as a task to poll.",
          ttlMs: LIST_TTL_MS,
          cacheScope: "private",
        }),
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: withMeta({
          tools: toolsFor(ctx).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchemaJson,
          })),
          ttlMs: LIST_TTL_MS,
          cacheScope: "private",
        }),
      };

    case "tasks/get": {
      const taskId = String(((b.params ?? {}) as Record<string, unknown>).taskId ?? "");
      const task = ctx.tasks.get(ctx.identity.name, taskId);
      // A task another identity created does not exist as far as this one is
      // told: the extension dropped `tasks/list` for the same reason.
      if (!task) return { jsonrpc: "2.0", id, error: { code: INVALID_PARAMS, message: `Task not found: ${taskId}` } };
      return { jsonrpc: "2.0", id, result: { ...task, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } };
    }

    case "tasks/cancel": {
      const taskId = String(((b.params ?? {}) as Record<string, unknown>).taskId ?? "");
      const task = ctx.tasks.cancel(ctx.identity.name, taskId);
      if (!task) return { jsonrpc: "2.0", id, error: { code: INVALID_PARAMS, message: `Task not found: ${taskId}` } };
      return { jsonrpc: "2.0", id, result: { _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } };
    }

    case "tasks/update": {
      const taskId = String(((b.params ?? {}) as Record<string, unknown>).taskId ?? "");
      const updated = ctx.tasks.update(ctx.identity.name, taskId);
      if (updated.ok) return { jsonrpc: "2.0", id, result: { _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } };
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: INVALID_PARAMS,
          message:
            updated.reason === "not-found"
              ? `Task not found: ${taskId}`
              : `Task ${taskId} is not waiting for input: this server's only question, confirming a write, is answered on the call itself`,
        },
      };
    }

    case "tools/call": {
      const params = (b.params ?? {}) as Record<string, unknown>;
      const name = String(params.name ?? "");
      const tool = findTool(name);
      if (!tool) {
        return { jsonrpc: "2.0", id, error: { code: INVALID_PARAMS, message: `Unknown tool: ${name}` } };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const caps = requestMeta(b)[CLIENT_CAPABILITIES_KEY];
      const call: CallContext = {
        inputResponses: (params.inputResponses ?? undefined) as CallContext["inputResponses"],
        requestState: typeof params.requestState === "string" ? params.requestState : undefined,
        clientCapabilities: caps && typeof caps === "object" ? (caps as Record<string, unknown>) : undefined,
      };

      // Work measured in the size of the vault, not of the query, goes back as
      // a handle when the client can hold one. A client that cannot simply
      // waits, exactly as before.
      if (tool.longRunning && clientDoesTasks(b)) {
        const task = ctx.tasks.create(
          ctx.identity.name,
          () => callTool(name, args, ctx, call),
          `${name} is reading ${ctx.notes.length} notes`,
        );
        return {
          jsonrpc: "2.0",
          id,
          result: { resultType: "task", ...task, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } },
        };
      }

      const out = await callTool(name, args, ctx, call);
      if (out.inputRequired) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "input_required",
            inputRequests: out.inputRequired.inputRequests,
            requestState: out.inputRequired.requestState,
            _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
          },
        };
      }
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
