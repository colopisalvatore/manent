import type { EdgeKind, NoteStatus, NoteType } from "@manent/spec";

export interface NoteFrontmatter {
  name: string;
  description: string;
  type: NoteType;
  created?: string;
  updated?: string;
  tags?: string[];
  provenance?: string[];
  supersedes?: string[];
  contradicts?: string[];
  confidence?: "high" | "medium" | "low";
  status?: NoteStatus;
  /** who may read it; absent = private (owner only) */
  audience?: string | string[];
  /** identity that wrote it through the write path */
  author?: string;
  [key: string]: unknown;
}

export interface Note {
  /** absolute file path */
  path: string;
  /** path relative to vault root, forward slashes */
  relPath: string;
  frontmatter: Partial<NoteFrontmatter>;
  body: string;
  /** outgoing wikilink targets (deduplicated raw names) */
  links: string[];
  /** set when the YAML frontmatter could not be parsed; the note still loads */
  parseError?: string;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Graph {
  /** canonical name → note */
  nodes: Map<string, Note>;
  edges: Edge[];
}
