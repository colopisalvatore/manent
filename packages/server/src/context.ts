import { buildGraph, loadVault, type Graph, type Note } from "@manent/core";
import { bm25Retriever, hybridRetriever, type Retriever } from "@manent/retrieval";

export type RetrieverName = "bm25" | "hybrid";

/** Read-only view of a vault, shared by both protocol adapters. */
export interface BrainContext {
  notes: Note[];
  graph: Graph;
  retriever: Retriever;
}

/**
 * Default is `bm25`, not the fancier pipeline — measured, not assumed.
 *
 * On a real 305-note vault (`npm run eval`) the lexical ranker with proper
 * tokenization matches hybrid on hand-written queries (hit@1 75%, MRR 0.863)
 * and beats it on the broad auto-derived set (97.8% vs 93.0%): graph expansion
 * and the recency/centrality multipliers cost accuracy without buying recall.
 * `hybrid` stays available for vaults whose link structure is richer.
 */
export async function loadBrainContext(
  root: string,
  opts: { retriever?: RetrieverName } = {},
): Promise<BrainContext> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);
  const retriever =
    opts.retriever === "hybrid" ? hybridRetriever({ notes, graph }) : bm25Retriever(notes);
  return { notes, graph, retriever };
}
