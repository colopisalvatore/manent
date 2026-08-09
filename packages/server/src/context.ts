import { buildGraph, loadVault, type Graph, type Note } from "@manent/core";
import {
  bm25Retriever,
  buildDenseIndex,
  denseRetriever,
  fusedRetriever,
  hybridRetriever,
  loadLocalEmbeddingModel,
  type Retriever,
} from "@manent/retrieval";

export type RetrieverName = "bm25" | "hybrid" | "dense" | "fused";

/** Read-only view of a vault, shared by both protocol adapters. */
export interface BrainContext {
  notes: Note[];
  graph: Graph;
  retriever: Retriever;
}

export interface LoadContextOptions {
  retriever?: RetrieverName;
  /** embedding model id for dense/fused */
  model?: string;
}

/**
 * Default is `bm25`: it needs no optional dependency and starts instantly.
 *
 * Measured on a real 305-note vault (`npm run eval`), hand-written queries:
 *   bm25 75% hit@1 / 0.863 MRR · dense 95% / 0.975 · fused 100% / 1.000
 * So `fused` is the one to run if you can afford the embedding model (~120 MB
 * download, ~17 s to load, embeddings cached on disk afterwards). `hybrid`
 * (graph expansion) measured no better than plain lexical and stays for vaults
 * with a much denser link structure.
 */
export async function loadBrainContext(
  root: string,
  opts: LoadContextOptions = {},
): Promise<BrainContext> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);
  const choice = opts.retriever ?? "bm25";

  let retriever: Retriever;
  if (choice === "dense" || choice === "fused") {
    const model = await loadLocalEmbeddingModel({ modelId: opts.model });
    const dense = await buildDenseIndex(notes, model, { root });
    console.error(
      `[manent] dense index ready: ${dense.vectors.size} notes (${dense.embedded} embedded, ${dense.reused} cached)`,
    );
    retriever = choice === "dense" ? denseRetriever(dense) : fusedRetriever(notes, dense);
  } else if (choice === "hybrid") {
    retriever = hybridRetriever({ notes, graph });
  } else {
    retriever = bm25Retriever(notes);
  }

  return { notes, graph, retriever };
}
