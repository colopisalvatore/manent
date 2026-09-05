import { randomUUID } from "node:crypto";
import type { ToolResult } from "./tools.js";

/**
 * Tasks: `io.modelcontextprotocol/tasks` on the modern path.
 *
 * Every brain tool answers in milliseconds except the ones that read the whole
 * vault at once — curation compares every note against every other, and with
 * the dense ranker that is a minute of work. A minute is longer than a client
 * will hold a request open, so the call has to return a handle and the answer
 * has to be collected later. That is what the extension standardises: the call
 * returns `resultType: "task"`, the client polls `tasks/get`, and the result
 * arrives when it is ready.
 *
 * Two properties are deliberate:
 *
 * - **A task belongs to the identity that created it.** Another identity asking
 *   for it is told the task does not exist, not that it may not see it. This is
 *   the same reason the extension dropped `tasks/list`: without a session there
 *   is no safe way to enumerate what someone else started.
 * - **Cancellation is cooperative.** `tasks/cancel` sets a flag the work checks
 *   between phases. A task that has already finished stays finished — the
 *   specification allows a cancel to end in a non-cancelled terminal state, and
 *   pretending otherwise would report an answer as thrown away when it was not.
 */

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

/** The wire shape of a task, as the extension defines it. */
export interface TaskView {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  inputRequests?: Record<string, unknown>;
}

interface TaskRecord extends TaskView {
  /** the identity that created it; nobody else can see it exists */
  owner: string;
  /** set by `cancel`, read by the work between phases */
  cancelled: boolean;
  /** when the record itself may be dropped */
  expiresAt: number;
}

/** What a task's work is handed: the one question it has to keep asking. */
export interface TaskSignal {
  cancelled(): boolean;
}

export interface TaskStoreOptions {
  /** how long a task record lives after it was created; null keeps it forever */
  ttlMs?: number | null;
  /** cadence suggested to the client */
  pollIntervalMs?: number;
  now?: () => number;
}

export const DEFAULT_TASK_TTL_MS = 900_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly ttlMs: number | null;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(opts: TaskStoreOptions = {}) {
    this.ttlMs = opts.ttlMs === undefined ? DEFAULT_TASK_TTL_MS : opts.ttlMs;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Starts the work and hands back the handle the caller polls. */
  create(owner: string, work: (signal: TaskSignal) => Promise<ToolResult>, statusMessage?: string): TaskView {
    const at = new Date(this.now()).toISOString();
    const record: TaskRecord = {
      taskId: randomUUID(),
      status: "working",
      statusMessage,
      createdAt: at,
      lastUpdatedAt: at,
      ttlMs: this.ttlMs,
      pollIntervalMs: this.pollIntervalMs,
      owner,
      cancelled: false,
      expiresAt: this.ttlMs === null ? Number.POSITIVE_INFINITY : this.now() + this.ttlMs,
    };
    this.tasks.set(record.taskId, record);

    const signal: TaskSignal = { cancelled: () => record.cancelled };
    void work(signal).then(
      (out) => {
        // A cancelled task stays cancelled: the caller was already told.
        if (TERMINAL.has(record.status)) return;
        this.finish(record, {
          status: "completed",
          result: { resultType: "complete", content: out.content, ...(out.isError ? { isError: true } : {}) },
        });
      },
      (err: unknown) => {
        if (TERMINAL.has(record.status)) return;
        this.finish(record, {
          status: "failed",
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      },
    );
    return this.view(record);
  }

  /** The task, to the identity that owns it. Anyone else gets nothing. */
  get(owner: string, taskId: string): TaskView | undefined {
    this.sweep();
    const record = this.tasks.get(taskId);
    if (!record || record.owner !== owner) return undefined;
    return this.view(record);
  }

  /**
   * Cooperative cancel. Returns the task as it stands: already finished means
   * finished, and the caller sees which of the two happened.
   */
  cancel(owner: string, taskId: string): TaskView | undefined {
    const record = this.tasks.get(taskId);
    if (!record || record.owner !== owner) return undefined;
    record.cancelled = true;
    if (!TERMINAL.has(record.status)) {
      this.finish(record, { status: "cancelled", statusMessage: "cancelled by the caller" });
    }
    return this.view(record);
  }

  /**
   * Answers to a task's `inputRequests`. Manent's one input-requiring flow —
   * confirming a write — is answered inline on the call itself, so no task
   * here ever waits for input; a client that asks anyway is told plainly
   * rather than left believing the task moved on.
   */
  update(owner: string, taskId: string): { ok: true } | { ok: false; reason: "not-found" | "not-waiting" } {
    const record = this.tasks.get(taskId);
    if (!record || record.owner !== owner) return { ok: false, reason: "not-found" };
    if (record.status !== "input_required") return { ok: false, reason: "not-waiting" };
    record.status = "working";
    record.lastUpdatedAt = new Date(this.now()).toISOString();
    return { ok: true };
  }

  /** How many records are held; the sweep runs first, so this is what survives. */
  size(): number {
    this.sweep();
    return this.tasks.size;
  }

  private finish(record: TaskRecord, patch: Partial<TaskRecord>): void {
    Object.assign(record, patch);
    record.lastUpdatedAt = new Date(this.now()).toISOString();
  }

  /** A record outlives its answer by its TTL, then goes: this is a handle, not a log. */
  private sweep(): void {
    if (this.ttlMs === null) return;
    const now = this.now();
    for (const [id, record] of this.tasks) if (record.expiresAt <= now) this.tasks.delete(id);
  }

  private view(record: TaskRecord): TaskView {
    const { owner: _owner, cancelled: _cancelled, expiresAt: _expiresAt, ...view } = record;
    return { ...view };
  }
}
