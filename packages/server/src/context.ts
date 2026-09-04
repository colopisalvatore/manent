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
import { FollowTracker, GapStore } from "./gaps.js";
import { OWNER, type Identity } from "./identity.js";

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
  /** vault root on disk — write tools resolve paths against it */
  root: string;
  /**
   * Whether write tools may run. Off unless the operator opted in: a server
   * reachable from the network holds one static bearer token, so writes are a
   * deliberate choice, never a default.
   */
  writable: boolean;
  /** who is calling; the owner unless the request carried an agent credential */
  identity: Identity;
  /** the gap register, when the server was started with one */
  gaps?: GapStore;
  /** links reads back to the searches that produced them */
  follow: FollowTracker;
  /**
   * Folds a freshly written note back into the served state, so a write is
   * visible to the very next read. Lexical ranking is rebuilt synchronously;
   * a dense index re-embeds only what changed (it caches by content hash).
   */
  applyWrite(note: Note): Promise<void>;
  /** releases what the context holds open: the gap register, watchers */
  close(): Promise<void>;
}

export interface GapsOptions {
  /** sqlite file for the gap register, outside the vault */
  path: string;
  /** cosine similarity above which two queries count as the same gap */
  threshold?: number;
}

export interface LoadContextOptions {
  retriever?: RetrieverName;
  /** embedding model id for dense/fused */
  model?: string;
  /** allow write tools; default false */
  writable?: boolean;
  /**
   * "background" (default) starts serving immediately with the lexical ranker
   * and swaps in the dense one when it is ready. "blocking" waits — use it in
   * scripts and evals, never in a service: loading the model and embedding a
   * vault takes ~1 minute on first run, which would be pure downtime, and this
   * service restarts on every vault sync.
   */
  warmup?: "background" | "blocking";
  /** record every search into a gap register at this path */
  gaps?: GapsOptions;
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

  /** retained across writes so a re-index re-embeds instead of reloading the model */
  let denseModel: Awaited<ReturnType<typeof loadLocalEmbeddingModel>> | undefined;
  const lexical = () => (choice === "hybrid" ? hybridRetriever({ notes, graph: ctx.graph }) : bm25Retriever(notes));

  // The register opens before serving starts: an operator who asked for it
  // should learn now, not on the first search, if the path is unusable.
  const gaps = opts.gaps ? await GapStore.open({ path: opts.gaps.path, threshold: opts.gaps.threshold }) : undefined;

  const ctx: BrainContext = {
    notes,
    graph,
    retriever: choice === "hybrid" ? hybridRetriever({ notes, graph }) : bm25Retriever(notes),
    ready: Promise.resolve(),
    root,
    writable: opts.writable ?? false,
    identity: OWNER,
    gaps,
    follow: new FollowTracker(),
    async applyWrite(note) {
      // Mutated in place: the retrievers close over this array.
      const at = notes.findIndex((n) => n.relPath === note.relPath);
      if (at >= 0) notes[at] = note;
      else notes.push(note);
      ctx.graph = buildGraph(notes);
      // Lexical first: cheap, and it makes the new note findable immediately.
      ctx.retriever = lexical();
      if ((choice === "dense" || choice === "fused") && denseModel) {
        const dense = await buildDenseIndex(notes, denseModel, { root });
        ctx.retriever = choice === "dense" ? denseRetriever(dense) : fusedRetriever(notes, dense);
      }
    },
    async close() {
      gaps?.close();
    },
  };
  if (choice !== "dense" && choice !== "fused") return ctx;

  const warmup = async () => {
    try {
      const started = Date.now();
      const model = await loadLocalEmbeddingModel({ modelId: opts.model });
      denseModel = model;
      const dense = await buildDenseIndex(notes, model, { root });
      ctx.retriever = choice === "dense" ? denseRetriever(dense) : fusedRetriever(notes, dense);
      // Same model for the register: gaps group by meaning from here on.
      gaps?.setEmbedder(async (text) => (await model.embed([text], "query"))[0]);
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
