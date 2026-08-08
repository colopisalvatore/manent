import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { FORBIDDEN_DIRS } from "@manent/spec";
import { parseNote } from "./parse.js";
import type { Note } from "./types.js";

const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ...FORBIDDEN_DIRS]);

/**
 * Reads `.manentignore` at the vault root: one path prefix per line,
 * `#` comments. Matching is plain prefix on vault-relative paths — no globs.
 * Used to exclude read-only mirrors, raw corpora and submodules from
 * loading, linting and serving. `secrets/` is always excluded regardless.
 */
export async function readVaultIgnore(root: string): Promise<string[]> {
  try {
    const raw = await readFile(join(root, ".manentignore"), "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => l.replace(/\\/g, "/").replace(/\/+$/, ""));
  } catch {
    return [];
  }
}

export async function listMarkdownFiles(root: string, ignore: string[] = []): Promise<string[]> {
  const out: string[] = [];
  const ignored = (rel: string) =>
    ignore.some((p) => rel === p || rel.startsWith(p + "/"));
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p).split(sep).join("/");
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !ignored(rel)) await walk(p);
      } else if (e.name.endsWith(".md") && !ignored(rel)) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function loadVault(root: string): Promise<Note[]> {
  const ignore = await readVaultIgnore(root);
  const files = await listMarkdownFiles(root, ignore);
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
