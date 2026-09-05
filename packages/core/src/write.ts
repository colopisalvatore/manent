import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { FORBIDDEN_DIRS, NOTE_TYPES, type NoteType } from "@manent/spec";
import { parseNote } from "./parse.js";
import { readVaultIgnore } from "./vault.js";
import type { Note } from "./types.js";

/**
 * Writing into a vault, with the containment checks that a network-exposed
 * server needs. Every path a caller supplies is untrusted: a note name arrives
 * from a tool call, which arrives from a model, which may be repeating whatever
 * a web page told it. So names are slugs — never paths — and the resolved file
 * is re-checked against the vault root before anything touches the disk.
 */

/** A note name is a slug: letters, digits, `_`, `-`, `.` — never a path. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
/** A directory segment, same rules, so `..` and separators cannot appear. */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export class WriteRefused extends Error {}

export type WriteMode = "create" | "overwrite" | "append";

export interface WriteNoteInput {
  /** canonical name = filename slug; must not contain a path separator */
  name: string;
  /** vault-relative directory, forward slashes; defaults to the vault root */
  dir?: string;
  type?: NoteType | string;
  description?: string;
  /** markdown body, without frontmatter */
  body: string;
  mode?: WriteMode;
  /**
   * Extra frontmatter set by the caller — `author`, `status`, `audience`.
   * Applied over what the note already had and under the required trio, so
   * a caller can stamp a note but never unset its name, description or type.
   */
  frontmatter?: Record<string, unknown>;
}

export interface WriteResult {
  relPath: string;
  path: string;
  created: boolean;
  note: Note;
}

const refuse = (msg: string): never => {
  throw new WriteRefused(msg);
};

/**
 * Resolves a vault-relative target and proves it stays inside the vault.
 *
 * The regex checks already exclude `..` and separators, so this is belt and
 * braces — but it is the check that would still hold if the regexes were ever
 * loosened, so it is the one that must not be skipped.
 */
export function resolveInVault(root: string, dir: string | undefined, filename: string): { path: string; relPath: string } {
  const rootAbs = resolve(root);
  const segments = (dir ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const s of segments) {
    if (!SEGMENT_RE.test(s)) refuse(`Illegal directory segment "${s}": use plain names, no paths`);
  }
  if (isAbsolute(dir ?? "")) refuse("dir must be vault-relative, not absolute");
  if (segments.length > 0 && FORBIDDEN_DIRS.includes(segments[0] as (typeof FORBIDDEN_DIRS)[number])) {
    refuse(`Refusing to write into ${segments[0]}/ — never served, never synced`);
  }

  const relPath = [...segments, filename].join("/");
  const path = resolve(rootAbs, ...segments, filename);
  if (path !== rootAbs && !path.startsWith(rootAbs + sep)) {
    refuse(`Refusing to write outside the vault: ${relPath}`);
  }
  return { path, relPath };
}

/**
 * YAML parses bare dates as Date objects; written back they would become
 * timestamps. Normalize to the YYYY-MM-DD the spec asks for. Every path that
 * rewrites an existing note's frontmatter goes through here.
 */
export function datesAsStrings(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) out[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  return out;
}

/**
 * Creates or updates one note, frontmatter first.
 *
 * `create` (the default) never clobbers: an agent that means to add a note and
 * finds one there has hit a name collision, not an update, and should be told.
 */
export async function writeNote(root: string, input: WriteNoteInput): Promise<WriteResult> {
  const name = String(input.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    refuse(`Illegal note name "${name}": use a slug (letters, digits, _ - .), no paths or spaces`);
  }
  const mode: WriteMode = input.mode ?? "create";
  const { path, relPath } = resolveInVault(root, input.dir, `${name}.md`);

  const ignore = await readVaultIgnore(root);
  if (ignore.some((p) => relPath === p || relPath.startsWith(p + "/"))) {
    refuse(`Refusing to write to ${relPath}: excluded by .manentignore, so it would never be served`);
  }

  const existingRaw = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (existingRaw !== undefined && mode === "create") {
    refuse(`Note already exists: ${relPath}. Use mode "overwrite" to replace it or "append" to add to it.`);
  }
  if (existingRaw === undefined && mode === "append") {
    refuse(`Note not found: ${relPath}. Use mode "create" to make it.`);
  }

  const previous = existingRaw !== undefined ? parseNote(existingRaw, path, relPath) : undefined;
  const type = input.type ?? previous?.frontmatter.type;
  const description = input.description ?? previous?.frontmatter.description;

  // The spec's required trio. Enforced here rather than left to `manent lint`:
  // a vault that only fails validation after the fact is a vault that drifts.
  if (typeof description !== "string" || description.trim().length === 0) {
    refuse("description is required (one line, what this note is)");
  }
  if (typeof type !== "string" || !NOTE_TYPES.includes(type as NoteType)) {
    refuse(`type must be one of: ${NOTE_TYPES.join(", ")}`);
  }

  const body =
    mode === "append" && previous ? `${previous.body.replace(/\s*$/, "")}\n\n${input.body.trim()}\n` : `${input.body.trim()}\n`;

  const kept = datesAsStrings((previous?.frontmatter ?? {}) as Record<string, unknown>);
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter: Record<string, unknown> = {
    ...kept,
    ...(input.frontmatter ?? {}),
    name,
    description: String(description).trim(),
    type,
    created: typeof kept.created === "string" ? kept.created : today,
    updated: today,
  };

  const raw = matter.stringify(body, frontmatter);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, raw, "utf8");

  return {
    relPath,
    path,
    created: existingRaw === undefined,
    note: parseNote(raw, path, relPath),
  };
}

/** Vault-relative path of a note, forward slashes — the form tools report. */
export const relOf = (root: string, path: string): string => relative(resolve(root), path).split(sep).join("/");

export { join as joinVaultPath };
