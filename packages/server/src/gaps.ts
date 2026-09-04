import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactPii } from "@manent/core";
import { cosine, STOPWORDS, type Hit } from "@manent/retrieval";

/**
 * The gap register: what the brain was asked and could not answer.
 *
 * To learn from the people asking, the vault does not need their text — it
 * needs to know which questions went unanswered. One row per question group,
 * not a transcript. That makes the register actionable (a work list, by
 * frequency), small, and free of personal data by construction: the query is
 * redacted before it is stored and the caller is an *agent*, never a person.
 *
 * Two signals carry the weight:
 *   - `followed`: a search that no `brain_read` follows is a search that did
 *     not help. The server sees that on its own, no cooperation needed.
 *   - `count`: grouped by meaning, not by string. Exact-string dedup turns 500
 *     rows into 30 unreadable near-duplicates; grouping by embedding — the
 *     same local model the ranker uses — collapses paraphrases.
 *
 * The register is a queue, not a memory. Its job is to be emptied: a gap
 * closed with a note becomes an `oblique` golden-set entry, which is the
 * hardest kind to write by hand and the one the eval is weakest on.
 *
 * It lives OUTSIDE the vault: a gap is not a fact, and unlike the embedding
 * cache it is observed rather than derived — losing it loses weeks of real
 * questions. Different durability class, own file, own backup.
 */

export interface GapRow {
  id: string;
  query: string;
  count: number;
  followed: number;
  topScore: number | null;
  firstSeen: string;
  lastSeen: string;
  status: "open" | "closed" | "dismissed";
  note: string | null;
  closedAt: string | null;
  /** distinct agents that hit this gap */
  agents: string[];
  /** feedback rows attached to this gap (brain_feedback) */
  feedback: number;
}

export interface SearchRow {
  id: string;
  gapId: string;
  ts: string;
  agent: string;
  corpus: string | null;
  topScore: number | null;
  topNames: string[];
  followed: boolean;
  outcome: string | null;
}

export type FeedbackVerdict = "wrong" | "outdated" | "incomplete" | "helpful";

export interface FeedbackRow {
  id: string;
  ts: string;
  agent: string;
  searchId: string | null;
  gapId: string | null;
  note: string | null;
  verdict: FeedbackVerdict;
  comment: string | null;
}

export interface GapStoreOptions {
  /** sqlite file; created on first open */
  path: string;
  /**
   * Query embedder, when a dense model is loaded. Without it, grouping falls
   * back to a normalized-token key: exact paraphrases only.
   */
  embed?: (text: string) => Promise<Float32Array>;
  /** cosine similarity above which two queries are the same gap */
  threshold?: number;
}

/**
 * Measured on multilingual-e5-small with Italian restaurant and ops questions
 * (query-prefixed, both sides): five paraphrase pairs scored 0.908–0.943,
 * four unrelated pairs 0.752–0.835, and "same topic, different question"
 * ("orari di apertura" vs "siete aperti a pranzo?") 0.865. The gap between
 * 0.835 and 0.908 is where the threshold sits. Tune with `--gaps-threshold`
 * and check that the register reads as one row per question.
 */
export const DEFAULT_GAP_THRESHOLD = 0.9;

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const hashOf = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 12);

/** Lowercased content words, sorted: the same question in a different order is the same key. */
export function normalizeQuery(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/\[[a-z-]+\]/g, " ") // redaction placeholders carry no meaning
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].sort().join(" ");
}

const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const decode = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

type Db = import("node:sqlite").DatabaseSync;

interface Centroid {
  id: string;
  vec: Float32Array;
  count: number;
}

export class GapStore {
  private readonly centroids = new Map<string, Centroid>();

  private constructor(
    private readonly db: Db,
    readonly path: string,
    private embed: GapStoreOptions["embed"],
    private readonly threshold: number,
  ) {}

  static async open(opts: GapStoreOptions): Promise<GapStore> {
    await mkdir(dirname(opts.path), { recursive: true });
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(opts.path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gaps (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        key TEXT NOT NULL,
        centroid BLOB,
        count INTEGER NOT NULL DEFAULT 0,
        followed INTEGER NOT NULL DEFAULT 0,
        top_score REAL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        note TEXT,
        closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS gaps_key ON gaps(key);
      CREATE TABLE IF NOT EXISTS searches (
        id TEXT PRIMARY KEY,
        gap_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        agent TEXT NOT NULL,
        corpus TEXT,
        top_score REAL,
        top_names TEXT NOT NULL,
        followed INTEGER NOT NULL DEFAULT 0,
        outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS searches_gap ON searches(gap_id);
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        agent TEXT NOT NULL,
        search_id TEXT,
        gap_id TEXT,
        note TEXT,
        verdict TEXT NOT NULL,
        comment TEXT
      );
    `);
    const store = new GapStore(db, opts.path, opts.embed, opts.threshold ?? DEFAULT_GAP_THRESHOLD);
    store.loadCentroids();
    return store;
  }

  /** Grouping may start lexical and gain the model later, once the ranker has warmed up. */
  setEmbedder(embed: GapStoreOptions["embed"]): void {
    this.embed = embed;
  }

  private loadCentroids(): void {
    const rows = this.db.prepare("SELECT id, centroid, count FROM gaps WHERE centroid IS NOT NULL AND status = 'open'").all() as Array<{
      id: string;
      centroid: Uint8Array;
      count: number;
    }>;
    for (const r of rows) this.centroids.set(r.id, { id: r.id, vec: decode(r.centroid), count: r.count });
  }

  /**
   * Records one search and returns its id and the gap it was grouped into.
   * The query is redacted first; the raw text never reaches the file.
   */
  async recordSearch(input: { query: string; agent: string; corpus?: string; hits: Hit[] }): Promise<{ searchId: string; gapId: string }> {
    const query = redactPii(input.query.replace(/\s+/g, " ").trim()).text;
    const key = normalizeQuery(query);
    const ts = now();
    const topScore = input.hits[0]?.score ?? null;
    const topNames = input.hits.slice(0, 10).map((h) => h.name);

    let gapId = this.findByKey(key);
    let vec: Float32Array | undefined;
    if (this.embed) {
      try {
        vec = await this.embed(query);
      } catch {
        vec = undefined; // model hiccup: fall back to the key for this one
      }
    }
    if (!gapId && vec) gapId = this.findByVector(vec);

    if (gapId) {
      this.db
        .prepare("UPDATE gaps SET count = count + 1, last_seen = ?, top_score = MAX(COALESCE(top_score, 0), COALESCE(?, 0)) WHERE id = ?")
        .run(ts, topScore, gapId);
      if (vec) this.foldCentroid(gapId, vec);
    } else {
      gapId = `g_${hashOf(key || query)}`;
      // A hash of the key is stable across restarts; a closed gap re-asked reopens under a fresh id.
      if (this.exists(gapId)) gapId = `g_${hashOf(key + ts)}`;
      this.db
        .prepare("INSERT INTO gaps (id, query, key, centroid, count, followed, top_score, first_seen, last_seen, status) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, 'open')")
        .run(gapId, query, key, vec ? encode(vec) : null, topScore, ts, ts);
      if (vec) this.centroids.set(gapId, { id: gapId, vec, count: 1 });
    }

    const searchId = newId("s");
    this.db
      .prepare("INSERT INTO searches (id, gap_id, ts, agent, corpus, top_score, top_names, followed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run(searchId, gapId, ts, input.agent, input.corpus ?? null, topScore, JSON.stringify(topNames));
    return { searchId, gapId };
  }

  /** The caller opened one of the results: this search was useful. Idempotent. */
  markFollowed(searchId: string): boolean {
    const row = this.db.prepare("SELECT gap_id, followed FROM searches WHERE id = ?").get(searchId) as { gap_id: string; followed: number } | undefined;
    if (!row || row.followed) return false;
    this.db.prepare("UPDATE searches SET followed = 1 WHERE id = ?").run(searchId);
    this.db.prepare("UPDATE gaps SET followed = followed + 1 WHERE id = ?").run(row.gap_id);
    return true;
  }

  /** Optional outcome reported by the agent for a search: resolved | escalated | unanswered. */
  setOutcome(searchId: string, outcome: string): boolean {
    const r = this.db.prepare("UPDATE searches SET outcome = ? WHERE id = ?").run(outcome, searchId);
    return Number(r.changes) > 0;
  }

  listGaps(opts: { status?: GapRow["status"] | "all"; limit?: number } = {}): GapRow[] {
    const status = opts.status ?? "open";
    const where = status === "all" ? "" : "WHERE g.status = ?";
    const rows = this.db
      .prepare(
        `SELECT g.*,
                (SELECT GROUP_CONCAT(DISTINCT s.agent) FROM searches s WHERE s.gap_id = g.id) AS agents,
                (SELECT COUNT(*) FROM feedback f WHERE f.gap_id = g.id) AS feedback
         FROM gaps g ${where}
         ORDER BY (g.count - g.followed) DESC, g.count DESC, COALESCE(g.top_score, 0) ASC, g.last_seen DESC
         LIMIT ?`,
      )
      .all(...(status === "all" ? [] : [status]), opts.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map(toGapRow);
  }

  getGap(id: string): GapRow | undefined {
    const row = this.db
      .prepare(
        `SELECT g.*,
                (SELECT GROUP_CONCAT(DISTINCT s.agent) FROM searches s WHERE s.gap_id = g.id) AS agents,
                (SELECT COUNT(*) FROM feedback f WHERE f.gap_id = g.id) AS feedback
         FROM gaps g WHERE g.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? toGapRow(row) : undefined;
  }

  listSearches(gapId: string): SearchRow[] {
    const rows = this.db.prepare("SELECT * FROM searches WHERE gap_id = ? ORDER BY ts DESC").all(gapId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      gapId: String(r.gap_id),
      ts: String(r.ts),
      agent: String(r.agent),
      corpus: (r.corpus as string | null) ?? null,
      topScore: (r.top_score as number | null) ?? null,
      topNames: JSON.parse(String(r.top_names)) as string[],
      followed: Number(r.followed) === 1,
      outcome: (r.outcome as string | null) ?? null,
    }));
  }

  /**
   * Closes a gap with the note that answers it, and returns the golden-set
   * entry that pair makes: the question as the asker phrased it, the note the
   * curator wrote — an `oblique` query by construction.
   */
  closeGap(id: string, note: string): { gap: GapRow; golden: { query: string; expected: string[]; source: "oblique"; note: string } } {
    const gap = this.getGap(id);
    if (!gap) throw new Error(`gap not found: ${id}`);
    const ts = now();
    this.db.prepare("UPDATE gaps SET status = 'closed', note = ?, closed_at = ? WHERE id = ?").run(note, ts, id);
    this.centroids.delete(id);
    const closed = this.getGap(id)!;
    return {
      gap: closed,
      golden: { query: gap.query, expected: [note], source: "oblique", note: `gap ${id}, asked ${gap.count}× by ${gap.agents.join(", ") || "-"}, closed ${ts.slice(0, 10)}` },
    };
  }

  dismissGap(id: string): GapRow {
    const gap = this.getGap(id);
    if (!gap) throw new Error(`gap not found: ${id}`);
    this.db.prepare("UPDATE gaps SET status = 'dismissed', closed_at = ? WHERE id = ?").run(now(), id);
    this.centroids.delete(id);
    return this.getGap(id)!;
  }

  addFeedback(input: { agent: string; searchId?: string; gapId?: string; note?: string; verdict: FeedbackVerdict; comment?: string }): FeedbackRow {
    const id = newId("f");
    const ts = now();
    // A search id resolves its gap, so the register can show feedback next to the question.
    let gapId = input.gapId ?? null;
    if (!gapId && input.searchId) {
      const s = this.db.prepare("SELECT gap_id FROM searches WHERE id = ?").get(input.searchId) as { gap_id: string } | undefined;
      gapId = s?.gap_id ?? null;
    }
    const comment = input.comment ? redactPii(input.comment).text.slice(0, 500) : null;
    this.db
      .prepare("INSERT INTO feedback (id, ts, agent, search_id, gap_id, note, verdict, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ts, input.agent, input.searchId ?? null, gapId, input.note ?? null, input.verdict, comment);
    return { id, ts, agent: input.agent, searchId: input.searchId ?? null, gapId, note: input.note ?? null, verdict: input.verdict, comment };
  }

  listFeedback(opts: { limit?: number } = {}): FeedbackRow[] {
    const rows = this.db.prepare("SELECT * FROM feedback ORDER BY ts DESC LIMIT ?").all(opts.limit ?? 100) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      ts: String(r.ts),
      agent: String(r.agent),
      searchId: (r.search_id as string | null) ?? null,
      gapId: (r.gap_id as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      verdict: r.verdict as FeedbackVerdict,
      comment: (r.comment as string | null) ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }

  private exists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM gaps WHERE id = ?").get(id);
  }

  private findByKey(key: string): string | undefined {
    if (!key) return undefined;
    const row = this.db.prepare("SELECT id FROM gaps WHERE key = ? AND status = 'open' ORDER BY last_seen DESC LIMIT 1").get(key) as { id: string } | undefined;
    return row?.id;
  }

  private findByVector(vec: Float32Array): string | undefined {
    let best: { id: string; sim: number } | undefined;
    for (const c of this.centroids.values()) {
      if (c.vec.length !== vec.length) continue;
      const sim = cosine(vec, c.vec);
      if (sim >= this.threshold && (!best || sim > best.sim)) best = { id: c.id, sim };
    }
    return best?.id;
  }

  /** Running mean of the group's queries, renormalized so cosine stays a dot product. */
  private foldCentroid(id: string, vec: Float32Array): void {
    const c = this.centroids.get(id);
    let next: Float32Array;
    let count: number;
    if (!c || c.vec.length !== vec.length) {
      next = vec;
      count = 1;
    } else {
      next = new Float32Array(vec.length);
      for (let i = 0; i < vec.length; i++) next[i] = c.vec[i] * c.count + vec[i];
      let norm = 0;
      for (let i = 0; i < next.length; i++) norm += next[i] * next[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < next.length; i++) next[i] /= norm;
      count = c.count + 1;
    }
    this.centroids.set(id, { id, vec: next, count });
    this.db.prepare("UPDATE gaps SET centroid = ? WHERE id = ?").run(encode(next), id);
  }
}

function toGapRow(r: Record<string, unknown>): GapRow {
  return {
    id: String(r.id),
    query: String(r.query),
    count: Number(r.count),
    followed: Number(r.followed),
    topScore: (r.top_score as number | null) ?? null,
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    status: r.status as GapRow["status"],
    note: (r.note as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    agents: r.agents ? String(r.agents).split(",") : [],
    feedback: Number(r.feedback ?? 0),
  };
}

/**
 * `node:sqlite` ships with Node ≥ 22.5 and still announces itself as
 * experimental on stderr. That one line is swallowed here — an MCP server on
 * stdio must keep stderr for things the operator needs to read — and the
 * import is dynamic so a vault served on an older Node loses only the gap
 * register, not the whole server.
 */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : (warning as { message?: string })?.message ?? "";
    if (/sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } catch {
    throw new Error("the gap register needs node:sqlite (Node ≥ 22.5); run on a newer Node or serve without --gaps");
  }
}

/**
 * In-memory link between a search and the reads that follow it.
 *
 * The protocol is stateless since 2026-07-28: there is no session in which
 * "the same caller later read a result" could be expressed. So the server
 * keeps its own short memory: the last searches per agent, and a read whose
 * name appears in one of them within the window counts as following it.
 * Heuristic, but honest — and it needs nothing from the client.
 */
export class FollowTracker {
  private readonly recent = new Map<string, Array<{ searchId: string; names: Set<string>; ts: number }>>();

  constructor(
    private readonly windowMs = 10 * 60_000,
    private readonly perAgent = 50,
  ) {}

  recordSearch(agent: string, searchId: string, names: string[]): void {
    const list = this.recent.get(agent) ?? [];
    list.push({ searchId, names: new Set(names), ts: Date.now() });
    while (list.length > this.perAgent) list.shift();
    this.recent.set(agent, list);
  }

  /** The most recent search by this agent whose results include `name`, if any; consumed once. */
  noteRead(agent: string, name: string): string | undefined {
    const list = this.recent.get(agent);
    if (!list) return undefined;
    const cutoff = Date.now() - this.windowMs;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].ts < cutoff) break;
      if (list[i].names.has(name)) {
        const [hit] = list.splice(i, 1);
        return hit.searchId;
      }
    }
    return undefined;
  }
}
