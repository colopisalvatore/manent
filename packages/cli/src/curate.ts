import { loadVault } from "@manent/core";
import { contradictions, duplicates, type ContradictionRow, type DuplicatePair } from "@manent/curate";
import { buildDenseIndex, loadLocalEmbeddingModel } from "@manent/retrieval";

export interface CurateCliOptions {
  /** run only the duplicate report */
  duplicates?: boolean;
  /** run only the contradiction report */
  contradictions?: boolean;
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
  const both = !opts.duplicates && !opts.contradictions;
  const report: { duplicates?: DuplicatePair[]; contradictions?: ContradictionRow[] } = {};

  if (both || opts.duplicates) {
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
  if (both || opts.contradictions) report.contradictions = contradictions(notes);

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
  return 0;
}
