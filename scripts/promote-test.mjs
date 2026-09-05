// Promotion: the review queue and the one move that takes a note out of
// quarantine. The invariant under test: nothing leaves quarantine except by a
// person naming it, and when it does, status, audience, folder and the commit
// message move together — or, on a refusal, nothing moves at all.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadVault, promoteNote, reviewQueue } from "../packages/core/dist/index.js";
import { lintVault } from "../packages/lint/dist/index.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
/** A refusal is the expected answer here, so it is captured, not thrown. */
const refusal = async (p) => p.then(() => "", (err) => err.message);

const root = await mkdtemp(join(tmpdir(), "manent-promote-"));
const vault = join(root, "vault");
await mkdir(join(vault, "quarantine", "tech"), { recursive: true });
await mkdir(join(vault, "quarantine", "product"), { recursive: true });
await mkdir(join(vault, "memory"), { recursive: true });

const note = (rel, fm, body) => writeFile(join(vault, rel), `---\n${fm}\n---\n${body}\n`, "utf8");
await note(
  "quarantine/tech/deploy-recipe.md",
  "name: deploy-recipe\ndescription: come si mette il server dietro systemd\ntype: reference\nstatus: quarantine\nauthor: tech\naudience: [private]\ncreated: 2026-08-20",
  "unit file, restart on failure, log su journald. vedi [[runbook]]",
);
await note(
  "quarantine/tech/cache-warmup.md",
  "name: cache-warmup\ndescription: perche l indice si costruisce prima di aprire la porta\ntype: reference\nstatus: quarantine\nauthor: tech\ncreated: 2026-09-01",
  "warmup in background, niente 502 al restart",
);
await note(
  "quarantine/product/menu-note.md",
  "name: menu-note\ndescription: il menu senza glutine del locale\ntype: reference\nstatus: quarantine\nauthor: product\ncreated: 2026-08-28",
  "pizze senza glutine disponibili",
);
await note(
  "memory/runbook.md",
  "name: runbook\ndescription: come si riavvia il servizio in produzione\ntype: reference\nstatus: active\naudience: [tech]\ncreated: 2026-07-01",
  "systemctl restart manent-brain",
);
// A file whose name in frontmatter is not its filename: the destination
// `memory/deploy-recipe.md` is taken without the vault holding two notes
// called `deploy-recipe`.
await note(
  "memory/deploy-recipe.md",
  "name: old-deploy\ndescription: la vecchia ricetta di deploy, sostituita\ntype: reference\nstatus: deprecated\ncreated: 2026-06-01",
  "scp e restart a mano",
);

const now = new Date("2026-09-05T12:00:00Z");

console.log("── the review queue ──");
let queue = await reviewQueue(await loadVault(vault), { now });
ok("only quarantined notes are queued", queue.length === 3, queue.map((e) => e.name).join(","));
ok("oldest first", queue.map((e) => e.name).join(",") === "deploy-recipe,menu-note,cache-warmup", queue.map((e) => e.name).join(","));
ok("age is counted in days from `created`", queue[0].ageDays === 16, String(queue[0].ageDays));
ok("a note with no audience reads as private", queue[1].audience.join() === "private", queue[1].audience.join());
ok("the author travels with the entry", queue[0].author === "tech" && queue[1].author === "product");
ok("--author filters the queue", (await reviewQueue(await loadVault(vault), { now, author: "product" })).length === 1);

console.log("\n── refusals: nothing moves ──");
ok("unknown note", (await refusal(promoteNote(vault, { name: "nope" }))).includes("Note not found"));
ok("a note that is not in quarantine", (await refusal(promoteNote(vault, { name: "runbook" }))).includes("not in quarantine"));
ok(
  "an audience label that is not a slug",
  (await refusal(promoteNote(vault, { name: "cache-warmup", audience: ["../etc"] }))).includes("Illegal audience label"),
);
ok(
  "private alongside another label",
  (await refusal(promoteNote(vault, { name: "cache-warmup", audience: ["private", "tech"] }))).includes("absence of an audience"),
);
ok(
  "a destination that is taken",
  (await refusal(promoteNote(vault, { name: "deploy-recipe", dir: "memory" }))).includes("already there"),
);
ok(
  "a destination outside the vault",
  (await refusal(promoteNote(vault, { name: "cache-warmup", dir: "../outside" }))).includes("Illegal directory segment"),
);
ok("the refused notes are still where they were", existsSync(join(vault, "quarantine", "tech", "cache-warmup.md")));

console.log("\n── dry run ──");
const before = await readFile(join(vault, "quarantine", "tech", "cache-warmup.md"), "utf8");
const dry = await promoteNote(vault, { name: "cache-warmup", audience: ["tech"], dir: "memory", dryRun: true, now });
ok("the file is untouched", (await readFile(join(vault, "quarantine", "tech", "cache-warmup.md"), "utf8")) === before);
ok("the move is not made", !existsSync(join(vault, "memory", "cache-warmup.md")));
ok("the commit message is worked out anyway", dry.commitMessage.startsWith("promote(cache-warmup): out of quarantine"));
ok("it names the author and both audiences", dry.commitMessage.includes("Written by tech on 2026-09-01") && dry.commitMessage.includes("audience: private, now tech"));
ok("it names the move", dry.commitMessage.includes("moved from quarantine/tech/cache-warmup.md to memory/cache-warmup.md"));

console.log("\n── the move ──");
const res = await promoteNote(vault, { name: "cache-warmup", audience: ["tech", "product"], dir: "memory", now });
const promoted = await readFile(join(vault, "memory", "cache-warmup.md"), "utf8");
ok("the note left quarantine", !existsSync(join(vault, "quarantine", "tech", "cache-warmup.md")) && res.moved);
ok("status is active", /^status: active$/m.test(promoted), promoted.slice(0, 200));
ok("audience is what was asked for", /audience:\n\s+- tech\n\s+- product/.test(promoted) || /audience: \[tech, product\]/.test(promoted), promoted.slice(0, 240));
ok("the author is kept", /^author: tech$/m.test(promoted));
ok("`updated` is stamped, `created` untouched", /^updated: '?2026-\d\d-\d\d'?$/m.test(promoted) && /^created: '?2026-09-01'?$/m.test(promoted));
ok("the body survives", promoted.includes("warmup in background, niente 502 al restart"));
ok("git is told about both paths", res.paths.join(",") === "quarantine/tech/cache-warmup.md,memory/cache-warmup.md", res.paths.join(","));

queue = await reviewQueue(await loadVault(vault), { now });
ok("the promoted note is out of the queue", !queue.some((e) => e.name === "cache-warmup") && queue.length === 2);

const lint = await lintVault(vault);
ok("the vault still lints clean", lint.errors === 0, JSON.stringify(lint.findings?.slice(0, 3) ?? []));

console.log("\n── promotion in place, and the CLI ──");
const inPlace = await promoteNote(vault, { name: "menu-note", audience: ["product"], now });
ok("a note promoted where it stands does not move", !inPlace.moved && inPlace.paths.length === 1);
ok("its message says so", !inPlace.commitMessage.includes("moved from"));

await run("git", ["-C", vault, "init", "-q", "-b", "main"]);
await run("git", ["-C", vault, "config", "user.email", "test@example.com"]);
await run("git", ["-C", vault, "config", "user.name", "promote test"]);
await run("git", ["-C", vault, "add", "-A"]);
await run("git", ["-C", vault, "commit", "-qm", "vault"]);

const out = await run("node", [cli, "promote", vault, "--note", "deploy-recipe", "--audience", "tech", "--to", "projects", "--commit"]);
ok("the CLI reports the promotion", out.stdout.includes("promoted deploy-recipe"), out.stdout.split("\n")[0]);
const subject = (await run("git", ["-C", vault, "log", "-1", "--pretty=%s"])).stdout.trim();
const body = (await run("git", ["-C", vault, "log", "-1", "--pretty=%b"])).stdout;
ok("the commit is the promotion", subject === "promote(deploy-recipe): out of quarantine", subject);
ok("its body carries the facts", body.includes("status: quarantine, now active") && body.includes("audience: private, now tech"), body.trim());
const status = (await run("git", ["-C", vault, "status", "--porcelain"])).stdout.trim();
ok("nothing is left staged", status === "", status);
ok("the file is where it was asked to go", existsSync(join(vault, "projects", "deploy-recipe.md")));

const empty = await run("node", [cli, "promote", vault, "--json"]);
ok("the queue empties as notes are promoted", JSON.parse(empty.stdout).length === 0, empty.stdout.trim());

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall promote tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
