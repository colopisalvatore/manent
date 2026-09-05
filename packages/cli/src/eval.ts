import { readFile, writeFile } from "node:fs/promises";
import { buildGraph, loadVault } from "@manent/core";
import {
  bm25Retriever,
  buildDenseIndex,
  denseRetriever,
  fusedRetriever,
  hybridRetriever,
  loadLocalEmbeddingModel,
  statusAware,
  type Retriever,
} from "@manent/retrieval";
import {
  compareReports,
  deriveAutoQueries,
  formatReport,
  isAlias,
  isPseudonymous,
  loadGoldenSet,
  resolveAliases,
  runEval,
  type EvalQuery,
  type EvalReport,
} from "@manent/eval";

export const RETRIEVERS = ["bm25", "hybrid", "dense", "fused", "both", "all"] as const;
export type RetrieverChoice = (typeof RETRIEVERS)[number];

export interface EvalCliOptions {
  golden?: string;
  auto: boolean;
  retriever: string;
  depth: number;
  worst: number;
  save?: string;
  /** include the per-query results in the saved report (they name every note) */
  saveFull?: boolean;
  baseline?: string;
  model?: string;
}

const EXPAND: Record<string, string[]> = {
  both: ["bm25", "hybrid"],
  all: ["bm25", "dense", "fused"],
};

export async function runEvalCommand(root: string, opts: EvalCliOptions): Promise<number> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);

  const queries: EvalQuery[] = [];
  if (opts.golden) {
    // A published set names its notes by hash; they resolve here, against the
    // vault that has them, so the rest of the run sees ordinary names.
    const published = await loadGoldenSet(opts.golden);
    const set = resolveAliases(published, notes);
    queries.push(...set.queries);
    const unresolved = set.queries.flatMap((q) => q.expected.filter(isAlias)).length;
    console.log(
      `golden set "${set.name}": ${set.queries.length} hand-written queries` +
        (isPseudonymous(published)
          ? ` (published by hash; ${unresolved > 0 ? `${unresolved} not in this vault` : "all resolved against this vault"})`
          : ""),
    );
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

  const names = EXPAND[opts.retriever] ?? [opts.retriever];

  // Embeddings are loaded once and shared: the model costs ~17s to load and the
  // index is cached on disk, so a second dense-based retriever is nearly free.
  let dense: Awaited<ReturnType<typeof buildDenseIndex>> | undefined;
  if (names.some((n) => n === "dense" || n === "fused")) {
    const model = await loadLocalEmbeddingModel({ modelId: opts.model });
    console.log(`embedding model: ${model.id}`);
    dense = await buildDenseIndex(notes, model, {
      root,
      onProgress: (done, total) => {
        if (done === total || done % 128 === 0) console.log(`  embedded ${done}/${total} passages`);
      },
    });
    console.log(
      `dense index: ${dense.notes} notes / ${dense.chunks.length} passages ` +
        `(${dense.embedded} notes embedded, ${dense.reused} from cache)`,
    );
  }

  // Wrapped exactly as the server wraps them: what is measured is what ships,
  // status demotion included.
  const build = (name: string): Retriever => {
    switch (name) {
      case "bm25":
        return statusAware(bm25Retriever(notes), notes);
      case "hybrid":
        return statusAware(hybridRetriever({ notes, graph }), notes);
      case "dense":
        if (!dense) throw new Error("dense index unavailable");
        return statusAware(denseRetriever(dense), notes);
      case "fused":
        if (!dense) throw new Error("dense index unavailable");
        return statusAware(fusedRetriever(notes, dense), notes);
      default:
        throw new Error(`unknown retriever: ${name}`);
    }
  };

  const reports: EvalReport[] = [];
  for (const name of names) {
    const report = await runEval(build(name), queries, opts.depth);
    reports.push(report);
    console.log("");
    console.log(formatReport(report, { worst: opts.worst }));
  }

  // Every extra retriever is compared against the first one listed.
  for (let i = 1; i < reports.length; i++) {
    console.log("");
    console.log(`delta ${reports[i].retriever} vs ${reports[0].retriever}:`);
    const diffs = compareReports(reports[0], reports[i]);
    if (diffs.length === 0) console.log("  no metric moved beyond tolerance");
    for (const d of diffs) {
      const sign = d.delta > 0 ? "+" : "";
      console.log(
        `  ${d.metric.padEnd(8)} ${(d.before * 100).toFixed(1)}% → ${(d.after * 100).toFixed(1)}%  (${sign}${(d.delta * 100).toFixed(1)} pts)`,
      );
    }
  }

  const last = reports[reports.length - 1];
  if (opts.save) {
    // Metrics only by default. The per-query results list every auto-derived
    // query, which is every note's description in the vault: a report meant
    // to be committed as a baseline must not carry the vault's contents.
    const toSave = opts.saveFull ? last : { retriever: last.retriever, overall: last.overall, bySource: last.bySource, queries: last.results.length };
    await writeFile(opts.save, JSON.stringify(toSave, null, 2) + "\n", "utf8");
    console.log(`\nreport saved: ${opts.save}${opts.saveFull ? " (with per-query results)" : " (metrics only)"}`);
  }

  if (opts.baseline) {
    const baseline = JSON.parse(await readFile(opts.baseline, "utf8")) as EvalReport;
    const worse = compareReports(baseline, last).filter((d) => d.delta < 0);
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
