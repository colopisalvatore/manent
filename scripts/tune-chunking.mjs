// Does splitting notes into passages actually help? Sweeps chunk size, the
// contextual prefix and the per-note aggregation, against embedding each note as
// a single passage. Query embeddings are computed once and reused.
const VAULT = process.argv[2] ?? process.env.MANENT_VAULT;
if (!VAULT) throw new Error("pass a vault path as the first argument or set MANENT_VAULT");
const GOLDEN = process.argv[3] ?? "eval/golden-aios.json";
const CACHE = ".manent/tune-embeddings.json"; // keep the served cache untouched

const core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const R = await import(new URL("../packages/retrieval/dist/index.js", import.meta.url).href);
const E = await import(new URL("../packages/eval/dist/index.js", import.meta.url).href);

const notes = await core.loadVault(VAULT);
const queries = [...(await E.loadGoldenSet(GOLDEN)).queries, ...E.deriveAutoQueries(notes)];

const model = await R.loadLocalEmbeddingModel();
const texts = queries.map((q) => q.query);
const qvecs = await model.embed(texts, "query");
const qcache = new Map(texts.map((t, i) => [t, qvecs[i]]));
const cachedModel = {
  id: model.id,
  dimensions: model.dimensions,
  async embed(inputs, kind) {
    if (kind === "query" && inputs.length === 1 && qcache.has(inputs[0])) return [qcache.get(inputs[0])];
    return model.embed(inputs, kind);
  },
};

const CHUNKINGS = [
  { label: "single 1400 (default)", chunking: { maxChars: 1400, overlapChars: 150, contextPrefix: true, maxPassages: 1 } },
  { label: "single 900", chunking: { maxChars: 900, overlapChars: 150, contextPrefix: true, maxPassages: 1 } },
  { label: "single full body", chunking: { maxChars: 100_000, overlapChars: 0, contextPrefix: true, maxPassages: 1 } },
  { label: "chunks 1000 all", chunking: { maxChars: 1000, overlapChars: 150, contextPrefix: true, maxPassages: 0 } },
  { label: "chunks 1400 first 3", chunking: { maxChars: 1400, overlapChars: 150, contextPrefix: true, maxPassages: 3 } },
];
const AGGREGATIONS = [
  { label: "max", dense: { aggregation: "max" } },
  { label: "max-norm", dense: { aggregation: "max-norm", lengthPenalty: 0.02 } },
  { label: "mean2", dense: { aggregation: "mean2" } },
];

const rows = [];
for (const c of CHUNKINGS) {
  const dense = await R.buildDenseIndex(notes, cachedModel, {
    root: VAULT,
    cachePath: CACHE,
    chunking: c.chunking,
  });
  const passages = dense.chunks.length;
  const aggs = c.chunking.maxPassages === 1 ? [AGGREGATIONS[0]] : AGGREGATIONS;
  for (const a of aggs) {
    const r = await E.runEval(R.fusedRetriever(notes, dense, { dense: a.dense }), queries, 10);
    rows.push({
      label: `${c.label} / ${a.label}`,
      passages,
      cHit1: r.bySource.curated.hit1,
      cMrr: r.bySource.curated.mrr,
      oMrr: r.bySource.oblique?.mrr ?? 0,
      oRec5: r.bySource.oblique?.recall5 ?? 0,
      aHit1: r.bySource.auto.hit1,
      oaMrr: r.overall.mrr,
    });
    process.stdout.write(".");
  }
}
console.log("\n");

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log("  passages  curated          oblique          auto     overall");
console.log("            hit@1   MRR      MRR    rec@5     hit@1    MRR     configuration (all fused lex1:dense2)");
for (const r of rows.sort((a, b) => b.cMrr - a.cMrr || b.oMrr - a.oMrr)) {
  console.log(
    `  ${String(r.passages).padStart(6)}    ${pct(r.cHit1).padStart(6)} ${r.cMrr.toFixed(3)}   ${r.oMrr.toFixed(3)} ${pct(r.oRec5).padStart(6)}   ${pct(r.aHit1).padStart(6)}  ${r.oaMrr.toFixed(3)}   ${r.label}`,
  );
}
