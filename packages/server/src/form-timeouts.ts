import { readFile } from "node:fs/promises";

/**
 * Clients that let the confirmation form time out unseen.
 *
 * Some clients advertise elicitation, never render the form, and answer
 * `cancel` on their own after their request timeout (claude.ai: exactly 60s).
 * The chat fallback sent back on that `cancel` does not reach the model
 * either, so every write fails the same way. Once a client has done it, its
 * next writes skip the form and get the chat code at once, in an ordinary
 * result the model does see.
 *
 * Keyed by identity and User-Agent, remembered for FORM_TIMEOUT_MEMORY_MS.
 * The audit log is the persistent record: the service restarts on every vault
 * sync, so the memory is rebuilt from the audit's `formTimedOut` lines at boot
 * rather than kept in a file of its own.
 */

/** A `cancel` this long after the form was issued is a client timeout, not a person. */
export const FORM_TIMEOUT_MS = 50_000;
export const FORM_TIMEOUT_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
/** Only the tail of a long audit is read at boot: older lines are past the memory anyway. */
const AUDIT_TAIL_BYTES = 4 * 1024 * 1024;

export const formTimeoutKey = (identity: string, client: string) => `${identity}|${client}`;

export class FormTimeouts {
  private readonly seen = new Map<string, number>();

  add(key: string, at = Date.now()): void {
    if (at > (this.seen.get(key) ?? 0)) this.seen.set(key, at);
  }

  has(key: string, now = Date.now()): boolean {
    const at = this.seen.get(key);
    return at !== undefined && now - at <= FORM_TIMEOUT_MEMORY_MS;
  }

  /** Rebuilds the memory from an audit log; a missing or unreadable one is simply empty. */
  async seedFromAudit(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return;
    }
    if (raw.length > AUDIT_TAIL_BYTES) raw = raw.slice(raw.length - AUDIT_TAIL_BYTES);
    for (const line of raw.split("\n")) {
      if (!line.includes('"formTimedOut":true')) continue;
      try {
        const e = JSON.parse(line) as { ts?: string; agent?: string; client?: string };
        const at = e.ts ? Date.parse(e.ts) : NaN;
        if (e.agent && e.client && Number.isFinite(at)) this.add(formTimeoutKey(e.agent, e.client), at);
      } catch {
        // a torn last line, or one cut by the tail: skip it
      }
    }
  }
}
