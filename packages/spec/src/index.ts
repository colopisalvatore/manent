import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** JSON Schema 2020-12 for the base note frontmatter contract. */
export const noteBaseSchema: Record<string, unknown> = require("../schemas/note-base.schema.json");

export const SPEC_VERSION = "0.2.0";

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

/**
 * `quarantine` is the state of a note an agent wrote with no human in the
 * loop: kept apart, ranked below verified notes, promoted by a human edit.
 */
export const NOTE_STATUSES = ["active", "quarantine", "deprecated", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** Directories that must never be synced, indexed or served. */
export const FORBIDDEN_DIRS = ["secrets"] as const;

/**
 * The two audience labels the spec reserves. `private` is what a note means
 * when it says nothing: only the owner reads it. `public` is the one label
 * that may leave the organisation. Every other label belongs to the vault.
 */
export const AUDIENCE_PRIVATE = "private";
export const AUDIENCE_PUBLIC = "public";
export const RESERVED_AUDIENCES = [AUDIENCE_PRIVATE, AUDIENCE_PUBLIC] as const;

/** Slug grammar shared by names, audience labels and author identities. */
export const SLUG_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
