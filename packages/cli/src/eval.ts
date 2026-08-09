import { writeFile } from "node:fs/promises";
import { buildGraph, loadVault } from "@manent/core";
import { bm25Retriever, hybridRetriever, type Retriever } from "@manent/retrieval";
import {
  compareReports,
  deriveAutoQueries,
  formatReport,
  loadGoldenSet,
  runEval,
  type EvalQuery,
  type EvalReport,
} from "@manent/eval";

export interface EvalCliOptions {
  golden?: string;
  auto: boolean;
  retriever: string;
  depth: number;
  worst: number;
  save?: string;
  baseline?: string;
}

const RETRIEVERS = ["bm25", "hybrid", "both"] as const;

export async function runEvalCommand(root: string, opts: EvalCliOptions): Promise<number> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);

  const queries: EvalQuery[] = [];
  if (opts.golden) {
    const set = await loadGoldenSet(opts.golden);
    queries.push(...set.queries);
    console.log(`golden set "${set.name}": ${set.queries.length} curated queries`);
  }
  if (opts.auto) {
    const auto = deriveAutoQueries(notes);
    queries.push(...auto);
    console.log(`auto-derived: ${auto.length} queries from note descriptions`);
  }
  if (queries.length === 0) {
    console.error("no queries — pass --golden <file> and/or keep --auto enabled");
    return 1;
  }

  const build = (name: string): Retriever =>
    name === "bm25" ? bm25Retriever(notes) : hybridRetriever({ notes, graph });

  const names = opts.retriever === "both" ? ["bm25", "hybrid"] : [opts.retriever];
  const reports: EvalReport[] = [];
  for (const name of names) {
    const report = runEval(build(name), queries, opts.depth);
    reports.push(report);
    console.log("");
    console.log(formatReport(report, { worst: opts.worst }));
  }

  // Two retrievers in one run: show what the second changes versus the first.
  if (reports.length === 2) {
    console.log("");
    console.log(`delta ${reports[1].retriever} vs ${reports[0].retriever}:`);
    const diffs = compareReports(reports[0], reports[1]);
    if (diffs.length === 0) console.log("  no metric moved beyond tolerance");
    for (const d of diffs) {
      const sign = d.delta > 0 ? "+" : "";
      console.log(`  ${d.metric.padEnd(8)} ${(d.before * 100).toFixed(1)}% → ${(d.after * 100).toFixed(1)}%  (${sign}${(d.delta * 100).toFixed(1)} pts)`);
    }
  }

  const last = reports[reports.length - 1];
  if (opts.save) {
    await writeFile(opts.save, JSON.stringify(last, null, 2), "utf8");
    console.log(`\nreport saved: ${opts.save}`);
  }

  // Regression gate: fail the run if any metric dropped against a saved report.
  if (opts.baseline) {
    const baseline = JSON.parse(await (await import("node:fs/promises")).readFile(opts.baseline, "utf8")) as EvalReport;
    const diffs = compareReports(baseline, last);
    const worse = diffs.filter((d) => d.delta < 0);
    console.log("");
    if (worse.length === 0) {
      console.log(`no regression against ${opts.baseline}`);
      return 0;
    }
    console.log(`REGRESSION against ${opts.baseline}:`);
    for (const d of worse) {
      console.log(`  ${d.metric}: ${(d.before * 100).toFixed(1)}% → ${(d.after * 100).toFixed(1)}% (${(d.delta * 100).toFixed(1)} pts)`);
    }
    return 1;
  }
  return 0;
}

export { RETRIEVERS };
