// What this repository is allowed to say about a private vault.
//
// The audit that produced this file found one real leak: a golden set that
// named 32 notes of the author's vault, published for weeks. Names are now
// hashed — but a rule that lives only in a commit message comes back the next
// time somebody saves a real run "just to have the numbers". So it lives here,
// in CI, checked against every tracked file.
//
// It is a leak check, not a linter: everything it flags either names a private
// note, points at somebody's disk, or is a credential.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanPii } from "../packages/core/dist/index.js";

let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
const BINARY = /\.(png|jpe?g|gif|pdf|ico|woff2?|zip)$/i;
const text = new Map();
for (const f of tracked) {
  if (BINARY.test(f)) continue;
  try {
    text.set(f, readFileSync(f, "utf8"));
  } catch {
    /* unreadable: nothing to leak from here */
  }
}
const hits = (re, skip = () => false) =>
  [...text].flatMap(([f, t]) => (skip(f) ? [] : (t.match(re) ?? []).map((m) => `${f}: ${m}`)));

console.log(`── ${text.size} tracked text files ──`);

// 1. Note names of a real vault. The fixture vault is invented, so its own
//    names are fine; everywhere else a `feedback_*` / `project_*` slug is the
//    index of somebody's private archive.
const isFixture = (f) => f.startsWith("eval/fixture-vault/");
const noteNames = hits(/\b(?:feedback|project|reference|retro|handoff)_[a-z0-9]+(?:_[a-z0-9]+){2,}\b/g, isFixture);
ok("no private note names outside the fixture vault", noteNames.length === 0, noteNames.slice(0, 5).join(" · "));

// 2. The published golden set names notes by hash, never in the clear.
const golden = JSON.parse(text.get("eval/golden-aios.json") ?? "{}");
const expected = (golden.queries ?? []).flatMap((q) => q.expected ?? []);
const clear = expected.filter((e) => !/^note:[0-9a-f]{12}$/.test(e));
ok(`the published golden set names its ${expected.length} notes by hash`, clear.length === 0, clear.slice(0, 3).join(", "));

// 3. Baselines carry metrics, never the per-query results (those list every
//    note a description-derived query was written from).
const baselines = [...text].filter(([f]) => /^eval\/baseline-.*\.json$/.test(f));
const withResults = baselines.filter(([, t]) => Array.isArray(JSON.parse(t).queries));
ok(`the ${baselines.length} baselines are metrics only`, withResults.length === 0, withResults.map(([f]) => f).join(", "));

// 4. Nothing points at the machine it was written on. `C:\Windows\...` is not
//    in the pattern on purpose: it names a system, not a person, and the
//    containment tests use it as an attack string.
const paths = hits(/[A-Za-z]:[\\/](?:Users|Dev)[\\/][^\s"'`]{2,60}|\/(?:home|Users)\/[a-z0-9_.-]{2,30}\//gi);
ok("no absolute paths from anyone's disk", paths.length === 0, paths.slice(0, 4).join(" · "));

// 5. Credentials. The tests use long fake tokens on purpose, so the check is
//    for the shapes that only ever appear real.
const secrets = hits(
  /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{10,}|-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/g,
);
ok("no credentials", secrets.length === 0, secrets.slice(0, 3).join(" · "));

// 6. Personal data, through the vault's own scanner — the one that refuses a
//    write. Test fixtures and the scanner's own patterns are the exception,
//    and they are listed rather than pattern-matched, so a new file cannot
//    quietly join them.
const PII_ALLOWED = new Set([
  "packages/core/src/redact.ts", // the patterns themselves
  "scripts/acl-test.mjs", // proves the gate refuses a write carrying PII
  "scripts/gaps-test.mjs", // proves the register redacts before storing
  "scripts/promote-test.mjs", // a git identity for a temporary repository
  "paper/manent-paper.html", // the author's own contact address, on purpose
]);
const pii = [...text]
  .filter(([f]) => !PII_ALLOWED.has(f))
  .map(([f, t]) => [f, scanPii(t)])
  .filter(([, found]) => found.length > 0);
ok(
  "no personal data outside the files that exist to test for it",
  pii.length === 0,
  pii.map(([f, found]) => `${f} (${found.map((x) => x.kind).join(",")})`).join(" · "),
);

console.log(failures === 0 ? "\nnothing here says more about a private vault than it should" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
