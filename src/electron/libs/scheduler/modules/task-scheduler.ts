import { randomBytes } from "node:crypto";
import path from "node:path";
import { app } from "electron";
import { createMutex } from "../core/lock.js";
import { loadStore, saveStore } from "../core/store.js";
import { calculateNextRunAtMs } from "../core/schedule.js";
import { armTimer, stopTimer, createTimerRef } from "../core/timer.js";
import {
  isTransientError,
  shouldRetryOneShotTask,
  getBackoffNextRunMs,
} from "../core/retry.js";
import { appendRunLog } from "../core/run-log.js";
import type {
  ScheduledTask,
  TaskCreateInput,
  TaskState,
  SchedulerStoreV2,
} from "../core/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskExecutor = (task: ScheduledTask) => Promise<void>;
export type FailureAlertFn = (task: ScheduledTask, consecutiveErrors: number, lastError: string) => void;

export interface TaskSchedulerOpts {
  storePath: string;
  logDir: string;
  onExecute: TaskExecutor;
  onFailureAlert?: FailureAlertFn;
  nowMs?: () => number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return `task_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

function computeNextRun(task: ScheduledTask, nowMs: number): number | undefined {
  if (!task.enabled) return undefined;
  return calculateNextRunAtMs(task.schedule, nowMs);
}

// ─── TaskScheduler ────────────────────────────────────────────────────────────

export class TaskScheduler {
  private readonly storePath: string;
  private readonly logDir: string;
  private readonly onExecute: TaskExecutor;
  private readonly onFailureAlert: FailureAlertFn | undefined;
  private readonly locked = createMutex();
  private readonly timerRef = createTimerRef();
  private readonly now: () => number;
  private store: SchedulerStoreV2 | null = null;

  constructor(opts: TaskSchedulerOpts) {
    this.storePath = opts.storePath;
    this.logDir = opts.logDir;
    this.onExecute = opts.onExecute;
    this.onFailureAlert = opts.onFailureAlert;
    this.now = opts.nowMs ?? (() => Date.now());
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.store) {
      this.store = await loadStore(this.storePath);
    }
  }

  private async persist(): Promise<void> {
    if (this.store) {
      await saveStore(this.storePath, this.store);
    }
  }

  private rearmTimer(): void {
    if (!this.store) return;
    armTimer(this.timerRef, this.store.tasks, () => this.tick(), this.now());
  }

  private async tick(): Promise<void> {
    const due: ScheduledTask[] = [];
    await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      for (const t of this.store!.tasks) {
        if (t.enabled && typeof t.state.nextRunAtMs === "number" && t.state.nextRunAtMs <= nowMs) {
          if (!t.state.runningAtMs) {
            t.state.runningAtMs = nowMs;
            due.push(JSON.parse(JSON.stringify(t)) as ScheduledTask);
          }
        }
      }
      if (due.length > 0) await this.persist();
      this.rearmTimer();
    });
    for (const task of due) {
      void this.executeTask(task);
    }
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    const startedAt = this.now();

    let status: "ok" | "error" = "ok";
    let errorMsg: string | undefined;

    try {
      const timeoutMs = task.timeoutSeconds ? task.timeoutSeconds * 1000 : undefined;
      if (timeoutMs && timeoutMs > 0) {
        await Promise.race([
          this.onExecute(task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Task timed out after ${task.timeoutSeconds}s`)), timeoutMs),
          ),
        ]);
      } else {
        await this.onExecute(task);
      }
    } catch (err) {
      status = "error";
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    const endedAt = this.now();

    await this.locked(async () => {
      await this.ensureLoaded();
      const t = this.store!.tasks.find((x) => x.id === task.id);
      if (!t) return;

      t.state.runningAtMs = undefined;
      t.state.lastRunAtMs = startedAt;
      t.state.lastRunStatus = status;
      t.state.lastError = errorMsg;

      if (status === "ok") {
        t.state.consecutiveErrors = 0;
        if (task.schedule.kind === "once") {
          t.enabled = false;
          t.state.nextRunAtMs = undefined;
        } else {
          t.state.nextRunAtMs = computeNextRun(t, endedAt);
        }
      } else {
        const errors = (t.state.consecutiveErrors ?? 0) + 1;
        t.state.consecutiveErrors = errors;

        if (task.schedule.kind === "once") {
          if (shouldRetryOneShotTask(errors, errorMsg ?? "")) {
            t.state.nextRunAtMs = getBackoffNextRunMs(errors, endedAt);
          } else {
            t.enabled = false;
            t.state.nextRunAtMs = undefined;
          }
        } else {
          const normalNext = computeNextRun(t, endedAt) ?? endedAt;
          const backoffNext = getBackoffNextRunMs(errors, endedAt);
          t.state.nextRunAtMs = Math.max(normalNext, backoffNext);
        }
      }

      t.updatedAt = new Date(endedAt).toISOString();
      await this.persist();

      // Fire failure alert if threshold reached
      if (status === "error" && this.onFailureAlert) {
        const alertAfter = t.failureAlertAfter ?? 2;
        const errors = t.state.consecutiveErrors ?? 0;
        if (errors >= alertAfter) {
          try { this.onFailureAlert(t, errors, errorMsg ?? "Unknown error"); } catch {}
        }
      }
    });

    // Append run log (outside lock, best-effort)
    await appendRunLog(this.logDir, {
      taskId: task.id,
      taskName: task.name,
      taskKind: "task",
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      status,
      error: errorMsg,
    }).catch(() => {});

    this.rearmTimer();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.locked(async () => {
      await this.ensureLoaded();

      // Clear stale running markers from previous crash
      for (const t of this.store!.tasks) {
        if (t.state.runningAtMs) {
          t.state.runningAtMs = undefined;
          t.state.consecutiveErrors = (t.state.consecutiveErrors ?? 0) + 1;
        }
      }
      await this.persist();
    });

    // Run any tasks that were missed while the app was stopped (outside lock)
    await this.runMissed();

    // Recompute nextRun for all enabled tasks and arm timer
    await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      for (const t of this.store!.tasks) {
        if (t.enabled && !t.state.runningAtMs) {
          if (!t.state.nextRunAtMs && t.schedule.kind !== "once") {
            t.state.nextRunAtMs = computeNextRun(t, nowMs);
          }
        }
      }
      await this.persist();
      this.rearmTimer();
    });
  }

  stop(): void {
    stopTimer(this.timerRef);
  }

  async runMissed(): Promise<void> {
    const missed: ScheduledTask[] = [];
    await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      for (const t of this.store!.tasks) {
        if (t.enabled && typeof t.state.nextRunAtMs === "number" && t.state.nextRunAtMs <= nowMs) {
          if (!t.state.runningAtMs) {
            t.state.runningAtMs = nowMs;
            missed.push(JSON.parse(JSON.stringify(t)) as ScheduledTask);
          }
        }
      }
      if (missed.length > 0) await this.persist();
    });
    for (const task of missed) {
      void this.executeTask(task);
    }
  }

  async add(input: TaskCreateInput): Promise<ScheduledTask> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      let nextRunAtMs = input.enabled ? calculateNextRunAtMs(input.schedule, nowMs) : undefined;
      // For once tasks that are already past due, set nextRunAtMs to the scheduled time
      // so runMissed() can pick them up immediately
      if (input.enabled && input.schedule.kind === "once" && nextRunAtMs === undefined) {
        const atMs = new Date(input.schedule.scheduledTime).getTime();
        if (Number.isFinite(atMs) && atMs <= nowMs) {
          nextRunAtMs = atMs;
        }
      }
      const task: ScheduledTask = {
        ...input,
        id: generateId(),
        state: {
          ...input.state,
          nextRunAtMs,
        },
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
      this.store!.tasks.push(task);
      await this.persist();
      this.rearmTimer();
      return task;
    });
  }

  async update(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const idx = this.store!.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      const nowMs = this.now();
      const t = { ...this.store!.tasks[idx], ...patch, updatedAt: new Date(nowMs).toISOString() };
      if (patch.schedule !== undefined || patch.enabled !== undefined) {
        t.state = {
          ...t.state,
          nextRunAtMs: t.enabled ? calculateNextRunAtMs(t.schedule, nowMs) : undefined,
        };
      }
      this.store!.tasks[idx] = t;
      await this.persist();
      this.rearmTimer();
      return t;
    });
  }

  async delete(id: string): Promise<boolean> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const before = this.store!.tasks.length;
      this.store!.tasks = this.store!.tasks.filter((t) => t.id !== id);
      const removed = this.store!.tasks.length < before;
      if (removed) {
        await this.persist();
        this.rearmTimer();
      }
      return removed;
    });
  }

  async list(opts?: { includeDisabled?: boolean }): Promise<ScheduledTask[]> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const tasks = this.store!.tasks;
      if (opts?.includeDisabled) return [...tasks];
      return tasks.filter((t) => t.enabled);
    });
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      return this.store!.tasks.find((t) => t.id === id);
    });
  }

  /** Synchronous accessor for cached tasks (used by backward-compatible loadScheduledTasks). */
  getCachedTasks(): ScheduledTask[] {
    return this.store?.tasks ?? [];
  }

  async runNow(id: string): Promise<boolean> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const task = this.store!.tasks.find((t) => t.id === id);
      if (!task) return false;
      if (task.state.runningAtMs) return false; // already running
      task.state.runningAtMs = this.now();
      await this.persist();
      const snapshot = JSON.parse(JSON.stringify(task)) as ScheduledTask;
      void this.executeTask(snapshot);
      return true;
    });
  }
}

// ─── Default store path (Electron) ────────────────────────────────────────────

export function getDefaultStorePath(): string {
  return path.join(app.getPath("userData"), "scheduled-tasks.json");
}

export function getDefaultLogDir(): string {
  return path.join(app.getPath("userData"), "scheduler-logs");
}
