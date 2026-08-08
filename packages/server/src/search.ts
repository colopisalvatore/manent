import MiniSearch from "minisearch";
import { noteName, type Note } from "@manent/core";

export interface SearchDoc {
  id: string;
  description: string;
  body: string;
  relPath: string;
}

/**
 * BM25-style baseline index (MiniSearch). Stage 1 of the retrieval pipeline;
 * dense embeddings + RRF fusion plug in behind the same interface later.
 */
export function buildSearchIndex(notes: Note[]): MiniSearch<SearchDoc> {
  const ms = new MiniSearch<SearchDoc>({
    fields: ["id", "description", "body"],
    storeFields: ["id", "description", "relPath"],
    searchOptions: {
      boost: { id: 3, description: 2 },
      prefix: true,
      fuzzy: 0.1,
    },
  });
  const seen = new Set<string>();
  const docs: SearchDoc[] = [];
  for (const n of notes) {
    const id = noteName(n);
    if (seen.has(id)) continue; // duplicate-name is a lint error; the server must not crash on it
    seen.add(id);
    docs.push({
      id,
      description: String(n.frontmatter.description ?? ""),
      body: n.body,
      relPath: n.relPath,
    });
  }
  ms.addAll(docs);
  return ms;
}
