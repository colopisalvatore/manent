import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrainContext } from "./context.js";
import { loadBrainContext, type RetrieverName } from "./context.js";
import { toolsFor } from "./tools.js";

/**
 * Legacy era: the handshake-based revisions (2025-11-25 and earlier), served by
 * the official SDK. This is what every shipping client speaks today, including
 * Claude Code over stdio and claude.ai over HTTP.
 */

export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export function buildLegacyServer(ctx: BrainContext): McpServer {
  const server = new McpServer({ name: "manent", version: "0.0.1" });
  for (const tool of toolsFor(ctx)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchemaZod },
      async (args: Record<string, unknown>) => await tool.run(args, ctx),
    );
  }
  return server;
}

/** One stateless transport per request: the vault view is read-only and shared. */
export async function serveLegacyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  ctx: BrainContext,
): Promise<void> {
  const server = buildLegacyServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function createBrainServer(
  root: string,
  retriever?: RetrieverName,
  model?: string,
  writable?: boolean,
): Promise<McpServer> {
  return buildLegacyServer(await loadBrainContext(root, { retriever, model, writable }));
}

export async function serveStdio(
  root: string,
  retriever?: RetrieverName,
  model?: string,
  writable?: boolean,
): Promise<void> {
  const server = await createBrainServer(root, retriever, model, writable);
  await server.connect(new StdioServerTransport());
}
