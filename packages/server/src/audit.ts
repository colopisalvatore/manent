import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One line per tool call, with the identity that made it.
 *
 * A brain that several agents read is infrastructure, and infrastructure
 * answers "who read what, when". The line carries the agent (never a person),
 * the tool, what it was asked (redacted by the caller) and what came back —
 * enough to reconstruct an incident, not enough to reconstruct a customer.
 * Append-only JSONL, outside the vault, in the operator's hands.
 */
export interface AuditEntry {
  ts: string;
  agent: string;
  tool: string;
  ok: boolean;
  ms: number;
  [key: string]: unknown;
}

export class AuditLog {
  private stream?: WriteStream;

  private constructor(readonly path: string) {}

  static async open(path: string): Promise<AuditLog> {
    await mkdir(dirname(path), { recursive: true });
    const log = new AuditLog(path);
    log.stream = createWriteStream(path, { flags: "a" });
    return log;
  }

  log(entry: AuditEntry): void {
    // A failing audit must not fail the call; the operator sees it on stderr.
    this.stream?.write(JSON.stringify(entry) + "\n", (err) => {
      if (err) console.error(`[manent] audit write failed: ${err.message}`);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = undefined;
    });
  }
}
