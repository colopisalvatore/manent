import matter from "gray-matter";
import type { Note, NoteFrontmatter } from "./types.js";

const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) out.add(m[1].trim());
  return [...out];
}

/**
 * Never throws. One note with hand-written, invalid YAML must not take down a
 * lint run or a running server: the note loads with no frontmatter, its body
 * intact (so it stays searchable) and `parseError` set for the linter to report.
 */
export function parseNote(raw: string, path: string, relPath: string): Note {
  let data: unknown = {};
  let content = raw;
  let parseError: string | undefined;
  try {
    const parsed = matter(raw);
    data = parsed.data;
    content = parsed.content;
  } catch (err) {
    parseError = err instanceof Error ? err.message.split("\n")[0] : String(err);
    content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  }
  return {
    path,
    relPath,
    frontmatter: data as Partial<NoteFrontmatter>,
    body: content,
    links: extractWikilinks(content),
    ...(parseError ? { parseError } : {}),
  };
}
