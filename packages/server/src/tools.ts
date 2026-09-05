import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z, type ZodRawShape } from "zod";
import { neighbors, redactPii, scanInjection, scanPii, writeNote, WriteRefused, type WriteMode } from "@manent/core";
import { AUDIENCE_PRIVATE, NOTE_TYPES, SLUG_RE } from "@manent/spec";
import { communities, contradictions, duplicates } from "@manent/curate";
import type { BrainContext } from "./context.js";
import { scopeKey } from "./identity.js";

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
  /**
   * The tool cannot finish without the person's answer (MCP 2026-07-28
   * multi round-trip request, `resultType: "input_required"`). The modern
   * adapter puts this on the wire; the legacy one never sees it, because a
   * tool only asks when the call context says the client can answer.
   */
  inputRequired?: { inputRequests: Record<string, unknown>; requestState: string };
  /** what the audit line should carry beyond the tool name and arguments */
  audit?: Record<string, unknown>;
  /** the SDK's result type is open-ended; this keeps the shape assignable */
  [key: string]: unknown;
}

/** What the transport knows about this call that the arguments do not say. */
export interface CallContext {
  /** answers to a previous `inputRequired`, keyed like the requests */
  inputResponses?: Record<string, { action?: string; content?: Record<string, unknown> }>;
  /** echoed from the previous `inputRequired` */
  requestState?: string;
  /** `io.modelcontextprotocol/clientCapabilities` of the request */
  clientCapabilities?: Record<string, unknown>;
}

export interface BrainTool {
  name: string;
  description: string;
  /** listed only on a writable server — a read-only vault should not advertise it */
  requiresWrite?: boolean;
  /**
   * The work grows with the whole vault rather than with the query, so on the
   * modern path a client that speaks the tasks extension gets a task handle
   * instead of a held-open connection. Everywhere else it runs inline.
   */
  longRunning?: boolean;
  /** JSON Schema 2020-12 — the modern path serves this verbatim */
  inputSchemaJson: Record<string, unknown>;
  /** same contract expressed for the SDK's Zod-based registration */
  inputSchemaZod: ZodRawShape;
  run(args: Record<string, unknown>, ctx: BrainContext, call?: CallContext): ToolResult | Promise<ToolResult>;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const refuse = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** A read of a name that a recent search by the same agent returned: that search helped. */
function noteFollowed(ctx: BrainContext, name: string): void {
  const searchId = ctx.follow.noteRead(ctx.identity.name, name);
  if (searchId && ctx.gaps) {
    try {
      ctx.gaps.markFollowed(searchId);
    } catch (err) {
      console.error(`[manent] gap register update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const BRAIN_TOOLS: BrainTool[] = [
  {
    name: "brain_search",
    description:
      "Search notes in the brain vault. Returns {searchId, query, hits}: top-k matches with name, description, path and score. Open a hit with brain_read.",
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
      const hits = await ctx.retriever.search(query, k);
      // The register sees every search; a read that follows marks it useful.
      // A register failure must not cost the caller its answer.
      let searchId: string | undefined;
      if (ctx.gaps) {
        try {
          const rec = await ctx.gaps.recordSearch({ query, agent: ctx.identity.name, corpus: scopeKey(ctx.identity), hits });
          searchId = rec.searchId;
          ctx.follow.recordSearch(ctx.identity.name, searchId, hits.map((h) => h.name));
        } catch (err) {
          console.error(`[manent] gap register write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ...text(searchId ? { searchId, query, hits } : { query, hits }), audit: { results: hits.map((h) => h.name), searchId } };
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
      if (!note) return refuse(`Note not found: ${name}`);
      noteFollowed(ctx, name);
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
      if (!note) return refuse(`Note not found: ${name}`);
      noteFollowed(ctx, name);
      try {
        return text(await readFile(note.path, "utf8"));
      } catch (err) {
        return refuse(`Read failed for ${note.relPath}: ${err instanceof Error ? err.message : String(err)}`);
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
        return refuse(`Bad regex: ${err instanceof Error ? err.message : String(err)}`);
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
    name: "brain_feedback",
    description:
      "Report how the brain served you: a note that was wrong, outdated or incomplete, or a search that helped. The gap register sees only what was missing — a confident wrong answer looks like a success to it — so this is the one way 'there, but wrong' gets recorded. Pass the searchId from brain_search and/or the note's name.",
    inputSchemaJson: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["wrong", "outdated", "incomplete", "helpful"], description: "what was wrong with the answer, or that it helped" },
        note: { type: "string", description: "canonical name of the note the verdict is about" },
        searchId: { type: "string", description: "the searchId of the brain_search this refers to" },
        outcome: { type: "string", enum: ["resolved", "escalated", "unanswered"], description: "how the question ended, if known" },
        comment: { type: "string", maxLength: 500, description: "one line: what was wrong, or what was missing (no personal data)" },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      verdict: z.enum(["wrong", "outdated", "incomplete", "helpful"]).describe("what was wrong with the answer, or that it helped"),
      note: z.string().optional().describe("canonical name of the note the verdict is about"),
      searchId: z.string().optional().describe("the searchId of the brain_search this refers to"),
      outcome: z.enum(["resolved", "escalated", "unanswered"]).optional().describe("how the question ended, if known"),
      comment: z.string().max(500).optional().describe("one line: what was wrong, or what was missing (no personal data)"),
    },
    run(args, ctx) {
      if (!ctx.gaps) return refuse("This server keeps no register (start it with --gaps), so feedback has nowhere to go.");
      const verdict = String(args.verdict ?? "");
      if (!["wrong", "outdated", "incomplete", "helpful"].includes(verdict)) return refuse("verdict must be wrong, outdated, incomplete or helpful");
      const note = args.note != null ? String(args.note) : undefined;
      // A verdict about a note the caller cannot see is either a mistake or a probe.
      if (note && !ctx.graph.nodes.has(note)) return refuse(`Note not found: ${note}`);
      const searchId = args.searchId != null ? String(args.searchId) : undefined;
      const outcome = args.outcome != null ? String(args.outcome) : undefined;
      try {
        if (searchId && outcome) ctx.gaps.setOutcome(searchId, outcome);
        const row = ctx.gaps.addFeedback({
          agent: ctx.identity.name,
          searchId,
          note,
          verdict: verdict as "wrong" | "outdated" | "incomplete" | "helpful",
          comment: args.comment != null ? String(args.comment) : undefined,
        });
        return { ...text({ ok: true, id: row.id, gapId: row.gapId }), audit: { verdict, note, gapId: row.gapId } };
      } catch (err) {
        return refuse(`Feedback not recorded: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "brain_write",
    requiresWrite: true,
    description:
      "Create or replace a note. Requires name (slug), description (one line) and type. mode: 'create' (default, refuses to clobber) or 'overwrite'. Text with personal data or model-directed instructions is refused. An agent's note lands in its own quarantine directory, private, until a person promotes it.",
    inputSchemaJson: {
      type: "object",
      properties: {
        name: { type: "string", description: "canonical slug; becomes <name>.md — not a path" },
        description: { type: "string", description: "one line: what this note is" },
        type: { type: "string", enum: [...NOTE_TYPES], description: "note type from the spec" },
        body: { type: "string", description: "markdown body, without frontmatter" },
        dir: { type: "string", description: "vault-relative folder, e.g. 'memory' or 'projects/aios' (owner only; agents write where they were granted)" },
        mode: { type: "string", enum: ["create", "overwrite"], description: "default 'create'" },
        audience: { type: "array", items: { type: "string" }, description: "who may read it (owner only); default private" },
      },
      required: ["name", "description", "type", "body"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      name: z.string().describe("canonical slug; becomes <name>.md — not a path"),
      description: z.string().describe("one line: what this note is"),
      type: z.enum(NOTE_TYPES).describe("note type from the spec"),
      body: z.string().describe("markdown body, without frontmatter"),
      dir: z.string().optional().describe("vault-relative folder, e.g. 'memory' (owner only)"),
      mode: z.enum(["create", "overwrite"]).optional().describe("default 'create'"),
      audience: z.array(z.string()).optional().describe("who may read it (owner only); default private"),
    },
    run: (args, ctx, call) => runWrite(ctx, { ...args, mode: args.mode ?? "create" }, call),
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
        dir: { type: "string", description: "vault-relative folder the note lives in (owner only)" },
      },
      required: ["name", "body"],
      additionalProperties: false,
    },
    inputSchemaZod: {
      name: z.string().describe("canonical slug of the existing note"),
      body: z.string().describe("markdown to append"),
      dir: z.string().optional().describe("vault-relative folder the note lives in (owner only)"),
    },
    run: (args, ctx, call) => runWrite(ctx, { ...args, mode: "append" }, call),
  },
  {
    name: "brain_curate",
    longRunning: true,
    description:
      "What the vault has accumulated: near-duplicate notes, declared contradictions, and the link communities that have no map of content. Reports only — nothing is merged, resolved or written. Comparison is lexical here; the dense comparison lives in the `manent curate --dense` CLI, where building the index is an explicit step.",
    inputSchemaJson: {
      type: "object",
      properties: {
        reports: {
          type: "array",
          items: { enum: ["duplicates", "contradictions", "communities"] },
          description: "which reports to run; all three by default",
        },
        threshold: { type: "number", minimum: 0, maximum: 1, description: "similarity at or above which two notes are a pair (default 0.25)" },
        minSize: { type: "integer", minimum: 2, description: "smallest group the community report calls a subject (default 4)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "max duplicate pairs to return" },
      },
      additionalProperties: false,
    },
    inputSchemaZod: {
      reports: z.array(z.enum(["duplicates", "contradictions", "communities"])).optional().describe("which reports to run; all three by default"),
      threshold: z.number().min(0).max(1).optional(),
      minSize: z.number().int().min(2).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    run(args, ctx) {
      const asked = Array.isArray(args.reports) ? args.reports.map(String) : ["duplicates", "contradictions", "communities"];
      const wants = (r: string) => asked.includes(r);
      const out: Record<string, unknown> = { notes: ctx.notes.length };
      // The caller's own view: an agent curates what it may read, and a pair
      // it cannot see is not a pair it is told about.
      if (wants("duplicates")) {
        out.duplicates = duplicates(ctx.notes, {
          threshold: typeof args.threshold === "number" ? args.threshold : undefined,
          limit: typeof args.limit === "number" ? args.limit : 50,
        });
      }
      if (wants("contradictions")) out.contradictions = contradictions(ctx.notes);
      if (wants("communities")) {
        out.communities = communities(ctx.notes, {
          minSize: typeof args.minSize === "number" ? args.minSize : undefined,
        });
      }
      return text(out);
    },
  },
];

const CONFIRM_KEY = "confirm-write";
const fingerprint = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("base64url").slice(0, 32);

/**
 * Shared body of the write tools: the gate, the identity rules, the approval,
 * the write, the re-index.
 *
 * A refused write returns `isError` with the reason rather than throwing — the
 * caller is a model, and a sentence it can act on beats a stack trace.
 */
async function runWrite(ctx: BrainContext, args: Record<string, unknown>, call?: CallContext): Promise<ToolResult> {
  if (!ctx.writable) {
    return refuse("This brain is read-only: the server was not started with --writable. Writes are refused.");
  }
  const id = ctx.identity;
  const name = String(args.name ?? "");
  const mode = args.mode as WriteMode;
  const body = String(args.body ?? "");
  const description = args.description != null ? String(args.description) : undefined;
  const type = args.type != null ? String(args.type) : undefined;

  // ── Who may write where, and what the note is stamped with ────────────────
  let dir: string | undefined;
  const stamp: Record<string, unknown> = { author: id.name };
  if (id.owner) {
    // An existing note carries its own folder; callers need not know it.
    dir = args.dir != null ? String(args.dir) : existingDir(ctx, name);
    if (args.audience !== undefined) {
      const labels = (Array.isArray(args.audience) ? args.audience : [args.audience]).map((a) => String(a).trim().toLowerCase());
      const bad = labels.find((l) => !SLUG_RE.test(l));
      if (bad !== undefined) return refuse(`Illegal audience label "${bad}": use slugs`);
      stamp.audience = labels;
    }
  } else {
    if (!id.writeDir) return refuse(`${id.name} is read-only: no write directory was granted to this identity.`);
    // Nobody but the owner chooses the folder, the status or the audience: an
    // agent's note is a proposal, kept apart and private until a person
    // promotes it — whatever the call asked for.
    dir = id.writeDir;
    stamp.status = "quarantine";
    stamp.audience = [AUDIENCE_PRIVATE];
  }

  // ── The gate: nothing personal, nothing that reads as an instruction ──────
  const scanned = `${description ?? ""}\n${body}`;
  const injection = scanInjection(scanned);
  if (injection.length > 0) {
    return refuse(
      `Refused: the text reads as an instruction aimed at a model (${injection.map((f) => `${f.kind} at line ${f.line}`).join(", ")}). Notes hold knowledge, not directives.`,
    );
  }
  const pii = scanPii(scanned);
  if (pii.length > 0) {
    return refuse(
      `Refused: the text carries personal data (${pii.map((f) => `${f.count} ${f.kind}`).join(", ")}). A vault lives in git and git history is forever — remove it and retry.`,
    );
  }

  // ── The person confirms, when the client can ask them ─────────────────────
  // MCP 2026-07-28: the tool answers `input_required` with a form; the client
  // retries the same call carrying the answer. Stateless on this side — the
  // request state is a fingerprint of what was proposed, so an altered retry
  // is asked again rather than trusted.
  const elicitation = call?.clientCapabilities?.elicitation;
  if (elicitation && typeof elicitation === "object") {
    const state = fingerprint({ name, dir, mode, type, description, body, agent: id.name });
    const answer = call?.inputResponses?.[CONFIRM_KEY];
    if (!answer || call?.requestState !== state) {
      const where = dir ? `${dir}/${name}.md` : `${name}.md`;
      const preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;
      return {
        content: [{ type: "text", text: `Waiting for the person to confirm the ${mode} of ${where}.` }],
        inputRequired: {
          inputRequests: {
            [CONFIRM_KEY]: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message:
                  `${id.name} wants to ${mode} the note ${where}${type ? ` (${type})` : ""}${stamp.status ? " — it will land in quarantine, private, until you promote it" : ""}.\n\n` +
                  `${description ?? ""}\n\n${preview}`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    confirm: { type: "boolean", title: "Write this note?", description: "Nothing is written unless you confirm.", default: false },
                  },
                  required: ["confirm"],
                },
              },
            },
          },
          requestState: state,
        },
        audit: { pending: "confirmation" },
      };
    }
    if (answer.action !== "accept" || answer.content?.confirm !== true) {
      return { ...text(`Write not confirmed (${answer.action ?? "no answer"}): nothing was written.`), audit: { declined: true } };
    }
  }

  try {
    const res = await writeNote(ctx.root, { name, dir, type, description, body, mode, frontmatter: stamp });
    await ctx.applyWrite(res.note);
    return {
      ...text({ ok: true, relPath: res.relPath, created: res.created, bytes: res.note.body.length, ...(stamp.status ? { status: stamp.status } : {}) }),
      audit: { relPath: res.relPath, created: res.created },
    };
  } catch (err) {
    if (err instanceof WriteRefused) return refuse(err.message);
    return refuse(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function existingDir(ctx: BrainContext, name: string): string | undefined {
  const found = ctx.graph.nodes.get(name);
  const at = found?.relPath.lastIndexOf("/") ?? -1;
  return found && at > 0 ? found.relPath.slice(0, at) : undefined;
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

const AUDITED_ARGS = ["query", "name", "pattern", "type", "dir", "mode", "verdict", "searchId", "note"] as const;

/**
 * Every tool call, from either era, goes through here: one place for the
 * audit line and for turning an exception into an answer the model can read.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BrainContext,
  call?: CallContext,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return refuse(`Unknown tool: ${name}`);
  const started = Date.now();
  let out: ToolResult;
  try {
    out = await tool.run(args, ctx, call);
  } catch (err) {
    out = refuse(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctx.audit) {
    const shown: Record<string, unknown> = {};
    for (const k of AUDITED_ARGS) {
      if (typeof args[k] !== "string") continue;
      // Free text is redacted before it is written anywhere, the audit included.
      shown[k] = k === "query" || k === "pattern" ? redactPii(String(args[k])).text.slice(0, 200) : args[k];
    }
    ctx.audit.log({
      ts: new Date(started).toISOString(),
      agent: ctx.identity.name,
      tool: name,
      ok: !out.isError,
      ms: Date.now() - started,
      ...shown,
      ...(out.audit ?? {}),
    });
  }
  return out;
}
