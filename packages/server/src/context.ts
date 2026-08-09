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

/**
 * Read-only view of a vault, shared by both protocol adapters.
 *
 * `retriever` is mutable on purpose: a dense ranker needs the model loaded and
 * the index built, so the context starts lexical and upgrades itself when the
 * heavy work finishes. Tools read the field per call, so they pick that up.
 */
export interface BrainContext {
  notes: Note[];
  graph: Graph;
  retriever: Retriever;
  /** resolves when a background dense warmup has finished (or failed) */
  ready: Promise<void>;
}

export interface LoadContextOptions {
  retriever?: RetrieverName;
  /** embedding model id for dense/fused */
  model?: string;
  /**
   * "background" (default) starts serving immediately with the lexical ranker
   * and swaps in the dense one when it is ready. "blocking" waits — use it in
   * scripts and evals, never in a service: loading the model and embedding a
   * vault takes ~1 minute on first run, which would be pure downtime, and this
   * service restarts on every vault sync.
   */
  warmup?: "background" | "blocking";
}

/**
 * Default ranker is `bm25`: no optional dependency, instant start.
 *
 * Measured on a real 305-note vault (`npm run eval`), hand-written queries:
 *   bm25 75% hit@1 / 0.863 MRR · dense 95% / 0.975 · fused 100% / 1.000
 * `fused` is the one to run when the embedding model is installed. `hybrid`
 * (graph expansion) measured no better than lexical; it stays for vaults with a
 * much denser link structure.
 */
export async function loadBrainContext(
  root: string,
  opts: LoadContextOptions = {},
): Promise<BrainContext> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);
  const choice = opts.retriever ?? "bm25";

  const ctx: BrainContext = {
    notes,
    graph,
    retriever: choice === "hybrid" ? hybridRetriever({ notes, graph }) : bm25Retriever(notes),
    ready: Promise.resolve(),
  };
  if (choice !== "dense" && choice !== "fused") return ctx;

  const warmup = async () => {
    try {
      const started = Date.now();
      const model = await loadLocalEmbeddingModel({ modelId: opts.model });
      const dense = await buildDenseIndex(notes, model, { root });
      ctx.retriever = choice === "dense" ? denseRetriever(dense) : fusedRetriever(notes, dense);
      console.error(
        `[manent] ${choice} ranker ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
          `${dense.notes} notes / ${dense.chunks.length} passages (${dense.embedded} notes embedded, ${dense.reused} cached)`,
      );
    } catch (err) {
      // Serving lexical results beats serving none: keep the fallback and say so.
      console.error(
        `[manent] ${choice} ranker unavailable, staying on bm25: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (opts.warmup === "blocking") {
    await warmup();
  } else {
    ctx.ready = warmup();
    console.error(`[manent] serving with bm25 while the ${choice} ranker warms up`);
  }
  return ctx;
}
