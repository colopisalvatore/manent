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
const STOPWORDS = new Set([
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
    docs.push({
      id,
      slugWords: slugWords(id),
      description: String(n.frontmatter.description ?? ""),
      body: n.body,
      relPath: n.relPath,
    });
  }
  ms.addAll(docs);
  return ms;
}

/** Lexical baseline: MiniSearch's BM25 over slug, description and body. */
export function bm25Retriever(notes: Note[]): Retriever {
  const index = buildSearchIndex(notes);
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
