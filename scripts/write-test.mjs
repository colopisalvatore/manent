// The write tools, and above all the things they must refuse.
//
// Path containment is a security property, not a nicety: a note name reaches
// these tools from a model, which may be repeating what a web page told it. The
// traversal cases below are the regression guard on that.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrainContext } from "../packages/server/dist/context.js";
import { findTool, toolsFor } from "../packages/server/dist/tools.js";

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "manent-write-"));
await writeFile(
  join(root, "seed.md"),
  ["---", "name: seed", "description: nota di partenza", "type: reference", "---", "corpo iniziale", ""].join("\n"),
  "utf8",
);
await mkdir(join(root, "memory"), { recursive: true });

const call = (ctx, tool, args) => findTool(tool).run(args, ctx);
const ro = await loadBrainContext(root, {});
const rw = await loadBrainContext(root, { writable: true });

console.log("── gate ──");
ok("read-only server hides the write tools", !toolsFor(ro).some((t) => t.requiresWrite));
ok("writable server lists them", toolsFor(rw).filter((t) => t.requiresWrite).length === 2);
ok(
  "run is gated even when unlisted",
  (await call(ro, "brain_write", { name: "x", description: "d", type: "reference", body: "b" })).isError === true,
);

console.log("\n── writes ──");
const created = await call(rw, "brain_write", {
  name: "nota-test",
  description: "una nota di prova",
  type: "feedback",
  body: "# Titolo\ncorpo",
  dir: "memory",
});
ok("create writes the note", !created.isError && created.content[0].text.includes("memory/nota-test.md"));
ok(
  "create refuses to clobber",
  (await call(rw, "brain_write", { name: "nota-test", description: "d", type: "feedback", body: "b", dir: "memory" }))
    .isError === true,
);
ok(
  "overwrite is explicit and allowed",
  !(await call(rw, "brain_write", {
    name: "nota-test",
    description: "aggiornata",
    type: "feedback",
    body: "nuovo corpo",
    dir: "memory",
    mode: "overwrite",
  })).isError,
);
ok("append leaves frontmatter alone", !(await call(rw, "brain_append", { name: "seed", body: "riga aggiunta" })).isError);
const seed = await readFile(join(root, "seed.md"), "utf8");
ok("appended body kept the original text", seed.includes("corpo iniziale") && seed.includes("riga aggiunta"));
ok("appended note kept its type", seed.includes("type: reference"));

console.log("\n── refusals: containment ──");
for (const [label, args] of [
  ["dir traversal", { dir: "../../evil" }],
  ["name as a path", { name: "../../../evil" }],
  ["absolute dir", { dir: "C:/Windows/Temp" }],
  ["forbidden secrets/", { dir: "secrets" }],
  ["name with a separator", { name: "memory/evil" }],
]) {
  const res = await call(rw, "brain_write", {
    name: "evil",
    description: "d",
    type: "reference",
    body: "b",
    ...args,
  });
  ok(`refused: ${label}`, res.isError === true);
}

console.log("\n── refusals: spec ──");
ok(
  "refused: unknown type",
  (await call(rw, "brain_write", { name: "bad1", description: "d", type: "banana", body: "b" })).isError === true,
);
ok(
  "refused: empty description",
  (await call(rw, "brain_write", { name: "bad2", description: "   ", type: "reference", body: "b" })).isError === true,
);
ok(
  "refused: append to a missing note",
  (await call(rw, "brain_append", { name: "does-not-exist", body: "b" })).isError === true,
);

console.log("\n── the write is visible at once ──");
ok("brain_read sees it", !(await call(rw, "brain_read", { name: "nota-test" })).isError);
ok(
  "brain_search indexes it",
  (await call(rw, "brain_search", { query: "nuovo corpo", k: 3 })).content[0].text.includes("nota-test"),
);

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall write tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
