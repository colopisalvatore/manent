import type { Note } from "./types.js";
import { noteName } from "./vault.js";

/**
 * Wikilink resolution.
 *
 * A vault is edited by humans in Obsidian and read by Manent. Obsidian resolves
 * `[[foo]]` by file name and `[[dir/foo]]` by path; Manent's own identity is the
 * canonical `name` in the frontmatter. When the two disagree — a note called
 * `moc-ops` living in `moc/ops.md` — a link that works in the editor looks
 * broken to the index, and a link that satisfies the index breaks in the editor.
 *
 * So we resolve the way an editor would, in this order:
 *   1. canonical name (exact)
 *   2. path relative to the linking note   `[[../people/rossi]]`
 *   3. path from the vault root            `[[moc/ops]]`
 *   4. file name alone, only if unique     `[[rossi]]`
 *
 * Everything returns the canonical name, so the graph stays keyed by name and
 * only genuinely missing targets are reported as unresolved.
 */

export interface LinkIndex {
  /** canonical name -> note */
  byName: Map<string, Note>;
  /** vault-root-relative path without extension, lowercased -> note */
  byPath: Map<string, Note>;
  /** file name without extension, lowercased -> notes sharing it */
  byStem: Map<string, Note[]>;
}

const MD_EXT = /\.(md|markdown)$/i;

function stripExtension(target: string): string {
  return target.replace(MD_EXT, "");
}

/** Normalizes `./a/../b` to `b`, without touching the filesystem. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function buildLinkIndex(notes: Note[]): LinkIndex {
  const byName = new Map<string, Note>();
  const byPath = new Map<string, Note>();
  const byStem = new Map<string, Note[]>();

  for (const note of notes) {
    const name = noteName(note);
    if (!byName.has(name)) byName.set(name, note);

    const relPath = stripExtension(note.relPath).toLowerCase();
    if (!byPath.has(relPath)) byPath.set(relPath, note);

    const stem = relPath.split("/").pop() ?? relPath;
    const bucket = byStem.get(stem);
    if (bucket) bucket.push(note);
    else byStem.set(stem, [note]);
  }

  return { byName, byPath, byStem };
}

/**
 * Resolves one wikilink target to a canonical note name.
 *
 * `fromRelPath` is the vault-relative path of the note containing the link; it
 * is what makes `../` links resolvable. Returns undefined when nothing matches,
 * or when a bare file name is ambiguous (two notes with the same file name):
 * guessing there would silently wire the graph to the wrong note.
 */
export function resolveLink(
  index: LinkIndex,
  target: string,
  fromRelPath?: string,
): string | undefined {
  const raw = target.trim();
  if (raw === "") return undefined;

  // 1. canonical name, the cheapest and the most specific
  const byName = index.byName.get(raw);
  if (byName) return noteName(byName);

  const cleaned = stripExtension(raw).toLowerCase();

  // 2. relative to the linking note
  if (fromRelPath && (raw.startsWith(".") || raw.includes("/"))) {
    const dir = fromRelPath.split("/").slice(0, -1).join("/");
    const relative = normalizePath(dir ? `${dir}/${cleaned}` : cleaned);
    const hit = index.byPath.get(relative);
    if (hit) return noteName(hit);
  }

  // 3. path from the vault root
  const fromRoot = index.byPath.get(normalizePath(cleaned));
  if (fromRoot) return noteName(fromRoot);

  // 4. file name alone — unambiguous, or disambiguated by proximity
  const stem = cleaned.split("/").pop() ?? cleaned;
  const candidates = index.byStem.get(stem);
  if (candidates?.length === 1) return noteName(candidates[0]);
  if (candidates && candidates.length > 1 && fromRelPath) {
    // `[[team]]` scritto in profile/ vuole profile/team.md, non
    // voice/team.md: a parita di nome vince la nota nella stessa cartella,
    // che e anche come lo legge un umano in Obsidian
    const dir = fromRelPath.split("/").slice(0, -1).join("/").toLowerCase();
    const sameDir = candidates.filter(
      (note) => note.relPath.split("/").slice(0, -1).join("/").toLowerCase() === dir,
    );
    if (sameDir.length === 1) return noteName(sameDir[0]);
  }

  return undefined;
}
