// Re-indexing under writes: the embedding cache must survive a restart, and a
// write must cost the note it touched — never the vault, never the caller's wait.
//
// Production (08/10/2026, 1351 notes, 5 agents writing): every write during the
// warmup started a full-vault embedding of its own, in parallel; each write
// waited for its embedding before committing, so calls took 5-40 minutes; and
// the cache file, rewritten in place, came back unreadable after the restart —
// "1351 notes embedded, 0 cached". These checks fail on that code.
//
// A fake embedding model stands in for the real one: it counts what it is asked
// to embed and can be held, which is what these properties are about.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrainContext } from "../packages/server/dist/context.js";
import { findTool } from "../packages/server/dist/tools.js";

const NOTES = 40;

/** Deterministic unit vectors from the text, so cached and fresh vectors agree. */
function fakeModel({ delayMs = 0 } = {}) {
  const model = {
    id: "fake/e5-test",
    dimensions: 8,
    passages: 0,
    gate: undefined,
    async embed(texts, kind) {
      if (kind === "passage") model.passages += texts.length;
      // Held only for passages: a query still gets embedded, as a real server's would.
      if (model.gate && kind === "passage") await model.gate;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return texts.map((t) => {
        const h = createHash("sha256").update(`${t}`).digest();
        const v = Float32Array.from({ length: 8 }, (_, i) => h[i] - 128);
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
  return model;
}

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), "manent-reindex-"));
  await mkdir(join(root, "memory"), { recursive: true });
  for (let i = 0; i < NOTES; i++) {
    await writeFile(
      join(root, "memory", `nota-${i}.md`),
      `---\nname: nota-${i}\ndescription: nota numero ${i} sul deploy\ntype: reference\n---\ncorpo della nota ${i}\n`,
      "utf8",
    );
  }
  return root;
}

const write = (ctx, name, body) =>
  findTool("brain_write").run({ name, dir: "memory", type: "reference", description: `nota ${name}`, body }, ctx);

// ── child: a server that writes during its warmup, then stops like on SIGTERM ──
if (process.argv[2] === "child") {
  const root = process.argv[3];
  const model = fakeModel({ delayMs: 50 });
  const ctx = await loadBrainContext(root, { retriever: "fused", writable: true, confirmWrites: false, embeddingModel: model });
  // Lands while the warmup is embedding the vault.
  await new Promise((r) => setTimeout(r, 30));
  await write(ctx, "scritta-durante-warmup", "scritta mentre il modello scaldava");
  await ctx.ready;
  console.log(JSON.stringify({ passages: model.passages }));
  // The CLI's SIGTERM path: close, then exit — whatever is still in flight dies.
  await ctx.close();
  process.exit(0);
}

// ── child: re-indexes after a write, and is killed halfway through saving the cache ──
if (process.argv[2] === "churn") {
  const root = process.argv[3];
  // A slow disk, or a big file: the second save stops after half the bytes,
  // and the parent kills the process right there.
  const fs = createRequire(import.meta.url)("node:fs");
  const realWriteFile = fs.promises.writeFile;
  let saves = 0;
  const half = (data) => String(data).slice(0, Math.floor(String(data).length / 2));
  const stall = async () => {
    console.log("midwrite");
    await new Promise(() => {});
  };
  // Both ways a file gets written: by path, and through an open handle.
  fs.promises.writeFile = async (path, data, ...rest) => {
    if (++saves === 1) return realWriteFile(path, data, ...rest);
    fs.writeFileSync(path, half(data));
    await stall();
  };
  const probe = await fs.promises.open(join(root, ".probe"), "w");
  const handleProto = Object.getPrototypeOf(probe);
  await probe.close();
  fs.unlinkSync(join(root, ".probe"));
  const realHandleWrite = handleProto.writeFile;
  handleProto.writeFile = async function (data, ...rest) {
    if (++saves === 1) return realHandleWrite.call(this, data, ...rest);
    fs.writeSync(this.fd, half(data));
    await stall();
  };
  syncBuiltinESMExports();
  const { buildDenseIndex } = await import("../packages/retrieval/dist/index.js");
  const model = fakeModel();
  const notes = Array.from({ length: NOTES }, (_, i) => ({
    relPath: `memory/nota-${i}.md`,
    frontmatter: { name: `nota-${i}`, description: `nota ${i}` },
    body: `corpo ${i}`,
    links: [],
  }));
  const first = await buildDenseIndex(notes, model, { root });
  notes[0] = { ...notes[0], body: "corpo riscritto" };
  await buildDenseIndex(notes, model, { root, previous: first });
}

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const within = (p, ms) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

console.log("── restart ──");
{
  const root = await makeVault();
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", root], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => {});
    child.on("exit", () => resolve(stdout));
  });
  const first = JSON.parse(out.trim().split("\n").pop() || "{}");
  ok(
    "a write during warmup does not start a second full-vault embedding",
    first.passages <= NOTES + 1,
    `${first.passages} passages embedded for ${NOTES + 1} notes`,
  );

  let cacheOk = true;
  try {
    JSON.parse(await readFile(join(root, ".manent", "embeddings.json"), "utf8"));
  } catch {
    cacheOk = false;
  }
  ok("the cache file is whole after the stop", cacheOk);

  const model = fakeModel();
  const lines = [];
  const log = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  const ctx = await loadBrainContext(root, { retriever: "fused", warmup: "blocking", embeddingModel: model });
  console.error = log;
  ok("the second start embeds nothing: every note comes from the cache", model.passages === 0, `${model.passages} passages embedded · ${lines.find((l) => l.includes("ready")) ?? ""}`);
  await ctx.close();
  await rm(root, { recursive: true, force: true });
}

console.log("\n── stop mid-write ──");
{
  const root = await mkdtemp(join(tmpdir(), "manent-churn-"));
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "churn", root], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (d) => {
      if (String(d).includes("midwrite")) child.kill("SIGKILL");
    });
    child.on("exit", resolve);
  });
  let cached = -1;
  try {
    cached = Object.keys(JSON.parse(await readFile(join(root, ".manent", "embeddings.json"), "utf8")).notes).length;
  } catch {
    /* truncated */
  }
  ok("a process stopped while saving the cache leaves the previous one whole", cached === NOTES, cached < 0 ? "unreadable" : `${cached} notes cached`);
  await rm(root, { recursive: true, force: true });
}

console.log("\n── write ──");
{
  const root = await makeVault();
  const model = fakeModel();
  const ctx = await loadBrainContext(root, { retriever: "fused", writable: true, confirmWrites: false, warmup: "blocking", embeddingModel: model });
  const afterWarmup = model.passages;
  ok("warmup embeds the vault once", afterWarmup === NOTES, `${afterWarmup} passages`);

  // Hold the model: the write must come back anyway.
  let release;
  model.gate = new Promise((r) => (release = r));
  const res = write(ctx, "nota-nuova", "il backup notturno gira con rsync alle tre");
  const returned = await within(res, 2000);
  ok("a write returns while its embedding is still running", returned);
  if (returned) {
    const body = JSON.parse((await res).content[0].text);
    ok("the write landed", body.ok === true, body.relPath);
    // Fake vectors are noise, so the dense list outranks it here: what matters is that it is found.
    const hit = (await ctx.retriever.search("backup notturno rsync", 100)).find((h) => h.name === "nota-nuova");
    ok("the written note is served at once, before its embedding lands", hit?.via === "lex", hit ? `via=${hit.via}` : "not found");
  }
  release();
  model.gate = undefined;
  await (ctx.settled?.() ?? res);
  ok("a write re-embeds only the note it touched", model.passages - afterWarmup === 1, `${model.passages - afterWarmup} passages`);
  const hits = await ctx.retriever.search("backup notturno rsync", 3);
  ok("and is served semantically once that lands", hits[0]?.name === "nota-nuova" && hits[0]?.via.includes("dense"), hits.map((h) => `${h.name}:${h.via}`).join(" "));

  // The watcher then sees the file the write itself produced.
  const version = ctx.version;
  const stats = await ctx.reload();
  ok(
    "the reload that follows a write finds nothing to redo",
    stats.added + stats.changed + stats.removed === 0 && ctx.version === version,
    `+${stats.added} ~${stats.changed} -${stats.removed}, version ${version} → ${ctx.version}`,
  );

  // An edit made outside the server re-embeds that note alone.
  const before = model.passages;
  await writeFile(
    join(root, "memory", "nota-3.md"),
    `---\nname: nota-3\ndescription: nota numero 3, riscritta a mano\ntype: reference\n---\naltro corpo\n`,
    "utf8",
  );
  const edited = await ctx.reload();
  await ctx.settled?.();
  ok("an outside edit reloads one note and re-embeds one", edited.changed === 1 && model.passages - before === 1, `~${edited.changed}, ${model.passages - before} passages`);

  // A file rewritten under another name must not leave its old name behind.
  const old = ctx.notes.find((n) => n.relPath === "memory/nota-5.md");
  await ctx.applyWrite({ ...old, body: "ricetta con zafferano" });
  await ctx.applyWrite({ ...old, frontmatter: { ...old.frontmatter, name: "rinominata", description: "nota rinominata" }, body: "altro" });
  await ctx.settled();
  const names = (await ctx.retriever.search("zafferano", 100)).map((h) => h.name);
  ok("a note renamed in place leaves no stale entry behind", !names.includes("nota-5"), names.includes("nota-5") ? "nota-5 still served for its old text" : "");

  await ctx.close();
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall reindex tests passed" : `\n${failures} FAILURES`);
if (failures > 0) process.exitCode = 1;
