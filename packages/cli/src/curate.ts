import { loadVault } from "@manent/core";
import {
  communities,
  contradictions,
  duplicates,
  type Community,
  type CommunityReport,
  type ContradictionRow,
  type DuplicatePair,
} from "@manent/curate";
import { buildDenseIndex, loadLocalEmbeddingModel } from "@manent/retrieval";
import { GapStore } from "@manent/server";

export interface CurateCliOptions {
  /** run only the duplicate report */
  duplicates?: boolean;
  /** run only the contradiction report */
  contradictions?: boolean;
  /** run only the community report */
  communities?: boolean;
  /** smallest group of notes the community report calls a subject */
  minSize?: number;
  /** gap register, to rank communities by the questions they failed to answer */
  gaps?: string;
  /** compare notes by meaning (needs the embedding model) instead of by words */
  dense?: boolean;
  model?: string;
  threshold?: number;
  limit?: number;
  /** also report pairs that already link to or supersede each other */
  includeRelated?: boolean;
  json?: boolean;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function formatDuplicates(pairs: DuplicatePair[], method: string, includeRelated: boolean): string {
  if (pairs.length === 0) return `no near-duplicates above the threshold (${method})`;
  const lines = [`${pad("score", 6)} ${pad("note", 34)} ${pad("status", 11)} ${pad("twin", 34)} ${pad("status", 11)} paths`];
  for (const p of pairs) {
    lines.push(
      `${pad(p.score.toFixed(3), 6)} ${pad(clip(p.a, 34), 34)} ${pad(p.aStatus ?? "active", 11)} ` +
        `${pad(clip(p.b, 34), 34)} ${pad(p.bStatus ?? "active", 11)} ${p.aPath} · ${p.bPath}`,
    );
  }
  const related = includeRelated
    ? "pairs that already link to each other are included"
    : "pairs that already link to each other are hidden (--include-related shows them)";
  lines.push("", `${pairs.length} pairs, most alike first · ${method} similarity · ${related}`);
  lines.push("nothing here is merged: which of two notes survives is a judgement about meaning, so it stays a person's call");
  return lines.join("\n");
}

function formatContradictions(rows: ContradictionRow[]): string {
  if (rows.length === 0) return "no declared contradictions and no superseded note left active";
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(`[${r.kind}] ${r.a} → ${r.b}`);
    lines.push(`    ${r.message}`);
    lines.push(`    ${r.aPath}${r.bPath ? ` · ${r.bPath}` : ""}`);
  }
  lines.push("");
  lines.push("declared = both notes say it · one-sided = only one does · superseded = the replaced note is still active");
  return lines.join("\n");
}

function formatCommunities(report: CommunityReport, weighted: boolean): string {
  if (report.communities.length === 0) {
    return `no community of that size in ${report.nodes} notes and ${report.edges} links — the graph is too sparse to suggest a map`;
  }
  const lines = [
    `${pad("size", 5)} ${pad("in/out", 8)} ${weighted ? pad("gaps", 5) : ""}${pad("map of content", 26)} what holds it together`,
  ];
  for (const c of report.communities) {
    const covered = c.mocs.length > 0 ? c.mocs.map((m) => `${m.name} (${m.links})`).join(", ") : "— none —";
    lines.push(
      `${pad(String(c.size), 5)} ${pad(`${c.internalEdges}/${c.externalEdges}`, 8)} ` +
        `${weighted ? pad(String(c.openGaps ?? 0), 5) : ""}${pad(clip(covered, 26), 26)} ${clip(c.hubs.join(", "), 70)}`,
    );
  }
  lines.push("");
  lines.push(
    `${report.communities.length} communities · modularity ${report.modularity.toFixed(3)} ` +
      `(0 is no structure, 0.3 and up is real) · ${report.isolated} notes have no links at all`,
  );
  lines.push("in/out = links inside the group against links leaving it · a map of content shows how many members it links");
  if (weighted) lines.push("gaps = open gaps whose best answers landed here: a subject people ask about, ordered first");
  lines.push("a group with no map of content is where writing one would pay: `manent curate <vault> --communities --json` lists the members");
  return lines.join("\n");
}

/** Notes that were the best answers to open gaps, counted once per gap. */
async function gapWeights(db: string): Promise<Map<string, number>> {
  const store = await GapStore.open({ path: db });
  try {
    const weight = new Map<string, number>();
    for (const gap of store.listGaps({ status: "open", limit: 1000 })) {
      const named = new Set<string>();
      for (const search of store.listSearches(gap.id)) for (const name of search.topNames.slice(0, 3)) named.add(name);
      for (const name of named) weight.set(name, (weight.get(name) ?? 0) + 1);
    }
    return weight;
  } finally {
    store.close();
  }
}

/** One vector per note: the default chunking gives one passage per note, and averages the rest. */
async function noteVectors(root: string, notes: Parameters<typeof duplicates>[0], model?: string) {
  const embedder = await loadLocalEmbeddingModel({ modelId: model });
  const index = await buildDenseIndex(notes, embedder, { root });
  const sums = new Map<string, { vec: Float32Array; n: number }>();
  for (const c of index.chunks) {
    const acc = sums.get(c.noteName);
    if (!acc) {
      sums.set(c.noteName, { vec: Float32Array.from(c.vec), n: 1 });
      continue;
    }
    for (let i = 0; i < acc.vec.length; i++) acc.vec[i] += c.vec[i];
    acc.n++;
  }
  const out = new Map<string, Float32Array>();
  for (const [name, { vec, n }] of sums) {
    if (n > 1) for (let i = 0; i < vec.length; i++) vec[i] /= n;
    out.set(name, vec);
  }
  return out;
}

export async function runCurateCommand(root: string, opts: CurateCliOptions): Promise<number> {
  const notes = await loadVault(root);
  const all = !opts.duplicates && !opts.contradictions && !opts.communities;
  const report: {
    duplicates?: DuplicatePair[];
    contradictions?: ContradictionRow[];
    communities?: CommunityReport;
  } = {};

  if (all || opts.duplicates) {
    let vectors: Map<string, Float32Array> | undefined;
    if (opts.dense) {
      try {
        vectors = await noteVectors(root, notes, opts.model);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }
    report.duplicates = duplicates(notes, {
      vectors,
      threshold: opts.threshold,
      limit: opts.limit,
      includeRelated: opts.includeRelated,
    });
  }
  if (all || opts.contradictions) report.contradictions = contradictions(notes);

  if (all || opts.communities) {
    let gapWeight: Map<string, number> | undefined;
    if (opts.gaps) {
      try {
        gapWeight = await gapWeights(opts.gaps);
      } catch (err) {
        console.error(`gap register ${opts.gaps}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    report.communities = communities(notes, { minSize: opts.minSize, gapWeight });
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  if (report.duplicates) {
    console.log(`── near-duplicates (${notes.length} notes) ──`);
    console.log(formatDuplicates(report.duplicates, opts.dense ? "dense" : "lexical", !!opts.includeRelated));
  }
  if (report.contradictions) {
    if (report.duplicates) console.log();
    console.log("── contradictions ──");
    console.log(formatContradictions(report.contradictions));
  }
  if (report.communities) {
    if (report.duplicates || report.contradictions) console.log();
    console.log("── communities, and the maps of content that are missing ──");
    console.log(formatCommunities(report.communities, !!opts.gaps));
  }
  return 0;
}
