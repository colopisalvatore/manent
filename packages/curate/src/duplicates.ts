import { noteName, type Note } from "@manent/core";
import { cosine } from "@manent/retrieval";

/**
 * Near-duplicates: two notes saying the same thing.
 *
 * A brain accumulates them without anyone meaning to — the same lesson learned
 * twice, a note written by an agent next to the one a person already wrote, a
 * retro repeating what the handoff said. They cost more than disk: the ranker
 * splits the evidence between them, so the pair ranks lower than either would
 * alone, and a reader who finds one never learns the other exists.
 *
 * What this does is report pairs. What it must never do is merge them: which
 * of two notes is the one to keep is a judgement about meaning, and the cases
 * where it is obvious are exactly the cases where a person spends ten seconds.
 * So the output is a work list, ordered by how alike the pair is, with the
 * facts a person needs to decide: status, when each was last touched, and
 * whether the two already know about each other.
 */

export interface DuplicatePair {
  a: string;
  b: string;
  /** 0..1: cosine between the note vectors, or word-shingle overlap (see `lexicalSimilarity`) */
  score: number;
  method: "dense" | "lexical";
  aPath: string;
  bPath: string;
  aStatus?: string;
  bStatus?: string;
  aUpdated?: string;
  bUpdated?: string;
  /** the two already declare a relation: a wikilink, `supersedes` or `contradicts` */
  related: boolean;
}

export interface DuplicateOptions {
  /** report pairs at or above this similarity */
  threshold?: number;
  /**
   * One vector per note. With them the comparison is semantic (the same thing
   * said in different words is found); without them it falls back to word
   * shingles, which needs no model and still catches the copied note.
   */
  vectors?: Map<string, Float32Array>;
  /** stop after this many pairs, most alike first */
  limit?: number;
  /** include pairs that already declare a relation (off: they are not news) */
  includeRelated?: boolean;
}

/**
 * Both defaults are measured on a 488-note vault, not guessed.
 *
 * Lexical: word-triple Jaccard peaks at 0.23 there and its p99.9 is 0.096, so a
 * threshold in the 0.3s would never fire; containment (how much of the smaller
 * note is inside the bigger one) peaks at 0.40 and separates the real pairs
 * better. The reported score is the larger of the two, and containment only
 * speaks when the notes are within a factor of four in size — otherwise a short
 * note is "contained" in every long one that shares its vocabulary. At 0.25 the
 * vault yields six pairs, of which the top two are the actual copies.
 *
 * Dense: cosine between whole-note vectors has a median of 0.85 on that vault,
 * p99.9 at 0.933 and a maximum of 0.973 — this model compresses everything
 * written by one person about one job into a narrow band. So 0.93 would report
 * 150 pairs and 0.95 reports 35. It is set at 0.95, and read for what it is: at
 * these scores the list is topic twins (a handoff and the retro of the same
 * day, a project note and its retro), not copies. The lexical report is the one
 * that finds copies; the dense one finds subjects written about twice.
 */
export const DEFAULT_DENSE_THRESHOLD = 0.95;
export const DEFAULT_LEXICAL_THRESHOLD = 0.25;
/** Below this ratio between the two shingle sets, containment is not evidence. */
const SIZE_RATIO_FLOOR = 0.25;
/**
 * A note of a dozen words has one or two shingles, and two of them sharing a
 * sentence score 1.0 while saying nothing about each other. Below this many
 * shingles the measurement has no signal, so the pair is not reported.
 */
const MIN_SHINGLES = 8;

const SHINGLE = 3;

/** Words of a note, lowercased, punctuation dropped, order kept. */
function words(note: Note): string[] {
  const text = `${String(note.frontmatter.description ?? "")} ${note.body}`;
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1);
}

/** Overlapping word triples: the unit that survives reformatting but not rewriting. */
function shingles(note: Note): Set<string> {
  const w = words(note);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(" "));
  // A note shorter than one shingle still has to compare as something.
  if (out.size === 0 && w.length > 0) out.add(w.join(" "));
  return out;
}

/**
 * How alike two shingle sets are, by whichever of the two questions answers
 * best: "how much do they share" (Jaccard) and, when the notes are comparable
 * in size, "how much of the smaller one is inside the bigger one" (containment,
 * which is what catches a note pasted into a longer one and then extended).
 */
function lexicalSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size < MIN_SHINGLES || b.size < MIN_SHINGLES) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  if (shared === 0) return 0;
  const jaccard = shared / (a.size + b.size - shared);
  if (small.size / large.size < SIZE_RATIO_FLOOR) return jaccard;
  return Math.max(jaccard, shared / small.size);
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

export function duplicates(notes: Note[], opts: DuplicateOptions = {}): DuplicatePair[] {
  const method: "dense" | "lexical" = opts.vectors ? "dense" : "lexical";
  const threshold = opts.threshold ?? (method === "dense" ? DEFAULT_DENSE_THRESHOLD : DEFAULT_LEXICAL_THRESHOLD);

  const named = notes.map((n) => ({ note: n, name: noteName(n) }));
  const shingleOf = new Map<string, Set<string>>();
  if (method === "lexical") for (const { note, name } of named) shingleOf.set(name, shingles(note));

  // Two notes are "related" when one links, supersedes or contradicts the
  // other: the pair is already someone's decision, not a discovery.
  const relations = new Map<string, Set<string>>();
  for (const { note, name } of named) {
    const declared = new Set<string>([
      ...note.links,
      ...listOf(note.frontmatter.supersedes),
      ...listOf(note.frontmatter.contradicts),
    ]);
    relations.set(name, declared);
  }
  const areRelated = (a: string, b: string) => !!relations.get(a)?.has(b) || !!relations.get(b)?.has(a);

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const A = named[i];
      const B = named[j];
      let score: number;
      if (method === "dense") {
        const va = opts.vectors!.get(A.name);
        const vb = opts.vectors!.get(B.name);
        if (!va || !vb) continue;
        score = cosine(va, vb);
      } else {
        score = lexicalSimilarity(shingleOf.get(A.name)!, shingleOf.get(B.name)!);
      }
      if (score < threshold) continue;
      const related = areRelated(A.name, B.name);
      if (related && !opts.includeRelated) continue;
      pairs.push({
        a: A.name,
        b: B.name,
        score,
        method,
        aPath: A.note.relPath,
        bPath: B.note.relPath,
        aStatus: typeof A.note.frontmatter.status === "string" ? A.note.frontmatter.status : undefined,
        bStatus: typeof B.note.frontmatter.status === "string" ? B.note.frontmatter.status : undefined,
        aUpdated: stamp(A.note),
        bUpdated: stamp(B.note),
        related,
      });
    }
  }
  pairs.sort((p, q) => (q.score === p.score ? p.a.localeCompare(q.a) : q.score - p.score));
  return opts.limit != null ? pairs.slice(0, opts.limit) : pairs;
}

const stamp = (n: Note): string | undefined => {
  const v = (n.frontmatter.updated ?? n.frontmatter.created) as unknown;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return undefined;
};
