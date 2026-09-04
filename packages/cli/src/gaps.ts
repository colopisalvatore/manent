import { readFile, writeFile } from "node:fs/promises";
import { loadVault, noteName } from "@manent/core";
import { GapStore, type GapRow } from "@manent/server";

export interface GapsCliOptions {
  /** sqlite file of the register */
  db: string;
  status?: "open" | "closed" | "dismissed" | "all";
  limit?: number;
  json?: boolean;
  /** show the searches behind one gap */
  show?: string;
  close?: string;
  note?: string;
  /** golden-set file to append the closing entry to */
  golden?: string;
  dismiss?: string;
  feedback?: boolean;
}

const short = (iso: string) => iso.slice(0, 16).replace("T", " ");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

function formatGaps(rows: GapRow[]): string {
  if (rows.length === 0) return "no gaps — every search was followed by a read, or the register is empty";
  const lines = [`${pad("id", 15)} ${pad("asked", 6)} ${pad("read", 5)} ${pad("fb", 3)} ${pad("top", 6)} ${pad("last seen", 16)} ${pad("agents", 14)} query`];
  for (const g of rows) {
    const top = g.topScore == null ? "-" : g.topScore >= 1 ? g.topScore.toFixed(1) : g.topScore.toFixed(3);
    const status = g.status === "open" ? "" : ` [${g.status}${g.note ? ` → ${g.note}` : ""}]`;
    lines.push(
      `${pad(g.id, 15)} ${pad(String(g.count), 6)} ${pad(String(g.followed), 5)} ${pad(String(g.feedback), 3)} ${pad(top, 6)} ${pad(short(g.lastSeen), 16)} ${pad(g.agents.join(",").slice(0, 14), 14)} ${g.query}${status}`,
    );
  }
  lines.push("", "asked = searches grouped here · read = searches followed by a read · fb = feedback rows (brain_feedback) · top = best score seen");
  lines.push("close one with a note that answers it:  manent gaps <vault> --gaps <db> --close <id> --note <name>");
  return lines.join("\n");
}

export async function runGapsCommand(root: string, opts: GapsCliOptions): Promise<number> {
  const store = await GapStore.open({ path: opts.db });
  try {
    if (opts.close) {
      if (!opts.note) {
        console.error("--close needs --note <name>: the note that answers the question");
        return 1;
      }
      // The note must exist: a golden entry pointing at nothing would only ever fail.
      const notes = await loadVault(root);
      if (!notes.some((n) => noteName(n) === opts.note)) {
        console.error(`note not found in ${root}: ${opts.note}`);
        return 1;
      }
      const { gap, golden } = store.closeGap(opts.close, opts.note);
      if (opts.golden) {
        const added = await appendGolden(opts.golden, golden);
        console.log(added ? `golden entry added to ${opts.golden}` : `golden entry already in ${opts.golden}`);
      }
      console.log(opts.json ? JSON.stringify({ gap, golden }, null, 2) : `closed ${gap.id} → ${gap.note}\n\ngolden entry:\n${JSON.stringify(golden, null, 2)}`);
      return 0;
    }

    if (opts.dismiss) {
      const gap = store.dismissGap(opts.dismiss);
      console.log(opts.json ? JSON.stringify(gap, null, 2) : `dismissed ${gap.id}: ${gap.query}`);
      return 0;
    }

    if (opts.show) {
      const gap = store.getGap(opts.show);
      if (!gap) {
        console.error(`gap not found: ${opts.show}`);
        return 1;
      }
      const searches = store.listSearches(gap.id);
      if (opts.json) {
        console.log(JSON.stringify({ gap, searches }, null, 2));
        return 0;
      }
      console.log(`${gap.id}  ${gap.query}`);
      console.log(`asked ${gap.count}×, read ${gap.followed}×, status ${gap.status}${gap.note ? ` → ${gap.note}` : ""}`);
      for (const s of searches) {
        console.log(`  ${short(s.ts)}  ${pad(s.agent, 14)} ${s.followed ? "read   " : "unread "} top=${s.topScore ?? "-"}  ${s.topNames.slice(0, 3).join(", ")}${s.outcome ? `  outcome=${s.outcome}` : ""}`);
      }
      return 0;
    }

    if (opts.feedback) {
      const rows = store.listFeedback({ limit: opts.limit });
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) console.log("no feedback recorded");
      else for (const f of rows) console.log(`${short(f.ts)}  ${pad(f.agent, 14)} ${pad(f.verdict, 10)} ${f.note ?? f.gapId ?? "-"}${f.comment ? `  — ${f.comment}` : ""}`);
      return 0;
    }

    const rows = store.listGaps({ status: opts.status ?? "open", limit: opts.limit });
    console.log(opts.json ? JSON.stringify(rows, null, 2) : formatGaps(rows));
    return 0;
  } finally {
    store.close();
  }
}

/** Appends one entry to a golden-set file, creating the file if needed; deduplicates by query. */
async function appendGolden(file: string, entry: { query: string; expected: string[]; source: string; note: string }): Promise<boolean> {
  let set: { name: string; queries: Array<{ query: string; expected: string[]; source?: string; note?: string }> };
  try {
    set = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(set.queries)) throw new Error("missing queries");
  } catch {
    set = { name: "gaps closed into notes", queries: [] };
  }
  if (set.queries.some((q) => q.query === entry.query && q.expected.join() === entry.expected.join())) return false;
  set.queries.push(entry);
  await writeFile(file, JSON.stringify(set, null, 2) + "\n", "utf8");
  return true;
}
