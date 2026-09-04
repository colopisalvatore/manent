import { AUDIENCE_PRIVATE, AUDIENCE_PUBLIC } from "@manent/spec";
import type { Note } from "./types.js";

/**
 * Who may read a note, and whether a given reader may.
 *
 * Visibility is a property of the note, declared in its frontmatter, not of
 * the folder it sits in: the same note often serves two audiences, and folders
 * force it into one home. A note that says nothing is `private` — the most
 * restrictive reading — so a note written without thinking about it cannot
 * become visible by accident. That is the same principle as `secrets/`.
 */

/** Normalized audience labels of a note; never empty. */
export function noteAudiences(note: Pick<Note, "frontmatter">): string[] {
  const raw = note.frontmatter.audience;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const labels = [...new Set(list.map((l) => String(l).trim().toLowerCase()).filter((l) => l.length > 0))];
  return labels.length > 0 ? labels : [AUDIENCE_PRIVATE];
}

/**
 * A read scope is a list of labels; `*` means everything, private notes
 * included, and is what the owner holds. `private` itself is never in an
 * agent's scope — it is not a label one grants, it is the absence of one.
 */
export function canRead(scope: readonly string[], note: Pick<Note, "frontmatter">): boolean {
  if (scope.includes("*")) return true;
  const audiences = noteAudiences(note);
  if (audiences.includes(AUDIENCE_PUBLIC)) return true;
  return audiences.some((a) => a !== AUDIENCE_PRIVATE && scope.includes(a));
}

/**
 * The notes a scope may see. Applied when a view of the vault is built, before
 * any index exists over it: search, listing, grep and raw reads then cannot
 * reach a note the reader is not allowed to see, because for that reader the
 * note was never loaded. Filtering after ranking would leave every tool that
 * bypasses the ranker — grep, raw read — wide open.
 */
export function filterVisible<T extends Pick<Note, "frontmatter">>(notes: T[], scope: readonly string[]): T[] {
  if (scope.includes("*")) return notes;
  return notes.filter((n) => canRead(scope, n));
}
