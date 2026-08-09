import { noteName, type Note } from "@manent/core";

/**
 * Splitting notes into passages before embedding.
 *
 * A whole note averaged into one vector loses the paragraph that actually
 * answers the question — and anything past the truncation point is invisible.
 * Chunks fix both, but an isolated chunk also loses the note's subject, so each
 * one is prefixed with the note's name and description ("contextual chunking"):
 * a paragraph reading "usa `git filter-repo --invert-paths`" is far more
 * findable when it carries "purga i dati cliente dalla history" with it.
 */

export interface Chunk {
  /** `<noteName>#<index>` — stable, so the cache survives unrelated edits */
  id: string;
  noteName: string;
  index: number;
  /** text actually sent to the model, prefix included */
  text: string;
}

export interface ChunkOptions {
  /** target passage size in characters (roughly 4 chars per token) */
  maxChars?: number;
  /** characters repeated between neighbours, so a sentence on the seam survives */
  overlapChars?: number;
  /** prepend note name + description to every chunk */
  contextPrefix?: boolean;
  /**
   * Cap on passages per note; 0 means unlimited. The default of 1 keeps the
   * header plus the opening of the note and drops the rest.
   *
   * That looks like throwing away information, and it measured better than every
   * alternative on a real vault (`scripts/tune-chunking.mjs`): full-body single
   * passage scored 95% curated hit@1, splitting into passages 85-90%, and the
   * truncated single passage 100%. Notes here are atomic and front-loaded — one
   * fact each, stated at the top — so the tail is elaboration that only blurs
   * the vector. Raise this for vaults of long, multi-topic documents, where the
   * answer can sit in the middle of a note.
   */
  maxPassages?: number;
}

export const DEFAULT_CHUNKING: Required<ChunkOptions> = {
  maxChars: 1400,
  overlapChars: 150,
  contextPrefix: true,
  maxPassages: 1,
};

/** Chunk config participates in the cache key: changing it must invalidate. */
export const chunkingSignature = (o: Required<ChunkOptions>) =>
  `c${o.maxChars}-o${o.overlapChars}-p${o.contextPrefix ? 1 : 0}-n${o.maxPassages}`;

function cleanBody(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ") // fenced code carries little retrieval signal
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Splits on blank lines first, then hard-wraps any paragraph that is still too long. */
function splitParagraphs(text: string, maxChars: number, overlapChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const p of paragraphs) {
    if (p.length > maxChars) {
      flush();
      for (let i = 0; i < p.length; i += maxChars - overlapChars) {
        out.push(p.slice(i, i + maxChars).trim());
        if (i + maxChars >= p.length) break;
      }
      continue;
    }
    if (current.length + p.length + 1 > maxChars) flush();
    current = current ? `${current}\n${p}` : p;
  }
  flush();
  return out;
}

export function chunkNote(note: Note, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNKING, ...options };
  const name = noteName(note);
  const title = name.replace(/[_-]+/g, " ");
  const description = String(note.frontmatter.description ?? "");
  const header = `${title}. ${description}`.trim();

  const body = cleanBody(note.body);
  const passages = body ? splitParagraphs(body, opts.maxChars, opts.overlapChars) : [];

  // A note with no body is still findable through its own header.
  if (passages.length === 0) {
    return [{ id: `${name}#0`, noteName: name, index: 0, text: header }];
  }

  const kept = opts.maxPassages > 0 ? passages.slice(0, opts.maxPassages) : passages;
  return kept.map((text, index) => ({
    id: `${name}#${index}`,
    noteName: name,
    index,
    text: opts.contextPrefix ? `${header}\n${text}` : text,
  }));
}

export function chunkVault(notes: Note[], options: ChunkOptions = {}): Map<string, Chunk[]> {
  const byNote = new Map<string, Chunk[]>();
  for (const n of notes) {
    const name = noteName(n);
    if (byNote.has(name)) continue;
    byNote.set(name, chunkNote(n, options));
  }
  return byNote;
}
