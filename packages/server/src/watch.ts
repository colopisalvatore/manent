import { watch, type FSWatcher } from "node:fs";
import { relative, sep } from "node:path";

/**
 * Watching a vault for edits.
 *
 * A vault served to one person can index at startup: the service restarts
 * on every sync anyway. A vault shared by several agents and edited every day
 * cannot — a note written this morning must be findable this morning. So the
 * server watches the tree and re-indexes what changed; embeddings are cached
 * by content hash, so the cost is the changed notes, not the vault.
 *
 * Events are coalesced: an editor saves in bursts, a `git checkout` touches
 * hundreds of files at once, and one reload per burst is what we want.
 */

export interface WatchOptions {
  /** quiet time after the last event before a reload, default 400 ms */
  debounceMs?: number;
}

export interface VaultWatcher {
  close(): void;
}

const SKIP = ["/.git/", "/.obsidian/", "/.manent/", "/node_modules/", "/secrets/"];

function relevant(rel: string): boolean {
  const p = `/${rel.split(sep).join("/")}`;
  if (SKIP.some((s) => p.includes(s) || p.startsWith(s.slice(0, -1) + "/"))) return false;
  return p.endsWith(".md") || p.endsWith("/.manentignore");
}

/**
 * Calls `onChange` once per burst of relevant edits, never concurrently: a
 * burst arriving during a reload triggers one more reload after it.
 * Unavailable recursive watching (some Linux setups) degrades to a warning —
 * the server keeps serving what it indexed at startup.
 */
export function watchVault(
  root: string,
  onChange: (changed: string[]) => Promise<void> | void,
  opts: WatchOptions = {},
): VaultWatcher {
  const debounceMs = opts.debounceMs ?? 400;
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true });
  } catch (err) {
    console.error(`[manent] vault watch unavailable, serving what was indexed at startup: ${err instanceof Error ? err.message : String(err)}`);
    return { close() {} };
  }

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let closed = false;

  const flush = () => {
    timer = undefined;
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    const changed = [...pending];
    pending.clear();
    running = Promise.resolve(onChange(changed))
      .catch((err) => console.error(`[manent] reload failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          flush();
        }
      });
  };

  watcher.on("change", (_event, filename) => {
    if (filename == null) return;
    const rel = relative(root, `${root}${sep}${String(filename)}`);
    if (!relevant(rel)) return;
    pending.add(rel.split(sep).join("/"));
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  watcher.on("error", (err) => console.error(`[manent] vault watch error: ${err.message}`));

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
