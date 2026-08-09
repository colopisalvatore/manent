import type { Note } from "@manent/core";
import { bm25Candidates, buildSearchIndex } from "./bm25.js";
import type { DenseIndex } from "./dense.js";
import { denseRetriever } from "./dense.js";
import { reciprocalRankFusion, type RankedList } from "./fusion.js";
import type { Hit, Retriever } from "./types.js";

export interface FusedOptions {
  /** candidates taken from each ranker before fusing */
  depth?: number;
  /** weight of the dense list inside the fusion */
  denseWeight?: number;
  /** weight of the lexical list inside the fusion */
  lexicalWeight?: number;
}

/**
 * Weights chosen by sweep on a real 305-note vault (`scripts/tune-fusion.mjs`).
 * Giving dense twice the lexical weight took hand-written queries to 100% hit@1
 * / 1.000 MRR, at the cost of ~2 points on the synthetic auto-derived set — a
 * trade worth making, since the curated set is the closer proxy for real use.
 * At equal weights the lexical list pulls correct answers off the top spot.
 */
const DEFAULTS: Required<FusedOptions> = {
  depth: 30,
  denseWeight: 2,
  lexicalWeight: 1,
};

/**
 * Lexical + dense, fused with Reciprocal Rank Fusion.
 *
 * The two rankers fail in opposite directions: BM25 cannot find a note whose
 * wording differs from the question, and a small embedding model blurs exact
 * identifiers (slugs, error codes, entity names) that BM25 nails. Fusing by
 * rank rather than by score keeps both strengths without inventing a scale
 * factor between an inverted index and a cosine similarity.
 */
export function fusedRetriever(notes: Note[], dense: DenseIndex, options: FusedOptions = {}): Retriever {
  const opts = { ...DEFAULTS, ...options };
  const index = buildSearchIndex(notes);
  const denseR = denseRetriever(dense);

  return {
    name: "fused",
    async search(query, k = 8) {
      const lexical = bm25Candidates(index, query, opts.depth);
      const denseHits = await denseR.search(query, opts.depth);

      const lists: RankedList[] = [
        { name: "lex", weight: opts.lexicalWeight, items: lexical.map((c) => c.name) },
        { name: "dense", weight: opts.denseWeight, items: denseHits.map((h) => h.name) },
      ];
      const fused = reciprocalRankFusion(lists);

      const meta = new Map<string, { description: string; path: string }>();
      for (const c of lexical) meta.set(c.name, { description: c.description, path: c.path });
      for (const h of denseHits) if (!meta.has(h.name)) meta.set(h.name, { description: h.description, path: h.path });

      const out: Hit[] = [];
      for (const [name, score] of fused) {
        const m = meta.get(name) ?? dense.meta.get(name);
        if (!m) continue;
        const via = [
          lists[0].items.includes(name) ? "lex" : null,
          lists[1].items.includes(name) ? "dense" : null,
        ]
          .filter(Boolean)
          .join("+");
        out.push({ name, description: m.description, path: m.path, score, via });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, k).map((h) => ({ ...h, score: Math.round(h.score * 100_000) / 100_000 }));
    },
  };
}
