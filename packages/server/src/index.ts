import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildGraph, loadVault, neighbors } from "@manent/core";
import { buildSearchIndex } from "./search.js";

export { buildSearchIndex } from "./search.js";

export async function createBrainServer(root: string): Promise<McpServer> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);
  const index = buildSearchIndex(notes);

  const server = new McpServer({ name: "manent", version: "0.0.1" });

  server.registerTool(
    "brain_search",
    {
      description:
        "Search notes in the brain vault (BM25 baseline). Returns top-k matches with name, description, path and score.",
      inputSchema: {
        query: z.string().describe("free-text query"),
        k: z.number().int().min(1).max(50).optional().describe("max results, default 8"),
      },
    },
    async ({ query, k }) => {
      const hits = index
        .search(query)
        .slice(0, k ?? 8)
        .map((h) => ({
          name: h.id as string,
          description: h.description as string,
          path: h.relPath as string,
          score: Math.round(h.score * 100) / 100,
        }));
      return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    "brain_read",
    {
      description: "Read a full note by canonical name (frontmatter name / filename slug).",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const note = graph.nodes.get(name);
      if (!note) {
        return {
          content: [{ type: "text", text: `Note not found: ${name}` }],
          isError: true,
        };
      }
      const fm = JSON.stringify(note.frontmatter, null, 2);
      return {
        content: [{ type: "text", text: `frontmatter:\n${fm}\n\nbody:\n${note.body}` }],
      };
    },
  );

  server.registerTool(
    "brain_neighbors",
    {
      description:
        "List note names connected to a note via wikilink/provenance/supersedes/contradicts edges, up to a given depth.",
      inputSchema: {
        name: z.string(),
        depth: z.number().int().min(1).max(3).optional().describe("hops, default 1"),
      },
    },
    async ({ name, depth }) => {
      const near = [...neighbors(graph, name, depth ?? 1)];
      return { content: [{ type: "text", text: JSON.stringify(near, null, 2) }] };
    },
  );

  return server;
}

export async function serveStdio(root: string): Promise<void> {
  const server = await createBrainServer(root);
  await server.connect(new StdioServerTransport());
}
