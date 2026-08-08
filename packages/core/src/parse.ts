import matter from "gray-matter";
import type { Note, NoteFrontmatter } from "./types.js";

const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) out.add(m[1].trim());
  return [...out];
}

export function parseNote(raw: string, path: string, relPath: string): Note {
  const { data, content } = matter(raw);
  return {
    path,
    relPath,
    frontmatter: data as Partial<NoteFrontmatter>,
    body: content,
    links: extractWikilinks(content),
  };
}
