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

// HOME.md / MEMORY.md keep their uppercase filename, but `name` is a slug: an
// MCP overwrite once wrote `name: HOME` and the vault failed lint.
console.log("\n── root entry points ──");
await writeFile(
  join(root, "HOME.md"),
  ["---", "name: home", "description: hub", "type: moc", "---", "corpo", ""].join("\n"),
  "utf8",
);
const home = await call(rw, "brain_write", { name: "HOME", body: "nuovo hub", mode: "overwrite" });
const homeRaw = await readFile(join(root, "HOME.md"), "utf8");
ok("overwrite of HOME.md succeeds", !home.isError);
ok("HOME.md keeps a lowercase name", /^name: home$/m.test(homeRaw), homeRaw.split("\n")[1]);

console.log("\n── the write is visible at once ──");
ok("brain_read sees it", !(await call(rw, "brain_read", { name: "nota-test" })).isError);
ok(
  "brain_search indexes it",
  (await call(rw, "brain_search", { query: "nuovo corpo", k: 3 })).content[0].text.includes("nota-test"),
);

// A client that says it can ask the person is asked; --no-confirm removes the
// question, for a caller nobody is watching.
console.log("\n── the confirmation ──");
const elicits = { clientCapabilities: { elicitation: {} } };
const proposal = { name: "nota-confermata", description: "d", type: "reference", body: "b" };
const asked = await findTool("brain_write").run(proposal, rw, elicits);
ok("a client that can ask gets the form", !!asked.inputRequired);
// A stated default would let a client that cannot render the control echo
// `confirm:false` back, indistinguishable from a deliberate decline.
const confirmField = asked.inputRequired.inputRequests["confirm-write"].params.requestedSchema.properties.confirm;
ok("the confirm field states no default", confirmField && !("default" in confirmField), JSON.stringify(confirmField));
ok("nothing is written while it waits", (await call(rw, "brain_read", { name: "nota-confermata" })).isError === true);
const declined = await findTool("brain_write").run(proposal, rw, {
  ...elicits,
  requestState: asked.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "cancel" } },
});
ok("cancel writes nothing", (await call(rw, "brain_read", { name: "nota-confermata" })).isError === true);

// A client that closes the form by itself (the claude.ai chat) gets the
// question handed back for the chat, with a code bound to this proposal.
const code = declined.content[0].text.match(/confirmation: "([^"]+)"/)?.[1];
ok("cancel hands the question to the chat, with a code", declined.audit?.pending === "chat-confirmation" && !!code);
const forged = await findTool("brain_write").run({ ...proposal, confirmation: "AAAAAAAAAAAAAAAA" }, rw, elicits);
ok("a made-up code is asked again", !!forged.inputRequired);
const swapped = await findTool("brain_write").run({ ...proposal, body: "altro", confirmation: code }, rw, elicits);
ok("the code does not confirm a different note", !!swapped.inputRequired);
const refused = await findTool("brain_write").run(proposal, rw, {
  ...elicits,
  requestState: asked.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "decline" } },
});
ok("decline stays final, no code", refused.audit?.declined === true && !/confirmation: "/.test(refused.content[0].text));
ok(
  "decline's structured outcome says declined, not written",
  refused.structuredContent?.outcome === "declined" && refused.structuredContent?.written === false,
  JSON.stringify(refused.structuredContent),
);
const viaChat = await findTool("brain_write").run({ ...proposal, name: "nota-chat", confirmation: code }, rw, elicits);
ok("the code does not confirm another name", !!viaChat.inputRequired);
const chatYes = await findTool("brain_write").run({ ...proposal, confirmation: code }, rw, elicits);
ok("the yes said in the chat writes", !chatYes.isError && !chatYes.inputRequired && chatYes.audit?.confirmedIn === "chat");
ok("the note is on disk", !(await call(rw, "brain_read", { name: "nota-confermata" })).isError);

const proposal2 = { ...proposal, name: "nota-confermata-form" };
const asked2 = await findTool("brain_write").run(proposal2, rw, elicits);
const accepted = await findTool("brain_write").run(proposal2, rw, {
  ...elicits,
  requestState: asked2.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "accept", content: { confirm: true } } },
});
ok("accept writes", !accepted.isError && !accepted.inputRequired);
ok(
  "accept's structured outcome says written",
  accepted.structuredContent?.outcome === "written" && accepted.structuredContent?.written === true,
  JSON.stringify(accepted.structuredContent),
);

// The reported bug: a client that advertises elicitation, shows a plain
// confirm dialog for the schema's one boolean field, and answers `accept`
// without ever carrying `content.confirm` back. That must not be read as
// a decline — it is the same "the person was not actually asked through
// this channel" situation as `cancel`, so it gets the same chat fallback.
console.log("\n── accept without a usable confirm field (the ChatGPT case) ──");
const proposal3 = { ...proposal, name: "nota-accept-sin-campo" };
const asked3 = await findTool("brain_write").run(proposal3, rw, elicits);
const acceptNoField = await findTool("brain_write").run(proposal3, rw, {
  ...elicits,
  requestState: asked3.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "accept" } }, // no content at all
});
ok(
  "accept with no confirm field falls back to the chat, not a silent decline",
  !acceptNoField.isError && !acceptNoField.inputRequired && acceptNoField.structuredContent?.outcome === "needs-chat-confirmation",
  JSON.stringify(acceptNoField.structuredContent),
);
ok("nothing written while it falls back", (await call(rw, "brain_read", { name: "nota-accept-sin-campo" })).isError === true);
ok("diagnostics note the answer shape, not its value", acceptNoField.audit?.answerAction === "accept" && acceptNoField.audit?.confirmField === "missing");
const code3 = acceptNoField.content[0].text.match(/confirmation: "([^"]+)"/)?.[1];
ok("a code was still issued for the chat", !!code3);
const yes3 = await findTool("brain_write").run({ ...proposal3, confirmation: code3 }, rw, elicits);
ok(
  "an explicit yes in the chat then writes",
  !yes3.isError && !yes3.inputRequired && yes3.structuredContent?.outcome === "written",
  JSON.stringify(yes3.structuredContent),
);
ok("the note is on disk", !(await call(rw, "brain_read", { name: "nota-accept-sin-campo" })).isError);

// `content.confirm: false` under `accept` is the person explicitly saying no
// inside the form itself — a real decline, not a dropped field, so it must
// NOT get the chat fallback (asking again would just repeat their no).
const proposal3b = { ...proposal, name: "nota-checkbox-no" };
const asked3b = await findTool("brain_write").run(proposal3b, rw, elicits);
const explicitNo = await findTool("brain_write").run(proposal3b, rw, {
  ...elicits,
  requestState: asked3b.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "accept", content: { confirm: false } } },
});
ok(
  "accept + confirm:false is a final decline, not a chat fallback",
  !explicitNo.isError && explicitNo.structuredContent?.outcome === "declined" && explicitNo.audit?.declined === true,
  JSON.stringify(explicitNo.structuredContent),
);
ok("nothing written", (await call(rw, "brain_read", { name: "nota-checkbox-no" })).isError === true);

// A client that advertises elicitation but never shows the form lets it time
// out after a minute, on every attempt. confirmIn: "chat" skips the form and
// hands back the code at once; it writes nothing by itself.
console.log("\n── confirmIn: chat (a client that never shows the form) ──");
const proposalChat = { ...proposal, name: "nota-chiesta-in-chat" };
const direct = await findTool("brain_write").run({ ...proposalChat, confirmIn: "chat" }, rw, elicits);
const codeChat = direct.content?.[0]?.text.match(/confirmation: "([^"]+)"/)?.[1];
ok(
  "confirmIn: chat answers with a code at once, no form",
  !direct.inputRequired && direct.structuredContent?.outcome === "needs-chat-confirmation" && !!codeChat,
  JSON.stringify(direct.structuredContent),
);
ok("the audit says the chat was asked for", direct.audit?.requested === "chat");
ok("nothing written by confirmIn alone", (await call(rw, "brain_read", { name: "nota-chiesta-in-chat" })).isError === true);
const otherNote = await findTool("brain_write").run({ ...proposalChat, name: "nota-altra", confirmation: codeChat }, rw, elicits);
ok("its code does not confirm another note", !!otherNote.inputRequired);
const yesChat = await findTool("brain_write").run({ ...proposalChat, confirmIn: "chat", confirmation: codeChat }, rw, elicits);
ok("the yes in the chat then writes", yesChat.structuredContent?.outcome === "written", JSON.stringify(yesChat.structuredContent));
ok("the note is on disk", (await call(rw, "brain_read", { name: "nota-chiesta-in-chat" })).isError !== true);
const appendChat = await findTool("brain_append").run({ name: "nota-chiesta-in-chat", body: "riga", confirmIn: "chat" }, rw, elicits);
ok(
  "brain_append takes confirmIn too",
  !appendChat.inputRequired && appendChat.structuredContent?.outcome === "needs-chat-confirmation",
  JSON.stringify(appendChat.structuredContent),
);
const cancelledChat = await findTool("brain_write").run({ ...proposal, name: "nota-suggerimento" }, rw, elicits);
const hintChat = await findTool("brain_write").run({ ...proposal, name: "nota-suggerimento" }, rw, {
  ...elicits,
  requestState: cancelledChat.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "cancel" } },
});
ok("the cancel fallback points at confirmIn for next time", /confirmIn: "chat"/.test(hintChat.content[0].text));
ok(
  "both write tools tell the model about confirmIn",
  ["brain_write", "brain_append"].every((t) => findTool(t).description.includes("confirmIn") && "confirmIn" in findTool(t).inputSchemaJson.properties),
);

// Expiry: a request state or a confirmation code older than the TTL is
// reported as expired, specifically, rather than silently written or
// silently re-asked forever.
console.log("\n── expiry ──");
const TEN_MIN = 10 * 60 * 1000;
const proposal4 = { ...proposal, name: "nota-form-scaduta" };
const asked4 = await findTool("brain_write").run(proposal4, rw, elicits);
const fp4 = asked4.inputRequired.requestState.split(".")[0];
const staleState = `${fp4}.${(Date.now() - TEN_MIN - 60_000).toString(36)}`;
const expiredForm = await findTool("brain_write").run(proposal4, rw, {
  ...elicits,
  requestState: staleState,
  inputResponses: { "confirm-write": { action: "accept", content: { confirm: true } } },
});
ok(
  "an expired form confirmation writes nothing, outcome is specific",
  !expiredForm.isError && !expiredForm.inputRequired && expiredForm.structuredContent?.outcome === "expired",
  JSON.stringify(expiredForm.structuredContent),
);
ok("nothing written for the expired form state", (await call(rw, "brain_read", { name: "nota-form-scaduta" })).isError === true);
const asked4b = await findTool("brain_write").run(proposal4, rw, elicits);
const retried4 = await findTool("brain_write").run(proposal4, rw, {
  ...elicits,
  requestState: asked4b.inputRequired.requestState,
  inputResponses: { "confirm-write": { action: "accept", content: { confirm: true } } },
});
ok("a fresh ask after expiry is a new, independent request that succeeds", !retried4.isError && retried4.structuredContent?.outcome === "written");

const proposal5 = { ...proposal, name: "nota-codice-scaduto" };
const staleCode = `${(Date.now() - TEN_MIN - 60_000).toString(36)}.0000000000000000`;
const expiredCode = await findTool("brain_write").run({ ...proposal5, confirmation: staleCode }, rw, elicits);
ok(
  "an expired confirmation code writes nothing, outcome is specific",
  !expiredCode.isError && !expiredCode.inputRequired && expiredCode.structuredContent?.outcome === "expired",
  JSON.stringify(expiredCode.structuredContent),
);
ok("nothing written for the expired code", (await call(rw, "brain_read", { name: "nota-codice-scaduto" })).isError === true);

const unattended = await loadBrainContext(root, { writable: true, confirmWrites: false });
const straight = await findTool("brain_write").run(
  { name: "nota-senza-conferma", description: "d", type: "reference", body: "b" },
  unattended,
  elicits,
);
ok("--no-confirm: the same client is not asked", !straight.inputRequired && !straight.isError);
ok("--no-confirm: the note is on disk", !(await call(unattended, "brain_read", { name: "nota-senza-conferma" })).isError);
await unattended.close();

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall write tests passed" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
