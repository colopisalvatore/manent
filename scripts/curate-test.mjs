// Curation: near-duplicates and contradictions, reported and never resolved.
// The invariant under test: what the tool says is checkable without
// understanding the notes — a pair is alike, a disagreement was declared, a
// superseded note is still active — and nothing it finds changes a file.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadVault } from "../packages/core/dist/index.js";
import { contradictions, duplicates, DEFAULT_LEXICAL_THRESHOLD } from "../packages/curate/dist/index.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "manent-curate-"));
const vault = join(root, "vault");
await mkdir(join(vault, "memory"), { recursive: true });
const note = (name, fm, body) =>
  writeFile(join(vault, "memory", `${name}.md`), `---\nname: ${name}\n${fm}\n---\n\n${body}\n`, "utf8");

// The paragraph two notes share, long enough to make word triples that mean something.
const SHARED = `Il backup gira alle tre di notte, incrementale sul giorno prima, con un dump completo
la domenica. Lo snapshot copre il database e la cartella degli allegati, non copre la cache dei
vettori ne i file temporanei, che si ricostruiscono da soli. Il ripristino va provato e non
dedotto: una volta al mese si monta l ultimo archivio su una macchina di prova e si conta il
numero di righe delle tabelle principali.`;

await note("backup-notturno", "description: come gira il backup notturno e cosa non copre\ntype: reference", SHARED);
// The same text, one paragraph added: a copy that grew, which is what containment catches.
await note(
  "backup-notturno-esteso",
  "description: il backup notturno, con la parte sul ripristino\ntype: reference",
  `${SHARED}\n\nDa gennaio l archivio viene anche copiato fuori sede, e la copia fuori sede e quella
che vale in caso di incendio della sala macchine.`,
);
// Same subject, different words: lexically far, and that is the point of --dense.
await note(
  "restore-provato",
  "description: perche un backup mai ripristinato non e una copia\ntype: feedback",
  "Un archivio che nessuno ha mai riaperto e una speranza.\n\n**Why:** il ripristino e l unica prova.\n\n**How to apply:** provalo ogni mese.",
);
// A short note that shares vocabulary with a long one: the size guard must keep
// it out, or every stub would be a duplicate of the longest note in the vault.
await note("backup-stub", "description: nota breve sul backup\ntype: reference", "Il backup gira alle tre di notte.");

// Two notes that link to each other are somebody's decision already.
await note("pool-a", "description: la pool del database si esaurisce sotto carico\ntype: reference", `${SHARED}\n\nVedi [[pool-b]].`);
await note("pool-b", "description: la pool del database si esaurisce sotto carico, seconda nota\ntype: reference", SHARED);

// Contradictions, in all three shapes the report knows.
await note("prezzo-nuovo", "description: il prezzo di listino dal 2026\ntype: reference\ncontradicts: [prezzo-vecchio]", "Listino 2026: quaranta euro.");
await note("prezzo-vecchio", "description: il prezzo di listino fino al 2025\ntype: reference\ncontradicts: [prezzo-nuovo]", "Listino 2025: trenta euro.");
await note("orario-nuovo", "description: gli orari di apertura aggiornati\ntype: reference\ncontradicts: [orario-vecchio]", "Aperto 12-15.");
await note("orario-vecchio", "description: gli orari di apertura come erano prima\ntype: reference", "Aperto 12-16.");
await note("fantasma", "description: nota che contraddice una nota che non esiste\ntype: reference\ncontradicts: [mai-scritta]", "Contraddice il vuoto.");
await note("recipe-v2", "description: la ricetta di deploy attuale\ntype: reference\nsupersedes: [recipe-v1]", "Push, hook, checkout.");
await note("recipe-v1", "description: la ricetta di deploy di prima\ntype: reference", "Copia a mano e riavvia.");
await note("recipe-v0", "description: la ricetta di deploy originale, gia deprecata\ntype: reference\nstatus: deprecated", "Scp e preghiera.");
await note("recipe-v2b", "description: variante della ricetta attuale che sostituisce la v0\ntype: reference\nsupersedes: [recipe-v0]", "Push e hook, variante.");

const notes = await loadVault(vault);

console.log("── near-duplicates, lexical ──");
const pairs = duplicates(notes);
const has = (a, b) => pairs.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
ok("the copy that grew is found", has("backup-notturno", "backup-notturno-esteso"), pairs.map((p) => `${p.a}~${p.b}`).join(" "));
ok("the pairs are ordered, most alike first", pairs.every((p, i) => i === 0 || pairs[i - 1].score >= p.score));
ok("a short note sharing vocabulary is not a duplicate of a long one", !has("backup-stub", "backup-notturno-esteso"));
ok("two one-line notes sharing a phrase are not a pair", !has("recipe-v1", "recipe-v0") && !has("recipe-v2", "recipe-v0"));
ok("the same subject in different words is not found lexically", !has("backup-notturno", "restore-provato"));
ok("notes that already link to each other are left out", !has("pool-a", "pool-b"));
ok("--include-related brings them back", duplicates(notes, { includeRelated: true }).some((p) => p.a === "pool-a" || p.b === "pool-a"));
ok("the default threshold is the measured one", DEFAULT_LEXICAL_THRESHOLD === 0.25);
ok("a threshold of 1 reports nothing", duplicates(notes, { threshold: 1 }).length === 0);
ok("every pair carries the facts a person decides with", pairs.every((p) => p.aPath && p.bPath && p.method === "lexical"));

console.log("\n── contradictions ──");
const rows = contradictions(notes);
const row = (kind, a) => rows.find((r) => r.kind === kind && r.a === a);
ok("a mutual disagreement is one row, not two", rows.filter((r) => r.kind === "declared").length === 1);
ok("it names both notes", !!row("declared", "prezzo-nuovo") || !!row("declared", "prezzo-vecchio"));
ok("a one-sided declaration is reported as such", !!row("one-sided", "orario-nuovo"), JSON.stringify(rows.map((r) => `${r.kind}:${r.a}`)));
ok("contradicting a note that does not exist is reported", row("one-sided", "fantasma")?.message.includes("not a note in this vault") === true);
ok("a superseded note left active is reported", !!row("superseded", "recipe-v2"));
ok("a superseded note already deprecated is not", !row("superseded", "recipe-v2b"));
ok("declared comes before one-sided, which comes before superseded", rows.map((r) => r.kind).join(",") === "declared,one-sided,one-sided,superseded", rows.map((r) => r.kind).join(","));

console.log("\n── the CLI, and the vault it must not touch ──");
const before = await Promise.all(notes.map(async (n) => `${n.relPath}:${(await readFile(n.path, "utf8")).length}`));
const out = await run("node", [cli, "curate", vault, "--json"]);
const report = JSON.parse(out.stdout);
ok("the json carries both reports", Array.isArray(report.duplicates) && Array.isArray(report.contradictions));
ok("it matches the library", report.duplicates.length === pairs.length && report.contradictions.length === rows.length);
const text = await run("node", [cli, "curate", vault, "--duplicates"]);
ok("the text report says nothing is merged", text.stdout.includes("nothing here is merged"));
const after = await Promise.all(notes.map(async (n) => `${n.relPath}:${(await readFile(n.path, "utf8")).length}`));
ok("no note changed", before.join("|") === after.join("|"));
const bad = await run("node", [cli, "curate", vault, "--threshold", "2"]).catch((e) => e);
ok("a threshold outside (0, 1] is refused", bad.code === 1 && bad.stderr.includes("--threshold must be a similarity"), String(bad.stderr).trim());

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall curate tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
