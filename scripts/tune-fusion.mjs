// Finds the lexical/dense balance by measurement. Query embeddings are computed
// once and reused across configurations, so the sweep costs one dense pass.
const VAULT = process.argv[2] ?? "./vault";
const GOLDEN = process.argv[3] ?? "eval/golden-aios.json";

const core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const R = await import(new URL("../packages/retrieval/dist/index.js", import.meta.url).href);
const E = await import(new URL("../packages/eval/dist/index.js", import.meta.url).href);

const notes = await core.loadVault(VAULT);
const queries = [...(await E.loadGoldenSet(GOLDEN)).queries, ...E.deriveAutoQueries(notes)];

const model = await R.loadLocalEmbeddingModel();
const dense = await R.buildDenseIndex(notes, model, { root: VAULT });
console.log(`dense index: ${dense.notes} notes / ${dense.chunks.length} passages (${dense.embedded} embedded, ${dense.reused} cached)`);

// Pre-embed every query once.
const texts = queries.map((q) => q.query);
const qvecs = await model.embed(texts, "query");
const cache = new Map(texts.map((t, i) => [t, qvecs[i]]));
const cachedModel = {
  id: model.id,
  dimensions: model.dimensions,
  async embed(inputs, kind) {
    if (kind === "query" && inputs.length === 1 && cache.has(inputs[0])) return [cache.get(inputs[0])];
    return model.embed(inputs, kind);
  },
};
const denseCached = { ...dense, model: cachedModel };

const CONFIGS = [
  { label: "bm25 only", make: () => R.bm25Retriever(notes) },
  { label: "dense only", make: () => R.denseRetriever(denseCached) },
  { label: "fused lex 1 / dense 1", make: () => R.fusedRetriever(notes, denseCached, { lexicalWeight: 1, denseWeight: 1 }) },
  { label: "fused lex 1 / dense 2", make: () => R.fusedRetriever(notes, denseCached, { lexicalWeight: 1, denseWeight: 2 }) },
  { label: "fused lex 1 / dense 3", make: () => R.fusedRetriever(notes, denseCached, { lexicalWeight: 1, denseWeight: 3 }) },
  { label: "fused lex 0.5 / dense 3", make: () => R.fusedRetriever(notes, denseCached, { lexicalWeight: 0.5, denseWeight: 3 }) },
  { label: "fused lex 1 / dense 2, depth 60", make: () => R.fusedRetriever(notes, denseCached, { lexicalWeight: 1, denseWeight: 2, depth: 60 }) },
];

const rows = [];
for (const cfg of CONFIGS) {
  const r = await E.runEval(cfg.make(), queries, 10);
  rows.push({
    label: cfg.label,
    cHit1: r.bySource.curated.hit1,
    cMrr: r.bySource.curated.mrr,
    oMrr: r.bySource.oblique?.mrr ?? 0,
    oRec5: r.bySource.oblique?.recall5 ?? 0,
    aHit1: r.bySource.auto.hit1,
    oaMrr: r.overall.mrr,
  });
  process.stdout.write(".");
}
console.log("\n");

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log("  curated          oblique          auto     overall");
console.log("  hit@1   MRR      MRR    rec@5     hit@1    MRR     configuration");
for (const r of rows.sort((a, b) => b.oaMrr - a.oaMrr)) {
  console.log(
    `  ${pct(r.cHit1).padStart(6)} ${r.cMrr.toFixed(3)}   ${r.oMrr.toFixed(3)} ${pct(r.oRec5).padStart(6)}   ${pct(r.aHit1).padStart(6)}  ${r.oaMrr.toFixed(3)}   ${r.label}`,
  );
}
