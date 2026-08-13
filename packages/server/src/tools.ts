import { readFile } from "node:fs/promises";
import { z, type ZodRawShape } from "zod";
import { neighbors, writeNote, WriteRefused } from "@manent/core";
import { NOTE_TYPES } from "@manent/spec";
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
  /** listed only on a writable server — a read-only vault should not advertise it */
  requiresWrite?: boolean;
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
  {
    name: "brain_list",
    description:
      "List every note in the vault as {name, type, description, relPath}. Optional type filter. This is the full index — use it to enumerate, not to search.",
    inputSchemaJson: {
      type: "object",
      properties: {
        type: { type: "string", description: "keep only notes with this frontmatter type" },
        limit: { type: "integer", minimum: 1, maximum: 5000, description: "max rows, default 500" },
      },
      additionalProperties: false,
    },
    inputSchemaZod: {
      type: z.string().optional().describe("keep only notes with this frontmatter type"),
      limit: z.number().int().min(1).max(5000).optional().describe("max rows, default 500"),
    },
    run(args, ctx) {
      const type = args.type != null ? String(args.type) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 500;
      const rows = ctx.notes
        .filter((n) => type == null || n.frontmatter.type === type)
        .slice(0, limit)
        .map((n) => ({
          name: n.frontmatter.name ?? n.relPath,
          type: n.frontmatter.type ?? null,
          description: n.frontmatter.description ?? null,
          relPath: n.relPath,
        }));
      return text(rows);
    },
  },
  {
    name: "brain_read_raw",
    description:
      "Read a note's exact file bytes from disk (frontmatter YAML + body verbatim), keyed by canonical name. Use when you need the literal markdown, not the parsed view brain_read gives.",
    inputSchemaJson: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    inputSchemaZod: { name: z.string() },
    async run(args, ctx) {
      const name = String(args.name ?? "");
      const note = ctx.graph.nodes.get(name);
      if (!note) return { content: [{ type: "text", text: `Note not found: ${name}` }], isError: true };
      try {
        return text(await readFile(note.path, "utf8"));
      } catch (err) {
        return {
          content: [{ type: "text", text: `Read failed for ${note.relPath}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  },
  {
    name: "brain_grep",
    description:
      "Regex search over note bodies. Returns {name, relPath, line, text} per match. Complements brain_search: exact/literal matching, not ranked relevance.",
    inputSchemaJson: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        flags: { type: "string", description: "regex flags, default 'i'" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "max matches, default 100" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      pattern: z.string().describe("JavaScript regular expression"),
      flags: z.string().optional().describe("regex flags, default 'i'"),
      limit: z.number().int().min(1).max(500).optional().describe("max matches, default 100"),
    },
    run(args, ctx) {
      const pattern = String(args.pattern ?? "");
      const flags = args.flags != null ? String(args.flags) : "i";
      const limit = typeof args.limit === "number" ? args.limit : 100;
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
      } catch (err) {
        return {
          content: [{ type: "text", text: `Bad regex: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      const hits: Array<{ name: string; relPath: string; line: number; text: string }> = [];
      for (const n of ctx.notes) {
        const lines = n.body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            hits.push({ name: n.frontmatter.name ?? n.relPath, relPath: n.relPath, line: i + 1, text: lines[i].trim() });
            if (hits.length >= limit) return text(hits);
          }
        }
      }
      return text(hits);
    },
  },
  {
    name: "brain_write",
    requiresWrite: true,
    description:
      "Create or replace a note. Requires name (slug), description (one line) and type. mode: 'create' (default, refuses to clobber) or 'overwrite'.",
    inputSchemaJson: {
      type: "object",
      properties: {
        name: { type: "string", description: "canonical slug; becomes <name>.md — not a path" },
        description: { type: "string", description: "one line: what this note is" },
        type: { type: "string", enum: [...NOTE_TYPES], description: "note type from the spec" },
        body: { type: "string", description: "markdown body, without frontmatter" },
        dir: { type: "string", description: "vault-relative folder, e.g. 'memory' or 'projects/aios'" },
        mode: { type: "string", enum: ["create", "overwrite"], description: "default 'create'" },
      },
      required: ["name", "description", "type", "body"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      name: z.string().describe("canonical slug; becomes <name>.md — not a path"),
      description: z.string().describe("one line: what this note is"),
      type: z.enum(NOTE_TYPES).describe("note type from the spec"),
      body: z.string().describe("markdown body, without frontmatter"),
      dir: z.string().optional().describe("vault-relative folder, e.g. 'memory'"),
      mode: z.enum(["create", "overwrite"]).optional().describe("default 'create'"),
    },
    run: (args, ctx) => runWrite(ctx, { ...args, mode: args.mode ?? "create" }),
  },
  {
    name: "brain_append",
    requiresWrite: true,
    description:
      "Append markdown to the body of an existing note, leaving its frontmatter intact.",
    inputSchemaJson: {
      type: "object",
      properties: {
        name: { type: "string", description: "canonical slug of the existing note" },
        body: { type: "string", description: "markdown to append" },
        dir: { type: "string", description: "vault-relative folder the note lives in" },
      },
      required: ["name", "body"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      name: z.string().describe("canonical slug of the existing note"),
      body: z.string().describe("markdown to append"),
      dir: z.string().optional().describe("vault-relative folder the note lives in"),
    },
    run: (args, ctx) => runWrite(ctx, { ...args, mode: "append" }),
  },
];

/**
 * Shared body of the write tools: the gate, the write, the re-index.
 *
 * A refused write returns `isError` with the reason rather than throwing — the
 * caller is a model, and a sentence it can act on beats a stack trace.
 */
async function runWrite(ctx: BrainContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.writable) {
    return {
      content: [
        {
          type: "text",
          text: "This brain is read-only: the server was not started with --writable. Writes are refused.",
        },
      ],
      isError: true,
    };
  }
  // An existing note carries its own folder; callers need not know it.
  const dir =
    args.dir != null
      ? String(args.dir)
      : (() => {
          const found = ctx.graph.nodes.get(String(args.name ?? ""));
          const at = found?.relPath.lastIndexOf("/") ?? -1;
          return found && at > 0 ? found.relPath.slice(0, at) : undefined;
        })();

  try {
    const res = await writeNote(ctx.root, {
      name: String(args.name ?? ""),
      dir,
      type: args.type != null ? String(args.type) : undefined,
      description: args.description != null ? String(args.description) : undefined,
      body: String(args.body ?? ""),
      mode: args.mode as "create" | "overwrite" | "append",
    });
    await ctx.applyWrite(res.note);
    return text({ ok: true, relPath: res.relPath, created: res.created, bytes: res.note.body.length });
  } catch (err) {
    if (err instanceof WriteRefused) return { content: [{ type: "text", text: err.message }], isError: true };
    return {
      content: [{ type: "text", text: `Write failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

export const findTool = (name: string): BrainTool | undefined => BRAIN_TOOLS.find((t) => t.name === name);

/**
 * The tools a given context should advertise.
 *
 * A read-only server hides the write tools instead of listing ones that can
 * only fail: the surface a client sees is the surface it actually has. Both
 * protocol adapters list through here so the two cannot disagree. `run` still
 * re-checks the gate — listing is presentation, not enforcement.
 */
export const toolsFor = (ctx: Pick<BrainContext, "writable">): BrainTool[] =>
  BRAIN_TOOLS.filter((t) => !t.requiresWrite || ctx.writable);
