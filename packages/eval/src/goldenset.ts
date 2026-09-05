import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { noteName, type Note } from "@manent/core";

export interface EvalQuery {
  query: string;
  /** canonical note names that a good ranking must surface */
  expected: string[];
  /**
   * Where the query came from, and what it therefore measures:
   * - "curated": hand written, wording close to the note — tests lexical recall
   * - "oblique": asks for the concept WITHOUT the note's own words — the only
   *   set that can show whether graph expansion earns its complexity
   * - "auto": derived from a note's description — a broad regression signal
   */
  source: "curated" | "oblique" | "auto";
  note?: string;
}

export interface GoldenSet {
  name: string;
  queries: EvalQuery[];
}

/** Loads a hand-written golden set: {"name": "...", "queries": [...]}. */
export async function loadGoldenSet(path: string): Promise<GoldenSet> {
  const raw = JSON.parse(await readFile(path, "utf8")) as GoldenSet;
  if (!Array.isArray(raw.queries)) throw new Error(`${path}: missing "queries" array`);
  for (const q of raw.queries) {
    if (!q.query || !Array.isArray(q.expected) || q.expected.length === 0) {
      throw new Error(`${path}: every query needs a non-empty "expected" array`);
    }
    q.source ??= "curated";
  }
  return raw;
}

/**
 * Pseudonymous expected notes.
 *
 * A golden set is written against a real vault, so its `expected` names are a
 * list of what that vault holds — publishable only if the vault is. Writing
 * `note:<hash>` instead keeps the set publishable: the queries and the split
 * between them are the measurement, and they stay readable, while the names
 * resolve only for whoever already has the notes.
 *
 * Resolution happens against the loaded vault, so everything downstream — the
 * metrics, the miss list — keeps working with real names. An alias no note
 * matches stays unresolved and scores as a miss, which is the honest outcome:
 * a golden entry pointing at a note this vault does not have was never going
 * to be found.
 */
export const ALIAS_PREFIX = "note:";
const ALIAS_RE = /^note:[0-9a-f]{12}$/;

/** The published form of a note name. Stable, one-way, short enough to read. */
export const noteAlias = (name: string): string =>
  ALIAS_PREFIX + createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);

export const isAlias = (value: string): boolean => ALIAS_RE.test(value);

/** True when a set was published pseudonymously: at least one expected entry is an alias. */
export const isPseudonymous = (set: GoldenSet): boolean =>
  set.queries.some((q) => q.expected.some(isAlias));

/**
 * Turns `note:<hash>` entries back into the names of the notes in this vault.
 * A set with no aliases comes back untouched.
 */
export function resolveAliases(set: GoldenSet, notes: Note[]): GoldenSet {
  if (!isPseudonymous(set)) return set;
  const byAlias = new Map<string, string>();
  for (const n of notes) {
    const name = noteName(n);
    byAlias.set(noteAlias(name), name);
  }
  return {
    ...set,
    queries: set.queries.map((q) => ({
      ...q,
      expected: q.expected.map((e) => (isAlias(e) ? (byAlias.get(e) ?? e) : e)),
    })),
  };
}

const STOP = new Set([
  "il","lo","la","i","gli","le","un","uno","una","di","a","da","in","con","su","per","tra","fra",
  "e","o","ma","se","che","non","del","della","dei","delle","al","alla","nel","nella","sul","sulla",
  "the","a","an","of","to","in","on","for","and","or","but","not","is","are","with","from","by","it",
]);

/**
 * Derives queries from the notes themselves: a note's description, stripped of
 * stopwords and markup, is a plausible query whose only right answer is that
 * note. Costs no labelling and covers the whole vault, which makes it a fair
 * regression signal — but it is synthetic, so it measures "can retrieval find a
 * note from its own summary", not real user phrasing. Read it alongside the
 * curated set, never instead of it.
 */
export function deriveAutoQueries(notes: Note[], opts: { minWords?: number; maxWords?: number } = {}): EvalQuery[] {
  const minWords = opts.minWords ?? 4;
  const maxWords = opts.maxWords ?? 9;
  const out: EvalQuery[] = [];
  const seen = new Set<string>();

  for (const n of notes) {
    const name = noteName(n);
    if (seen.has(name)) continue;
    seen.add(name);
    const type = String(n.frontmatter.type ?? "");
    if (type === "index" || type === "moc") continue; // hubs are not answers

    const description = String(n.frontmatter.description ?? "");
    if (!description) continue;

    const words = description
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
      .replace(/`[^`]*`/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 2 && !STOP.has(w));

    if (words.length < minWords) continue;
    out.push({
      query: words.slice(0, maxWords).join(" "),
      expected: [name],
      source: "auto",
      note: "derived from description",
    });
  }
  return out;
}
