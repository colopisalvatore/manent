import { z, type ZodRawShape } from "zod";
import { neighbors } from "@manent/core";
import type { BrainContext } from "./context.js";

/**
 * The brain tools, defined once and independently of any protocol era.
 *
 * Each tool carries both schema forms on purpose: the legacy adapter feeds the
 * official SDK, which wants Zod, while the modern adapter serves JSON Schema
 * straight over the wire. Keeping both here means the two protocol paths can
 * never drift in what they expose.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** the SDK's result type is open-ended; this keeps the shape assignable */
  [key: string]: unknown;
}

export interface BrainTool {
  name: string;
  description: string;
  /** JSON Schema 2020-12 — the modern path serves this verbatim */
  inputSchemaJson: Record<string, unknown>;
  /** same contract expressed for the SDK's Zod-based registration */
  inputSchemaZod: ZodRawShape;
  run(args: Record<string, unknown>, ctx: BrainContext): ToolResult | Promise<ToolResult>;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const BRAIN_TOOLS: BrainTool[] = [
  {
    name: "brain_search",
    description:
      "Search notes in the brain vault (BM25 baseline). Returns top-k matches with name, description, path and score.",
    inputSchemaJson: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text query" },
        k: { type: "integer", minimum: 1, maximum: 50, description: "max results, default 8" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      query: z.string().describe("free-text query"),
      k: z.number().int().min(1).max(50).optional().describe("max results, default 8"),
    },
    async run(args, ctx) {
      const query = String(args.query ?? "");
      const k = typeof args.k === "number" ? args.k : 8;
      return text(await ctx.retriever.search(query, k));
    },
  },
  {
    name: "brain_read",
    description: "Read a full note by canonical name (frontmatter name / filename slug).",
    inputSchemaJson: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    inputSchemaZod: { name: z.string() },
    run(args, ctx) {
      const name = String(args.name ?? "");
      const note = ctx.graph.nodes.get(name);
      if (!note) return { content: [{ type: "text", text: `Note not found: ${name}` }], isError: true };
      return text(`frontmatter:\n${JSON.stringify(note.frontmatter, null, 2)}\n\nbody:\n${note.body}`);
    },
  },
  {
    name: "brain_neighbors",
    description:
      "List note names connected to a note via wikilink/provenance/supersedes/contradicts edges, up to a given depth.",
    inputSchemaJson: {
      type: "object",
      properties: {
        name: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 3, description: "hops, default 1" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      name: z.string(),
      depth: z.number().int().min(1).max(3).optional().describe("hops, default 1"),
    },
    run(args, ctx) {
      const name = String(args.name ?? "");
      const depth = typeof args.depth === "number" ? args.depth : 1;
      return text([...neighbors(ctx.graph, name, depth)]);
    },
  },
];

export const findTool = (name: string): BrainTool | undefined => BRAIN_TOOLS.find((t) => t.name === name);
