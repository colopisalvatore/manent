// Grid search over the hybrid ranking parameters, measured on a real vault.
// Picks defaults with numbers instead of intuition: target = curated MRR,
// constraint = do not lose ground on the auto-derived regression set.
//
// Usage: node scripts/tune-retrieval.mjs [vaultPath] [goldenPath]
const VAULT = process.argv[2] ?? "./vault";
const GOLDEN = process.argv[3] ?? "eval/golden-aios.json";

const core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const { bm25Retriever, hybridRetriever } = await import(
  new URL("../packages/retrieval/dist/index.js", import.meta.url).href
);
const { loadGoldenSet, deriveAutoQueries, runEval } = await import(
  new URL("../packages/eval/dist/index.js", import.meta.url).href
);

const notes = await core.loadVault(VAULT);
const graph = core.buildGraph(notes);
const queries = [...(await loadGoldenSet(GOLDEN)).queries, ...deriveAutoQueries(notes)];

const CONFIGS = [
  { label: "bm25 (lexical only)", retriever: () => bm25Retriever(notes) },
  { label: "graph .5 hub .4 imp .15 rec 365", opts: {} },
  { label: "graph .2 hub .4 imp .15 rec 365", opts: { graphWeight: 0.2 } },
  { label: "graph .2 hub .4 imp 0 rec off", opts: { graphWeight: 0.2, importanceBoost: 0, recencyHalfLifeDays: 0 } },
  { label: "graph .1 hub .4 imp 0 rec off", opts: { graphWeight: 0.1, importanceBoost: 0, recencyHalfLifeDays: 0 } },
  { label: "graph 0 hub .4 imp 0 rec off", opts: { graphWeight: 0, importanceBoost: 0, recencyHalfLifeDays: 0 } },
  { label: "graph 0 hub .4 imp .15 rec 365", opts: { graphWeight: 0 } },
  { label: "graph 0 hub 1 (no penalty) imp 0 rec off", opts: { graphWeight: 0, hubFactor: 1, importanceBoost: 0, recencyHalfLifeDays: 0 } },
  { label: "graph .2 hub .15 imp 0 rec off", opts: { graphWeight: 0.2, hubFactor: 0.15, importanceBoost: 0, recencyHalfLifeDays: 0 } },
  { label: "graph .3 hub .4 imp 0 rec 180", opts: { graphWeight: 0.3, importanceBoost: 0, recencyHalfLifeDays: 180 } },
];

const rows = [];
for (const cfg of CONFIGS) {
  const retriever = cfg.retriever ? cfg.retriever() : hybridRetriever({ notes, graph }, cfg.opts);
  const r = await runEval(retriever, queries, 10);
  rows.push({
    label: cfg.label,
    curatedHit1: r.bySource.curated.hit1,
    curatedMrr: r.bySource.curated.mrr,
    autoHit1: r.bySource.auto.hit1,
    autoMrr: r.bySource.auto.mrr,
    overallMrr: r.overall.mrr,
  });
}

rows.sort((a, b) => b.curatedMrr - a.curatedMrr || b.autoMrr - a.autoMrr);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`\n${notes.length} notes, ${queries.length} queries — sorted by curated MRR\n`);
console.log("  curated              auto");
console.log("  hit@1   MRR      hit@1   MRR     configuration");
for (const r of rows) {
  console.log(
    `  ${pct(r.curatedHit1).padStart(6)} ${r.curatedMrr.toFixed(3)}   ${pct(r.autoHit1).padStart(6)} ${r.autoMrr.toFixed(3)}   ${r.label}`,
  );
}
console.log("\nPick the top row that does not lose auto MRR versus the lexical baseline.");
