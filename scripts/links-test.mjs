// Wikilink resolution: the vault is edited in Obsidian (links by file name and
// by path) and read by Manent (identity = canonical `name`). These cases are the
// disagreements between the two, taken from the AIOS brain: `[[moc/syf]]` for a
// note named `moc-syf` in `moc/syf.md`, and `[[../relazioni/denise]]` written
// from a note two directories away.
import { buildGraph, buildLinkIndex, resolveLink } from "../packages/core/dist/index.js";
import { lintVault } from "../packages/lint/dist/index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const note = (relPath, name, body = "") => ({
  path: `/vault/${relPath}`,
  relPath,
  frontmatter: { name, description: "d", type: "reference" },
  body,
  links: [...body.matchAll(/\[\[([^\]|#\n]+)(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1].trim()),
});

const notes = [
  note("HOME.md", "home", "[[moc/syf|SYF]] [[moc/aios]] [[denise]] [[voice/singola_Magda]]"),
  note("moc/syf.md", "moc-syf"),
  note("moc/aios.md", "moc-aios"),
  note("relazioni/denise.md", "denise"),
  note("voice/singola_Magda.md", "singola-magda"),
  note(
    "personal/psicoterapia/2026-08-18-denise.md",
    "2026-08-18-denise",
    "[[../../relazioni/denise]] [[../../profilo/nessuno]] [[note-mai-scritta]]",
  ),
  // stesso file name in due cartelle: risolvere per stem sarebbe una scommessa
  note("a/duplicato.md", "a-duplicato"),
  note("b/duplicato.md", "b-duplicato"),
  // stesso file name, ma uno dei due e nella cartella di chi linka
  note("profilo/famiglia.md", "profilo-famiglia"),
  note("voice/famiglia.md", "voice-famiglia"),
  note("profilo/second_person.md", "second-person", "[[famiglia]]"),
];

const index = buildLinkIndex(notes);
const from = "personal/psicoterapia/2026-08-18-denise.md";

ok("nome canonico esatto", resolveLink(index, "denise", "HOME.md") === "denise");
ok("percorso dalla radice", resolveLink(index, "moc/syf", "HOME.md") === "moc-syf");
ok("percorso con estensione", resolveLink(index, "moc/syf.md", "HOME.md") === "moc-syf");
ok("percorso relativo con ../", resolveLink(index, "../../relazioni/denise", from) === "denise");
ok("percorso relativo con ./", resolveLink(index, "./nessuno", from) === undefined);
ok("file name da un'altra cartella", resolveLink(index, "singola_Magda", "HOME.md") === "singola-magda");
ok("nome canonico ha la precedenza sul percorso", resolveLink(index, "moc-syf", "HOME.md") === "moc-syf");
ok("target inesistente resta irrisolto", resolveLink(index, "note-mai-scritta", from) === undefined);
ok("file name ambiguo resta irrisolto", resolveLink(index, "duplicato", "HOME.md") === undefined);
ok(
  "file name ambiguo risolto dalla cartella di chi linka",
  resolveLink(index, "famiglia", "profilo/second_person.md") === "profilo-famiglia",
);
ok(
  "file name ambiguo da una cartella terza resta irrisolto",
  resolveLink(index, "famiglia", "HOME.md") === undefined,
);
ok("target vuoto", resolveLink(index, "   ", "HOME.md") === undefined);

// il grafo deve indicizzare per nome canonico anche quando il link e un percorso
const graph = buildGraph(notes);
const targets = graph.edges.filter((e) => e.from === "home").map((e) => e.to).sort();
ok(
  "archi del grafo normalizzati al nome canonico",
  JSON.stringify(targets) === JSON.stringify(["denise", "moc-aios", "moc-syf", "singola-magda"]),
  targets.join(","),
);

// e il lint non deve piu chiamarli rotti: stesso resolver, stessa risposta
const dir = await mkdtemp(join(tmpdir(), "manent-links-"));
try {
  await mkdir(join(dir, "moc"), { recursive: true });
  await writeFile(
    join(dir, "HOME.md"),
    "---\nname: home\ndescription: hub\ntype: moc\n---\n[[moc/syf|SYF]] [[mai-scritta]]\n",
    "utf8",
  );
  await writeFile(
    join(dir, "moc", "syf.md"),
    "---\nname: moc-syf\ndescription: ramo\ntype: moc\n---\ncorpo\n",
    "utf8",
  );
  const result = await lintVault(dir);
  const unresolved = result.findings.filter((f) => f.rule === "link-unresolved");
  ok("lint: il link a percorso non e piu unresolved", !unresolved.some((f) => f.message.includes("moc/syf")));
  ok(
    "lint: il link davvero mancante resta segnalato",
    unresolved.some((f) => f.message.includes("mai-scritta")),
    unresolved.map((f) => f.message).join(" | "),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll link resolution tests passed." : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
