import { buildGraph, filterVisible, loadVault, noteName, type Graph, type Note } from "@manent/core";
import {
  bm25Retriever,
  buildDenseIndex,
  buildSearchIndex,
  denseRetriever,
  fusedRetriever,
  hybridRetriever,
  loadLocalEmbeddingModel,
  statusAware,
  upsertSearchDoc,
  type DenseIndex,
  type EmbeddingModel,
  type Retriever,
} from "@manent/retrieval";
import { AuditLog } from "./audit.js";
import { FollowTracker, GapStore } from "./gaps.js";
import { VaultGit, type GitOptions } from "./git.js";
import { OWNER, scopeKey, type Identity } from "./identity.js";
import { TaskStore } from "./tasks.js";
import { watchVault, type VaultWatcher } from "./watch.js";

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
  /**
   * Resolves once the warmup and every re-embedding queued by a write or a
   * reload have landed. Writes do not wait for it — scripts and tests do.
   */
  settled(): Promise<void>;
  /** vault root on disk — write tools resolve paths against it */
  root: string;
  /**
   * Whether write tools may run. Off unless the operator opted in: a server
   * reachable from the network holds static bearer tokens, so writes are a
   * deliberate choice, never a default.
   */
  writable: boolean;
  /**
   * Whether a write asks the person to confirm before it lands, when the client
   * says it can carry the question. On unless the operator turned it off: a
   * client that advertises elicitation and then answers it itself — a headless
   * agent, a scheduled job — would otherwise refuse every write with nobody
   * having said no.
   */
  confirmWrites: boolean;
  /** who is calling; the owner unless the request carried an agent credential */
  identity: Identity;
  /** the gap register, when the server was started with one */
  gaps?: GapStore;
  /** links reads back to the searches that produced them */
  follow: FollowTracker;
  /** per-call audit, when the server was started with one */
  audit?: AuditLog;
  /** commits every write in the vault's repository, when the server was started with --git */
  git?: VaultGit;
  /** long-running tool calls, handed back as tasks on the modern path */
  tasks: TaskStore;
  /** bumped whenever the served state changes; views rebuild against it */
  version: number;
  /** the same vault as seen by another identity — cached per scope */
  forIdentity(identity: Identity): BrainContext;
  /**
   * Folds a freshly written note back into the served state, so a write is
   * visible to the very next read. The lexical index is updated in place for
   * that note alone; the dense side re-embeds that note in the background, so
   * a write — and the commit that follows it — never waits on the model.
   */
  applyWrite(note: Note): Promise<void>;
  /**
   * Re-reads the vault from disk and re-indexes what changed. Called by the
   * watcher on edits; callable by hand after a sync. Serialized: a reload
   * requested during a reload runs after it.
   */
  reload(): Promise<ReloadStats>;
  /** releases what the context holds open: the watcher, the gap register, the audit log */
  close(): Promise<void>;
}

export interface ReloadStats {
  added: number;
  changed: number;
  removed: number;
  notes: number;
  ms: number;
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
  /** an embedding model already loaded, used instead of loading `model` — for tests and embedders */
  embeddingModel?: EmbeddingModel;
  /** allow write tools; default false */
  writable?: boolean;
  /**
   * Ask the person to confirm each write when the client can carry the
   * question; default true. Turn it off for a server whose callers are
   * unattended — the injection and personal-data gates, the audit line and the
   * commit still stand, and an agent's note still lands in quarantine.
   */
  confirmWrites?: boolean;
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
  /**
   * Commit every write in the vault's git repository, authored by the identity
   * that made it; with `push`, follow each commit with a fast-forward push.
   * The vault must be a repository with a committer configured.
   */
  git?: GitOptions;
  /**
   * Watch the vault and re-index on edits. Off at this level; the CLI turns
   * it on for `serve`, since a served vault is the one that gets edited.
   */
  watch?: boolean;
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

  /**
   * Retained across writes so a re-index re-embeds instead of reloading the
   * model. Set together with `dense`, once the first index is built: before
   * that, writes leave the embedding to the warmup, which loops until it has
   * seen every change. (Setting it earlier let every write during warmup start
   * a full-vault embedding of its own, in parallel with the warmup's.)
   */
  let denseModel: EmbeddingModel | undefined;
  /** the full-vault dense index; views slice it by visible note */
  let dense: DenseIndex | undefined;
  /** the owner's lexical index, updated in place by writes, rebuilt by reloads */
  let lexical: ReturnType<typeof buildSearchIndex> | undefined;

  // The register and the audit open before serving starts: an operator who
  // asked for them should learn now, not on the first call, if a path is unusable.
  const gaps = opts.gaps ? await GapStore.open({ path: opts.gaps.path, threshold: opts.gaps.threshold }) : undefined;
  const audit = opts.audit ? await AuditLog.open(opts.audit) : undefined;
  const git = opts.git ? await VaultGit.open(root, opts.git) : undefined;

  /**
   * The ranker for a set of notes, sliced from the shared dense index when one
   * exists. `statusAware` wraps every ranker: quarantine and deprecated notes
   * rank below verified ones on every path, eval included. The owner's ranker
   * reuses the owner's lexical index; a view builds its own from what it sees.
   */
  const rank = (subset: Note[], graph: Graph): Retriever => {
    const own = () => (subset === notes ? (lexical ??= buildSearchIndex(notes)) : undefined);
    let inner: Retriever;
    if ((choice === "dense" || choice === "fused") && dense) {
      const idx = subset === notes ? dense : sliceDense(dense, subset);
      inner = choice === "dense" ? denseRetriever(idx) : fusedRetriever(subset, idx, { lexical: own() });
    } else {
      inner = choice === "hybrid" ? hybridRetriever({ notes: subset, graph }) : bm25Retriever(subset, own());
    }
    return statusAware(inner, subset);
  };

  const views = new Map<string, { version: number; ctx: BrainContext }>();

  /** bumped by every change to the notes, so a warmup that overlapped one knows to re-embed */
  let generation = 0;
  let reloading: Promise<ReloadStats> | undefined;
  let watcher: VaultWatcher | undefined;

  /**
   * Re-embedding after a change runs one at a time, off the write's path, and
   * coalesces: changes arriving while one pass waits to start ride on it. Each
   * pass reuses the previous index's vectors, so it embeds only what changed.
   */
  let denseTail: Promise<void> = Promise.resolve();
  let denseQueued: Promise<void> | undefined;
  const reindexDense = (): Promise<void> => {
    if (!denseModel || !dense) return Promise.resolve(); // the warmup will catch up
    if (denseQueued) return denseQueued;
    const model = denseModel;
    const pass = denseTail.then(async () => {
      denseQueued = undefined; // from here, a new change needs a pass of its own
      const started = Date.now();
      const built = await buildDenseIndex(notes, model, { root, previous: dense });
      dense = built;
      ctx.retriever = rank(notes, ctx.graph);
      ctx.version++;
      if (built.embedded > 0) {
        console.error(`[manent] re-embedded ${built.embedded} note(s) in ${Date.now() - started}ms`);
      }
    });
    denseQueued = pass;
    denseTail = pass.catch((err) =>
      console.error(`[manent] re-embedding failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    return denseTail;
  };

  const fingerprint = (n: Note) => `${JSON.stringify(n.frontmatter)}\0${n.body}`;

  const reloadNow = async (): Promise<ReloadStats> => {
    const started = Date.now();
    const fresh = await loadVault(root);
    const before = new Map(notes.map((n) => [n.relPath, fingerprint(n)]));
    let added = 0;
    let changed = 0;
    for (const n of fresh) {
      const prev = before.get(n.relPath);
      if (prev === undefined) added++;
      else if (prev !== fingerprint(n)) changed++;
    }
    const removed = notes.length - (fresh.length - added);
    const stats = { added, changed, removed, notes: fresh.length, ms: 0 };
    // Nothing to do — the usual case: the watcher seeing a write that
    // `applyWrite` has already folded in. Rebuilding anyway cost a full lexical
    // and dense pass per write, on top of the write's own.
    if (!added && !changed && !removed) return { ...stats, ms: Date.now() - started };
    // Same array, new contents: the retrievers and views are rebuilt anyway,
    // but nothing that kept a reference sees a stale list.
    notes.splice(0, notes.length, ...fresh);
    generation++;
    ctx.graph = buildGraph(notes);
    lexical = undefined;
    ctx.retriever = rank(notes, ctx.graph);
    ctx.version++;
    void reindexDense();
    stats.ms = Date.now() - started;
    console.error(`[manent] reloaded in ${stats.ms}ms — +${added} ~${changed} -${removed}, ${notes.length} notes`);
    return stats;
  };

  const graph = buildGraph(notes);
  const ctx: BrainContext = {
    notes,
    graph,
    retriever: rank(notes, graph),
    ready: Promise.resolve(),
    async settled() {
      let seen: Promise<void>;
      do {
        seen = denseTail;
        await ctx.ready;
        await seen;
      } while (seen !== denseTail);
    },
    root,
    writable: opts.writable ?? false,
    confirmWrites: opts.confirmWrites ?? true,
    identity: OWNER,
    gaps,
    follow: new FollowTracker(),
    audit,
    git,
    tasks: new TaskStore(),
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
      const previousName = at >= 0 ? noteName(notes[at]) : undefined;
      if (at >= 0) notes[at] = note;
      else notes.push(note);
      generation++;
      ctx.graph = buildGraph(notes);
      // Rebuild rather than guess when an upsert would leave the index wrong:
      // the file used to answer to another name (that entry would linger), or
      // another file already answers to this one (first one wins, as in a full build).
      const name = noteName(note);
      const renamed = previousName !== undefined && previousName !== name;
      const clash = notes.some((n) => n !== note && n.relPath !== note.relPath && noteName(n) === name);
      if (lexical && !renamed && !clash) upsertSearchDoc(lexical, note);
      else lexical = undefined;
      ctx.retriever = rank(notes, ctx.graph);
      ctx.version++;
      // Not awaited: the write is served lexically now, semantically when the
      // background pass lands — and its commit does not wait for the model.
      void reindexDense();
    },
    reload() {
      // One at a time: a second request during a reload waits for it and
      // then runs its own, so the last edit always wins.
      const next = (reloading ?? Promise.resolve()).then(reloadNow, reloadNow);
      reloading = next.finally(() => {
        if (reloading === next) reloading = undefined;
      });
      return next;
    },
    async close() {
      watcher?.close();
      gaps?.close();
      await audit?.close();
      // A commit still queued, or a push still waiting its debounce, lands
      // before the process goes: a write that reached the disk reaches git.
      await git?.flush();
    },
  };

  if (opts.watch) {
    watcher = watchVault(root, async () => {
      await ctx.reload();
    });
  }

  if (choice !== "dense" && choice !== "fused") return ctx;

  const warmup = async () => {
    try {
      const started = Date.now();
      const model = opts.embeddingModel ?? (await loadLocalEmbeddingModel({ modelId: opts.model }));
      // A write or reload that landed while the model was loading or embedding
      // changed the notes under us: go again until the index matches the vault
      // it serves. Each pass after the first reuses the one before, so it
      // embeds only what changed.
      let built: DenseIndex | undefined;
      let embedded = 0;
      let reused = 0;
      let seen: number;
      do {
        seen = generation;
        built = await buildDenseIndex(notes, model, { root, previous: built });
        if (embedded === 0 && reused === 0) reused = built.reused;
        embedded += built.embedded;
      } while (seen !== generation);
      dense = built;
      denseModel = model;
      ctx.retriever = rank(notes, ctx.graph);
      ctx.version++;
      // Same model for the register: gaps group by meaning from here on.
      gaps?.setEmbedder(async (text) => (await model.embed([text], "query"))[0]);
      console.error(
        `[manent] ${choice} ranker ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
          `${built.notes} notes / ${built.chunks.length} passages (${embedded} notes embedded, ${reused} cached)`,
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
    settled: () => root.settled(),
    root: root.root,
    writable: root.writable,
    confirmWrites: root.confirmWrites,
    identity,
    gaps: root.gaps,
    follow: root.follow,
    audit: root.audit,
    git: root.git,
    tasks: root.tasks,
    version: root.version,
    forIdentity: (id) => root.forIdentity(id),
    applyWrite: (note) => root.applyWrite(note),
    reload: () => root.reload(),
    close: () => root.close(),
  };
  return view;
}

/** Two agents with the same scope share a view; only the identity on it differs. */
const withIdentity = (view: BrainContext, identity: Identity): BrainContext =>
  view.identity === identity ? view : { ...view, identity };
