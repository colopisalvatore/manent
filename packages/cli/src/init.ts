import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIRS = [
  "memory",
  "projects",
  "moc",
  "people",
  "library",
  "wiki/entities",
  "wiki/concepts",
  "wiki/queries",
  "knowledge",
  "secrets",
];

const today = () => new Date().toISOString().slice(0, 10);

const MEMORY_MD = () => `---
name: memory-index
description: Global index of this brain. Loaded every session. One line per memory.
type: index
created: ${today()}
---

# MEMORY — Global index

Keep entries short: title + one line + link to the detail note.

## Lessons

- [Example lesson](memory/example-lesson.md) — how feedback notes are structured ([[example-lesson]])
`;

const HOME_MD = () => `---
name: home
description: Human navigation hub. Branches point to maps of content in moc/.
type: moc
created: ${today()}
---

# HOME

Branch MOCs live in \`moc/\`. Add one per knowledge area.
`;

const EXAMPLE_NOTE = () => `---
name: example-lesson
description: Example feedback note showing the required structure (Why + How to apply).
type: feedback
created: ${today()}
confidence: high
status: active
tags: [meta]
---

Feedback notes capture one lesson each: a correction received or an approach that worked.

**Why:** one atomic lesson per file keeps merges trivial and retrieval precise.

**How to apply:** when you learn something durable, create one note like this, link it from [[memory-index]], and reference related notes with wikilinks.
`;

const VAULT_GITIGNORE = `secrets/
.obsidian/workspace*
`;

export async function initVault(root: string): Promise<string[]> {
  const created: string[] = [];
  await mkdir(root, { recursive: true });
  for (const d of DIRS) await mkdir(join(root, d), { recursive: true });

  const files: Array<[string, string]> = [
    ["MEMORY.md", MEMORY_MD()],
    ["HOME.md", HOME_MD()],
    ["memory/example-lesson.md", EXAMPLE_NOTE()],
    [".gitignore", VAULT_GITIGNORE],
  ];
  for (const [rel, content] of files) {
    const p = join(root, rel);
    if (existsSync(p)) continue; // never overwrite an existing vault file
    await writeFile(p, content, "utf8");
    created.push(rel);
  }
  return created;
}
