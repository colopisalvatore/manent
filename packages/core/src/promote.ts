import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import matter from "gray-matter";
import { AUDIENCE_PRIVATE, NOTE_STATUSES, NOTE_TYPES, SLUG_RE, type NoteStatus, type NoteType } from "@manent/spec";
import { noteAudiences } from "./audience.js";
import { loadVault, noteName } from "./vault.js";
import { datesAsStrings, resolveInVault, WriteRefused } from "./write.js";
import type { Note } from "./types.js";

/**
 * Promotion: the human half of the write path.
 *
 * An agent's note lands in quarantine, private, ranked below verified notes.
 * Nothing takes it out of there but a person, and until now that person had to
 * edit YAML by hand in three places: the status, the audience, the folder.
 * Three edits is two too many, and the one that gets skipped is always the
 * audience, so the note either stays invisible or becomes visible to everybody.
 *
 * So promotion is one move: status, audience, destination, and the commit
 * message that says who wrote the note and who may now read it. What it does
 * not do is decide. No note leaves quarantine because it looked fine to a
 * heuristic; the queue is sorted by age so the oldest proposal is the one a
 * person sees first.
 */

export interface QueueEntry {
  name: string;
  relPath: string;
  description: string;
  type?: string;
  /** identity that wrote it through the write path */
  author?: string;
  audience: string[];
  /** the date the queue sorts on: `created` when the note has one, else the file's mtime */
  since: string;
  /** whole days between `since` and now */
  ageDays: number;
}

export interface ReviewQueueOptions {
  /** only notes written by this identity */
  author?: string;
  /** the status the queue is about; quarantine is the point of it */
  status?: NoteStatus;
  now?: Date;
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

const refuse = (msg: string): never => {
  throw new WriteRefused(msg);
};

/** Notes waiting for a person, oldest first. */
export async function reviewQueue(notes: Note[], opts: ReviewQueueOptions = {}): Promise<QueueEntry[]> {
  const status = opts.status ?? "quarantine";
  const now = opts.now ?? new Date();
  const waiting = notes.filter((n) => n.frontmatter.status === status);
  const entries = await Promise.all(
    waiting.map(async (n): Promise<QueueEntry> => {
      // Typed as a string by the spec, but YAML hands back a Date for a bare one.
      const created = n.frontmatter.created as unknown;
      // A hand-made note may carry no dates at all; the file system always has one.
      const since =
        typeof created === "string" && created.length > 0
          ? created.slice(0, 10)
          : created instanceof Date
            ? iso(created)
            : iso(await stat(n.path).then((s) => s.mtime).catch(() => now));
      const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(`${since}T00:00:00Z`)) / DAY));
      return {
        name: noteName(n),
        relPath: n.relPath,
        description: String(n.frontmatter.description ?? ""),
        type: typeof n.frontmatter.type === "string" ? n.frontmatter.type : undefined,
        author: typeof n.frontmatter.author === "string" ? n.frontmatter.author : undefined,
        audience: noteAudiences(n),
        since,
        ageDays,
      };
    }),
  );
  const filtered = opts.author
    ? entries.filter((e) => (e.author ?? "").toLowerCase() === opts.author!.toLowerCase())
    : entries;
  // Oldest first; ties by name, so two runs on the same vault print the same order.
  return filtered.sort((a, b) => (a.since === b.since ? a.name.localeCompare(b.name) : a.since.localeCompare(b.since)));
}

export interface PromoteInput {
  /** canonical name of the note to promote */
  name: string;
  /** status it takes; `active` unless said otherwise */
  status?: NoteStatus;
  /** audience labels it takes; unset keeps the ones it has */
  audience?: string[];
  /** vault-relative directory to move it to; unset leaves it where it is */
  dir?: string;
  /** work out the whole move and the message, touch nothing */
  dryRun?: boolean;
  now?: Date;
}

export interface PromoteResult {
  name: string;
  from: { relPath: string; status?: string; audience: string[] };
  to: { relPath: string; status: NoteStatus; audience: string[] };
  moved: boolean;
  /** vault-relative paths git has to be told about, the old one included when the note moved */
  paths: string[];
  commitMessage: string;
  dryRun: boolean;
}

/**
 * Takes one note out of quarantine.
 *
 * Refuses rather than guesses: an unknown name, an ambiguous one, a note that
 * is not in quarantine, a destination already taken, an audience label that is
 * not a slug. `private` alongside another label is refused too — `private` is
 * the absence of an audience, not one more of them, and a note carrying both
 * reads as private while being served to everyone holding the other label.
 */
export async function promoteNote(root: string, input: PromoteInput): Promise<PromoteResult> {
  const status = input.status ?? "active";
  if (!NOTE_STATUSES.includes(status)) refuse(`status must be one of: ${NOTE_STATUSES.join(", ")}`);

  const audience = input.audience?.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0);
  if (audience) {
    if (audience.length === 0) refuse("audience needs at least one label");
    const bad = audience.find((a) => !SLUG_RE.test(a));
    if (bad !== undefined) refuse(`Illegal audience label "${bad}": use slugs`);
    if (audience.includes(AUDIENCE_PRIVATE) && audience.length > 1) {
      refuse(`"${AUDIENCE_PRIVATE}" is the absence of an audience, not one of them: give it alone, or not at all`);
    }
  }

  const notes = await loadVault(root);
  const matches = notes.filter((n) => noteName(n) === input.name);
  if (matches.length === 0) refuse(`Note not found in ${root}: ${input.name}`);
  if (matches.length > 1) {
    refuse(`"${input.name}" names ${matches.length} notes: ${matches.map((n) => n.relPath).join(", ")}`);
  }
  const note = matches[0];
  if (note.parseError) refuse(`${note.relPath}: frontmatter is invalid (${note.parseError}). Fix it before promoting.`);

  const was = typeof note.frontmatter.status === "string" ? note.frontmatter.status : undefined;
  if (was !== "quarantine" && status === "active") {
    refuse(`${note.relPath} is ${was ?? "active"}, not in quarantine: nothing to promote`);
  }

  // The spec's required trio, checked here for the reason `writeNote` checks
  // it: a note that only fails validation later is a note that drifts.
  const description = note.frontmatter.description;
  const type = note.frontmatter.type;
  if (typeof description !== "string" || description.trim().length === 0) {
    refuse(`${note.relPath}: description is required before promotion (one line, what this note is)`);
  }
  if (typeof type !== "string" || !NOTE_TYPES.includes(type as NoteType)) {
    refuse(`${note.relPath}: type must be one of ${NOTE_TYPES.join(", ")} before promotion`);
  }

  const filename = `${input.name}.md`;
  const target =
    input.dir !== undefined ? resolveInVault(root, input.dir, filename) : { path: note.path, relPath: note.relPath };
  const moved = target.relPath !== note.relPath;
  if (moved && notes.some((n) => n.relPath === target.relPath)) {
    refuse(`Refusing to overwrite ${target.relPath}: a note is already there`);
  }

  const today = iso(input.now ?? new Date());
  const before = { relPath: note.relPath, status: was, audience: noteAudiences(note) };
  const frontmatter: Record<string, unknown> = {
    ...datesAsStrings(note.frontmatter as Record<string, unknown>),
    status,
    ...(audience ? { audience } : {}),
    updated: today,
  };
  const after = { relPath: target.relPath, status, audience: audience ?? before.audience };
  const commitMessage = commitMessageFor(input.name, before, after, {
    author: typeof note.frontmatter.author === "string" ? note.frontmatter.author : undefined,
    written: typeof frontmatter.created === "string" ? (frontmatter.created as string) : undefined,
    today,
  });

  if (!input.dryRun) {
    // The destination folder is made first: a vault rarely has every folder a
    // promotion might want, and a rename into a missing one fails after the
    // note has already been rewritten. Then write, then move — a rename that
    // fails leaves a promoted note where it was, which is recoverable; the
    // other order loses the write.
    if (moved) await mkdir(resolve(target.path, ".."), { recursive: true });
    await writeFile(note.path, matter.stringify(`${note.body.trim()}\n`, frontmatter), "utf8");
    if (moved) await rename(note.path, target.path);
  }

  return {
    name: input.name,
    from: before,
    to: after,
    moved,
    paths: moved ? [before.relPath, after.relPath] : [after.relPath],
    commitMessage,
    dryRun: !!input.dryRun,
  };
}

/** The message a person would have written by hand, with the facts they would have looked up. */
function commitMessageFor(
  name: string,
  from: { relPath: string; status?: string; audience: string[] },
  to: { relPath: string; status: NoteStatus; audience: string[] },
  meta: { author?: string; written?: string; today: string },
): string {
  const list = (labels: string[]) =>
    labels.length <= 1
      ? (labels[0] ?? AUDIENCE_PRIVATE)
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const lines = [
    `promote(${name}): out of quarantine`,
    "",
    meta.author
      ? `Written by ${meta.author}${meta.written ? ` on ${meta.written}` : ""}, promoted ${meta.today}.`
      : `Promoted ${meta.today}.`,
    `status: ${from.status ?? "active"}, now ${to.status}`,
    list(from.audience) === list(to.audience)
      ? `audience: ${list(to.audience)}`
      : `audience: ${list(from.audience)}, now ${list(to.audience)}`,
  ];
  if (from.relPath !== to.relPath) lines.push(`moved from ${from.relPath} to ${to.relPath}`);
  return lines.join("\n") + "\n";
}
