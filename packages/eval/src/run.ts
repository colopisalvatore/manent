import type { Retriever } from "@manent/retrieval";
import type { EvalQuery } from "./goldenset.js";
import { scorecard, type Scorecard } from "./metrics.js";

export interface QueryResult {
  query: string;
  expected: string[];
  ranked: string[];
  source: EvalQuery["source"];
  rankOfFirstExpected: number | null;
}

export interface EvalReport {
  retriever: string;
  overall: Scorecard;
  bySource: Record<string, Scorecard>;
  results: QueryResult[];
}

export async function runEval(
  retriever: Retriever,
  queries: EvalQuery[],
  depth = 10,
): Promise<EvalReport> {
  const results: QueryResult[] = [];
  for (const q of queries) {
    // Sequential on purpose: a dense retriever runs a model per query, and
    // flooding it in parallel makes the numbers noisy rather than faster.
    const ranked = (await retriever.search(q.query, depth)).map((h) => h.name);
    const i = ranked.findIndex((r) => q.expected.includes(r));
    results.push({
      query: q.query,
      expected: q.expected,
      ranked,
      source: q.source,
      rankOfFirstExpected: i === -1 ? null : i + 1,
    });
  }

  const bySource: Record<string, Scorecard> = {};
  for (const source of new Set(queries.map((q) => q.source))) {
    bySource[source] = scorecard(results.filter((r) => r.source === source));
  }

  return { retriever: retriever.name, overall: scorecard(results), bySource, results };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport, opts: { worst?: number } = {}): string {
  const lines: string[] = [];
  const row = (label: string, s: Scorecard) =>
    `  ${label.padEnd(10)} n=${String(s.queries).padStart(4)}  hit@1 ${pct(s.hit1).padStart(6)}  hit@3 ${pct(s.hit3).padStart(6)}  recall@5 ${pct(s.recall5).padStart(6)}  MRR ${s.mrr.toFixed(3)}  nDCG@10 ${s.ndcg10.toFixed(3)}`;

  lines.push(`retriever: ${report.retriever}`);
  lines.push(row("overall", report.overall));
  for (const [source, s] of Object.entries(report.bySource)) lines.push(row(source, s));

  const worst = opts.worst ?? 0;
  if (worst > 0) {
    const misses = report.results.filter((r) => r.rankOfFirstExpected === null).slice(0, worst);
    if (misses.length > 0) {
      lines.push(`  misses (expected note not in top ${report.results[0]?.ranked.length ?? 10}):`);
      for (const m of misses) lines.push(`    "${m.query}" → want ${m.expected.join("|")}, got ${m.ranked.slice(0, 3).join(", ") || "nothing"}`);
    }
  }
  return lines.join("\n");
}

/** Compares two reports; returns the metrics that moved beyond a tolerance. */
export function compareReports(
  baseline: EvalReport,
  current: EvalReport,
  tolerance = 0.005,
): Array<{ metric: keyof Scorecard; before: number; after: number; delta: number }> {
  const metrics: Array<keyof Scorecard> = ["hit1", "hit3", "recall5", "recall10", "mrr", "ndcg10"];
  const out = [];
  for (const m of metrics) {
    const before = baseline.overall[m];
    const after = current.overall[m];
    const delta = after - before;
    if (Math.abs(delta) > tolerance) out.push({ metric: m, before, after, delta });
  }
  return out;
}
