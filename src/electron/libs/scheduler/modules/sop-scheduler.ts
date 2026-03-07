import { randomBytes } from "node:crypto";
import { createMutex } from "../core/lock.js";
import { loadStore, saveStore } from "../core/store.js";
import { calculateNextRunAtMs } from "../core/schedule.js";
import { armTimer, stopTimer, createTimerRef } from "../core/timer.js";
import { appendRunLog } from "../core/run-log.js";
import type {
  SopScheduledTask,
  SopTaskCreateInput,
  SchedulerStoreV2,
} from "../core/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Callbacks for SOP execution — injected by main.ts to avoid coupling
 * the scheduler to workflow-specific Electron code.
 */
export interface SopRunnerCallbacks {
  runSop: (sopId: string, scheduledTaskId: string) => void;
  runSopStage: (sopId: string, stageId: string, scheduledTaskId: string) => void;
}

export interface SopSchedulerOpts {
  storePath: string;
  logDir: string;
  nowMs?: () => number;
}

// ─── SopScheduler ─────────────────────────────────────────────────────────────

export class SopScheduler {
  private readonly storePath: string;
  private readonly logDir: string;
  private readonly locked = createMutex();
  private readonly timerRef = createTimerRef();
  private readonly now: () => number;
  private store: SchedulerStoreV2 | null = null;
  private callbacks: SopRunnerCallbacks | null = null;

  constructor(opts: SopSchedulerOpts) {
    this.storePath = opts.storePath;
    this.logDir = opts.logDir;
    this.now = opts.nowMs ?? (() => Date.now());
  }

  setCallbacks(callbacks: SopRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  getCallbacks(): SopRunnerCallbacks | null {
    return this.callbacks;
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
    armTimer(this.timerRef, this.store.sopTasks, () => this.tick(), this.now());
  }

  private async tick(): Promise<void> {
    await this.locked(async () => {
      await this.ensureLoaded();
      if (!this.callbacks) {
        // No callbacks registered — skip tick entirely to avoid state mutation
        this.rearmTimer();
        return;
      }
      const nowMs = this.now();
      const due = this.store!.sopTasks.filter(
        (t) =>
          t.enabled &&
          typeof t.state.nextRunAtMs === "number" &&
          t.state.nextRunAtMs <= nowMs &&
          !t.state.runningAtMs,
      );
      for (const task of due) {
        this.dispatchSopTask(task);
        task.state.lastRunAtMs = nowMs;
        task.state.nextRunAtMs = calculateNextRunAtMs(task.schedule, nowMs);
      }
      if (due.length > 0) await this.persist();
      this.rearmTimer();
    });
  }

  private dispatchSopTask(task: SopScheduledTask): void {
    if (!this.callbacks) return;
    const logEntry = () =>
      appendRunLog(this.logDir, {
        taskId: task.id,
        taskName: task.name,
        taskKind: "sop",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        status: "ok",
      }).catch(() => {});

    if (task.stageId) {
      console.log(`[SopScheduler] Triggering SOP stage: ${task.sopId}/${task.stageId}`);
      this.callbacks.runSopStage(task.sopId, task.stageId, task.id);
    } else {
      console.log(`[SopScheduler] Triggering whole SOP: ${task.sopId}`);
      this.callbacks.runSop(task.sopId, task.id);
    }
    void logEntry();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      for (const t of this.store!.sopTasks) {
        if (t.enabled && !t.state.nextRunAtMs) {
          t.state.nextRunAtMs = calculateNextRunAtMs(t.schedule, nowMs);
        }
      }
      await this.persist();
      this.rearmTimer();
    });
  }

  stop(): void {
    stopTimer(this.timerRef);
  }

  async add(input: SopTaskCreateInput): Promise<SopScheduledTask> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      const task: SopScheduledTask = {
        ...input,
        id: `sop_${Date.now()}_${randomBytes(4).toString("hex")}`,
        state: {
          nextRunAtMs: input.enabled ? calculateNextRunAtMs(input.schedule, nowMs) : undefined,
        },
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
      this.store!.sopTasks.push(task);
      await this.persist();
      this.rearmTimer();
      return task;
    });
  }

  /**
   * Upsert: update the existing SOP-level schedule (no stageId) or create a new one.
   * Idempotent — calling it multiple times for the same sopId updates in place.
   */
  async upsert(input: SopTaskCreateInput): Promise<SopScheduledTask> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const nowMs = this.now();
      const existing = this.store!.sopTasks.find(
        (t) => t.sopId === input.sopId && !t.stageId,
      );
      if (existing) {
        Object.assign(existing, {
          ...input,
          id: existing.id,
          state: {
            ...existing.state,
            nextRunAtMs: input.enabled ? calculateNextRunAtMs(input.schedule, nowMs) : undefined,
          },
          updatedAt: new Date(nowMs).toISOString(),
        });
        await this.persist();
        this.rearmTimer();
        return existing;
      }
      return await this.addInternal(input, nowMs);
    });
  }

  private async addInternal(input: SopTaskCreateInput, nowMs: number): Promise<SopScheduledTask> {
    const task: SopScheduledTask = {
      ...input,
      id: `sop_${Date.now()}_${randomBytes(4).toString("hex")}`,
      state: {
        nextRunAtMs: input.enabled ? calculateNextRunAtMs(input.schedule, nowMs) : undefined,
      },
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    this.store!.sopTasks.push(task);
    await this.persist();
    this.rearmTimer();
    return task;
  }

  async update(id: string, patch: Partial<SopScheduledTask>): Promise<SopScheduledTask | null> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const idx = this.store!.sopTasks.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      const nowMs = this.now();
      const t = { ...this.store!.sopTasks[idx], ...patch, updatedAt: new Date(nowMs).toISOString() };
      if (patch.schedule || patch.enabled !== undefined) {
        t.state = {
          ...t.state,
          nextRunAtMs: t.enabled ? calculateNextRunAtMs(t.schedule, nowMs) : undefined,
        };
      }
      this.store!.sopTasks[idx] = t;
      await this.persist();
      this.rearmTimer();
      return t;
    });
  }

  async delete(id: string): Promise<boolean> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const before = this.store!.sopTasks.length;
      this.store!.sopTasks = this.store!.sopTasks.filter((t) => t.id !== id);
      const removed = this.store!.sopTasks.length < before;
      if (removed) {
        await this.persist();
        this.rearmTimer();
      }
      return removed;
    });
  }

  /**
   * Delete all SOP tasks associated with a given sopId.
   * Called when a SOP is deleted.
   */
  async deleteBySopId(sopId: string): Promise<number> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const before = this.store!.sopTasks.length;
      this.store!.sopTasks = this.store!.sopTasks.filter((t) => t.sopId !== sopId);
      const removed = before - this.store!.sopTasks.length;
      if (removed > 0) {
        await this.persist();
        this.rearmTimer();
      }
      return removed;
    });
  }

  async getBySopId(sopId: string): Promise<SopScheduledTask[]> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      return this.store!.sopTasks.filter((t) => t.sopId === sopId);
    });
  }

  /** Synchronous accessor for cached SOP tasks (used by backward-compatible loadScheduledTasks). */
  getCachedTasks(): SopScheduledTask[] {
    return this.store?.sopTasks ?? [];
  }

  async list(): Promise<SopScheduledTask[]> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      return [...this.store!.sopTasks];
    });
  }
}
