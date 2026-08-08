import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** JSON Schema 2020-12 for the base note frontmatter contract. */
export const noteBaseSchema: Record<string, unknown> = require("../schemas/note-base.schema.json");

export const SPEC_VERSION = "0.1.0";

export const NOTE_TYPES = [
  "feedback",
  "reference",
  "project",
  "wiki-entity",
  "wiki-concept",
  "raw-source",
  "persona",
  "handoff",
  "retro",
  "moc",
  "index",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

export const EDGE_KINDS = ["wikilink", "provenance", "supersedes", "contradicts"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Directories that must never be synced, indexed or served. */
export const FORBIDDEN_DIRS = ["secrets"] as const;
