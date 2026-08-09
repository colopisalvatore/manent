// End-to-end smoke: init a vault, lint it, search it.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const CLI = "packages/cli/dist/index.js";
const VAULT = ".smoke-vault";

rmSync(VAULT, { recursive: true, force: true });

execFileSync("node", [CLI, "init", VAULT], { stdio: "inherit" });
execFileSync("node", [CLI, "lint", VAULT], { stdio: "inherit" });

const core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const { hybridRetriever } = await import(
  new URL("../packages/retrieval/dist/index.js", import.meta.url).href
);

const notes = await core.loadVault(VAULT);
const graph = core.buildGraph(notes);
const hits = hybridRetriever({ notes, graph }).search("example lesson feedback");
if (hits.length === 0) throw new Error("smoke FAILED: search returned 0 hits");

console.log(`smoke OK — ${notes.length} notes, top hit: ${hits[0].name} (via ${hits[0].via})`);
