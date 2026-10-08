import MiniSearch from "minisearch";
import { noteName, type Note } from "@manent/core";
import type { Hit, Retriever } from "./types.js";

export interface SearchDoc {
  id: string;
  /** the slug split into words, so "cpanel cron wrapper" matches the filename */
  slugWords: string;
  description: string;
  body: string;
  relPath: string;
}

const slugWords = (name: string) => name.replace(/[_-]+/g, " ");

/**
 * Function words in the languages vaults are actually written in. They carry no
 * retrieval signal, and with prefix matching on they are actively harmful: "di"
 * matches *diritto*, *disposizione*, *documento*, so a long note wins on
 * accumulated noise. Observed on a real vault — Italian legal texts came back
 * for the query "non spegnere i server di sviluppo".
 */
export const STOPWORDS = new Set([
  // it
  "il","lo","la","i","gli","le","un","uno","una","di","del","dello","della","dei","degli","delle",
  "a","al","allo","alla","ai","agli","alle","da","dal","dalla","in","nel","nella","nei","nelle",
  "con","su","sul","sulla","per","tra","fra","e","o","ma","se","che","chi","cui","non","come","dove",
  "quando","piu","meno","anche","solo","ogni","questo","questa","quello","quella","essere","avere",
  "sono","era","fare","fa","si","ci","mi","ti","li","ne","io","tu","lui","lei","noi","voi","loro",
  // en
  "the","a","an","of","to","in","on","at","for","and","or","but","not","is","are","was","were","be",
  "with","from","by","it","its","this","that","these","those","as","if","then","than","so","do","does",
  "how","what","when","where","which","who","you","your","i","we","they",
]);

/** Shared by indexing and querying, so both sides drop the same tokens. */
const processTerm = (term: string): string | null => {
  const t = term.toLowerCase();
  if (t.length < 3) return null; // "di", "e", "ok" — noise under prefix matching
  if (STOPWORDS.has(t)) return null;
  return t;
};

export function buildSearchIndex(notes: Note[]): MiniSearch<SearchDoc> {
  const ms = new MiniSearch<SearchDoc>({
    fields: ["id", "slugWords", "description", "body"],
    storeFields: ["id", "description", "relPath"],
    processTerm,
    searchOptions: {
      boost: { id: 3, slugWords: 3, description: 2 },
      // Prefix and fuzzy only for terms long enough to be distinctive: on short
      // ones they generate matches instead of finding them.
      prefix: (term) => term.length >= 5,
      fuzzy: (term) => (term.length >= 6 ? 0.2 : false),
    },
  });
  const seen = new Set<string>();
  const docs: SearchDoc[] = [];
  for (const n of notes) {
    const id = noteName(n);
    if (seen.has(id)) continue; // duplicate-name is a lint error; never crash on it
    seen.add(id);
    docs.push(searchDoc(n));
  }
  ms.addAll(docs);
  return ms;
}

/** What a note becomes in the lexical index. */
export function searchDoc(n: Note): SearchDoc {
  const id = noteName(n);
  return {
    id,
    slugWords: slugWords(id),
    description: String(n.frontmatter.description ?? ""),
    body: n.body,
    relPath: n.relPath,
  };
}

/**
 * Folds one written note into an index built by `buildSearchIndex`, in place.
 * Rebuilding the index is linear in the vault — about a second of blocked event
 * loop on a 1,300-note vault with one 470 KB note — and a server that rebuilt
 * it on every write stopped answering while several agents wrote at once.
 */
export function upsertSearchDoc(index: MiniSearch<SearchDoc>, note: Note): void {
  const doc = searchDoc(note);
  if (index.has(doc.id)) index.replace(doc);
  else index.add(doc);
}

/**
 * Lexical baseline: MiniSearch's BM25 over slug, description and body.
 * Pass `index` to rank over one already built for these notes.
 */
export function bm25Retriever(notes: Note[], prebuilt?: MiniSearch<SearchDoc>): Retriever {
  const index = prebuilt ?? buildSearchIndex(notes);
  return {
    name: "bm25",
    search(query, k = 8) {
      return index
        .search(query)
        .slice(0, k)
        .map<Hit>((h) => ({
          name: h.id as string,
          description: (h.description as string) ?? "",
          path: (h.relPath as string) ?? "",
          score: Math.round(h.score * 100) / 100,
          via: "bm25",
        }));
    },
  };
}

/** Unranked BM25 candidates, for pipelines that re-rank afterwards. */
export function bm25Candidates(
  index: MiniSearch<SearchDoc>,
  query: string,
  depth: number,
): Array<{ name: string; description: string; path: string; score: number }> {
  return index
    .search(query)
    .slice(0, depth)
    .map((h) => ({
      name: h.id as string,
      description: (h.description as string) ?? "",
      path: (h.relPath as string) ?? "",
      score: h.score,
    }));
}
