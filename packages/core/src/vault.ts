import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { FORBIDDEN_DIRS } from "@manent/spec";
import { parseNote } from "./parse.js";
import type { Note } from "./types.js";

const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ...FORBIDDEN_DIRS]);

export async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (e.name.endsWith(".md")) {
        out.push(join(dir, e.name));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function loadVault(root: string): Promise<Note[]> {
  const files = await listMarkdownFiles(root);
  return Promise.all(
    files.map(async (f) =>
      parseNote(await readFile(f, "utf8"), f, relative(root, f).split(sep).join("/")),
    ),
  );
}

/** Canonical name: frontmatter.name if present, else filename without extension. */
export function noteName(n: Note): string {
  const fm = n.frontmatter.name;
  if (typeof fm === "string" && fm.length > 0) return fm;
  const base = n.relPath.split("/").pop() ?? n.relPath;
  return base.replace(/\.md$/, "");
}
