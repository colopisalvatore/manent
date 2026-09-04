// Where to put the gap register's grouping threshold: cosine similarity of
// query embeddings for paraphrase pairs, unrelated pairs, and "same topic,
// different question" pairs. The default threshold must sit between the
// highest unrelated score and the lowest paraphrase score.
//
// Usage: node scripts/gaps-threshold.mjs [modelId]
const R = await import(new URL("../packages/retrieval/dist/index.js", import.meta.url).href);
const { DEFAULT_GAP_THRESHOLD } = await import(new URL("../packages/server/dist/gaps.js", import.meta.url).href);
const model = await R.loadLocalEmbeddingModel({ modelId: process.argv[2] });

const PAIRS = [
  ["come si fa un ordine dal tavolo", "ordinare dal tavolo, come si fa?", "paraphrase"],
  ["prenotare un tavolo per due", "voglio riservare un posto per cena in due", "paraphrase"],
  ["il cron di cpanel non parte", "cpanel non esegue il comando schedulato", "paraphrase"],
  ["quanto costa la pizza margherita", "prezzo della margherita", "paraphrase"],
  ["come collego claude.ai al server mcp", "connettere un connector mcp a claude", "paraphrase"],
  ["come si fa un ordine dal tavolo", "quanto costa la pizza margherita", "unrelated"],
  ["prenotare un tavolo per due", "il cron di cpanel non parte", "unrelated"],
  ["orari di apertura del locale", "menu senza glutine disponibile?", "unrelated"],
  ["come pago con carta", "come si fa un ordine dal tavolo", "unrelated"],
  ["allergeni della carbonara", "ingredienti della carbonara", "near"],
  ["orari di apertura", "siete aperti a pranzo?", "near"],
];

const by = { paraphrase: [], unrelated: [], near: [] };
console.log(`model: ${model.id}\n`);
for (const [a, b, kind] of PAIRS) {
  const [va, vb] = await model.embed([a, b], "query");
  const sim = R.cosine(va, vb);
  by[kind].push(sim);
  console.log(`${kind.padEnd(10)} ${sim.toFixed(3)}  ${a}  <>  ${b}`);
}
const range = (xs) => `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}`;
console.log(`\nparaphrase ${range(by.paraphrase)}   unrelated ${range(by.unrelated)}   near ${range(by.near)}`);
console.log(`default threshold ${DEFAULT_GAP_THRESHOLD}`);
