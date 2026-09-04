// The tokenization ablation: the pre-fix lexical configuration (no stopwords,
// prefix and fuzzy matching on every term) against the shipped one, on the
// same vault and golden set. This is the "+30 points from a tokenizer rule"
// claim, reproducible.
//
// Usage: node scripts/bm25-naive-baseline.mjs [vaultPath] [goldenPath]
import MiniSearch from "minisearch";

const VAULT = process.argv[2] ?? "./vault";
const GOLDEN = process.argv[3] ?? "eval/golden-aios.json";
const core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const R = await import(new URL("../packages/retrieval/dist/index.js", import.meta.url).href);
const E = await import(new URL("../packages/eval/dist/index.js", import.meta.url).href);

const notes = await core.loadVault(VAULT);
const queries = [...(await E.loadGoldenSet(GOLDEN)).queries, ...E.deriveAutoQueries(notes)];

function naiveRetriever(notes) {
  const ms = new MiniSearch({
    fields: ["id", "slugWords", "description", "body"],
    storeFields: ["id", "description", "relPath"],
    searchOptions: { boost: { id: 3, slugWords: 3, description: 2 }, prefix: true, fuzzy: 0.2 },
  });
  const seen = new Set();
  const docs = [];
  for (const n of notes) {
    const id = core.noteName(n);
    if (seen.has(id)) continue;
    seen.add(id);
    docs.push({ id, slugWords: id.replace(/[_-]+/g, " "), description: String(n.frontmatter.description ?? ""), body: n.body, relPath: n.relPath });
  }
  ms.addAll(docs);
  return {
    name: "bm25-naive",
    search: (q, k = 8) => ms.search(q).slice(0, k).map((h) => ({ name: h.id, description: h.description, path: h.relPath, score: h.score })),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`${notes.length} notes, ${queries.length} queries\n`);
for (const [label, r] of [
  ["bm25 naive (no stopwords, prefix+fuzzy on every term)", naiveRetriever(notes)],
  ["bm25 shipped (stopwords, prefix ≥5 chars, fuzzy ≥6 chars)", R.bm25Retriever(notes)],
]) {
  const rep = await E.runEval(r, queries, 10);
  console.log(label);
  for (const k of ["curated", "oblique", "auto"]) {
    const s = rep.bySource[k];
    if (!s) continue;
    console.log(`  ${k.padEnd(8)} n=${String(s.queries).padStart(3)}  hit@1 ${pct(s.hit1).padStart(6)}  hit@3 ${pct(s.hit3).padStart(6)}  recall@5 ${pct(s.recall5).padStart(6)}  MRR ${s.mrr.toFixed(3)}`);
  }
}
