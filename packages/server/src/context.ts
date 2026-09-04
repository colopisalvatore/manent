import { buildGraph, filterVisible, loadVault, noteName, type Graph, type Note } from "@manent/core";
import {
  bm25Retriever,
  buildDenseIndex,
  denseRetriever,
  fusedRetriever,
  hybridRetriever,
  loadLocalEmbeddingModel,
  statusAware,
  type DenseIndex,
  type Retriever,
} from "@manent/retrieval";
import { AuditLog } from "./audit.js";
import { FollowTracker, GapStore } from "./gaps.js";
import { OWNER, scopeKey, type Identity } from "./identity.js";

export type RetrieverName = "bm25" | "hybrid" | "dense" | "fused";

/**
 * A view of a vault for one identity, shared by both protocol adapters.
 *
 * The owner's view is the whole vault. Any other identity gets a view built
 * from the notes its scope may read — notes, graph and ranker alike — so no
 * tool, ranked or not, can reach past it (see `filterVisible`).
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
   * reachable from the network holds static bearer tokens, so writes are a
   * deliberate choice, never a default.
   */
  writable: boolean;
  /** who is calling; the owner unless the request carried an agent credential */
  identity: Identity;
  /** the gap register, when the server was started with one */
  gaps?: GapStore;
  /** links reads back to the searches that produced them */
  follow: FollowTracker;
  /** per-call audit, when the server was started with one */
  audit?: AuditLog;
  /** bumped whenever the served state changes; views rebuild against it */
  version: number;
  /** the same vault as seen by another identity — cached per scope */
  forIdentity(identity: Identity): BrainContext;
  /**
   * Folds a freshly written note back into the served state, so a write is
   * visible to the very next read. Lexical ranking is rebuilt synchronously;
   * a dense index re-embeds only what changed (it caches by content hash).
   */
  applyWrite(note: Note): Promise<void>;
  /** releases what the context holds open: the gap register, the audit log */
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
  /** append one JSONL line per tool call to this file */
  audit?: string;
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
  const choice = opts.retriever ?? "bm25";

  /** retained across writes so a re-index re-embeds instead of reloading the model */
  let denseModel: Awaited<ReturnType<typeof loadLocalEmbeddingModel>> | undefined;
  /** the full-vault dense index; views slice it by visible note */
  let dense: DenseIndex | undefined;

  // The register and the audit open before serving starts: an operator who
  // asked for them should learn now, not on the first call, if a path is unusable.
  const gaps = opts.gaps ? await GapStore.open({ path: opts.gaps.path, threshold: opts.gaps.threshold }) : undefined;
  const audit = opts.audit ? await AuditLog.open(opts.audit) : undefined;

  /**
   * The ranker for a set of notes, sliced from the shared dense index when one
   * exists. `statusAware` wraps every ranker: quarantine and deprecated notes
   * rank below verified ones on every path, eval included.
   */
  const rank = (subset: Note[], graph: Graph): Retriever => {
    let inner: Retriever;
    if ((choice === "dense" || choice === "fused") && dense) {
      const idx = subset === notes ? dense : sliceDense(dense, subset);
      inner = choice === "dense" ? denseRetriever(idx) : fusedRetriever(subset, idx);
    } else {
      inner = choice === "hybrid" ? hybridRetriever({ notes: subset, graph }) : bm25Retriever(subset);
    }
    return statusAware(inner, subset);
  };

  const views = new Map<string, { version: number; ctx: BrainContext }>();

  const graph = buildGraph(notes);
  const ctx: BrainContext = {
    notes,
    graph,
    retriever: rank(notes, graph),
    ready: Promise.resolve(),
    root,
    writable: opts.writable ?? false,
    identity: OWNER,
    gaps,
    follow: new FollowTracker(),
    audit,
    version: 1,
    forIdentity(identity) {
      if (identity.owner) return ctx;
      const key = scopeKey(identity);
      const cached = views.get(key);
      if (cached && cached.version === ctx.version) return withIdentity(cached.ctx, identity);
      const view = buildView(ctx, identity, rank);
      views.set(key, { version: ctx.version, ctx: view });
      return view;
    },
    async applyWrite(note) {
      // Mutated in place: the retrievers close over this array.
      const at = notes.findIndex((n) => n.relPath === note.relPath);
      if (at >= 0) notes[at] = note;
      else notes.push(note);
      ctx.graph = buildGraph(notes);
      if ((choice === "dense" || choice === "fused") && denseModel) {
        dense = await buildDenseIndex(notes, denseModel, { root });
      }
      ctx.retriever = rank(notes, ctx.graph);
      ctx.version++;
    },
    async close() {
      gaps?.close();
      await audit?.close();
    },
  };
  if (choice !== "dense" && choice !== "fused") return ctx;

  const warmup = async () => {
    try {
      const started = Date.now();
      const model = await loadLocalEmbeddingModel({ modelId: opts.model });
      denseModel = model;
      dense = await buildDenseIndex(notes, model, { root });
      ctx.retriever = rank(notes, ctx.graph);
      ctx.version++;
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

/** The dense index restricted to a subset of notes — vectors are shared, nothing is re-embedded. */
function sliceDense(dense: DenseIndex, subset: Note[]): DenseIndex {
  const keep = new Set(subset.map(noteName));
  const meta = new Map<string, { description: string; path: string }>();
  for (const [name, m] of dense.meta) if (keep.has(name)) meta.set(name, m);
  return { ...dense, chunks: dense.chunks.filter((c) => keep.has(c.noteName)), meta, notes: meta.size };
}

/**
 * A reader's view: only the notes its scope may read exist in it. The graph is
 * built from those notes, and edges into hidden notes are dropped, so even a
 * neighbourhood listing cannot name what the reader may not open.
 */
function buildView(root: BrainContext, identity: Identity, rank: (subset: Note[], graph: Graph) => Retriever): BrainContext {
  const visible = filterVisible(root.notes, identity.read);
  const hidden = new Set<string>();
  const visibleNames = new Set(visible.map(noteName));
  for (const n of root.notes) {
    const name = noteName(n);
    if (!visibleNames.has(name)) hidden.add(name);
  }
  const full = buildGraph(visible);
  const graph: Graph = { nodes: full.nodes, edges: full.edges.filter((e) => !hidden.has(e.to) && !hidden.has(e.from)) };
  const view: BrainContext = {
    notes: visible,
    graph,
    retriever: rank(visible, graph),
    ready: root.ready,
    root: root.root,
    writable: root.writable,
    identity,
    gaps: root.gaps,
    follow: root.follow,
    audit: root.audit,
    version: root.version,
    forIdentity: (id) => root.forIdentity(id),
    applyWrite: (note) => root.applyWrite(note),
    close: () => root.close(),
  };
  return view;
}

/** Two agents with the same scope share a view; only the identity on it differs. */
const withIdentity = (view: BrainContext, identity: Identity): BrainContext =>
  view.identity === identity ? view : { ...view, identity };
