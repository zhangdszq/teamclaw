import { randomBytes } from "node:crypto";
import { createMutex } from "../core/lock.js";
import { loadStore, saveStore } from "../core/store.js";
import type {
  HookTask,
  HookTaskCreateInput,
  HookContext,
  SchedulerStoreV2,
} from "../core/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type HookExecutor = (task: HookTask, context?: HookContext) => void;

export interface HookRunnerOpts {
  storePath: string;
  onExecute: HookExecutor;
}

// ─── HookRunner ───────────────────────────────────────────────────────────────

export class HookRunner {
  private readonly storePath: string;
  private readonly onExecute: HookExecutor;
  private readonly locked = createMutex();
  private store: SchedulerStoreV2 | null = null;

  constructor(opts: HookRunnerOpts) {
    this.storePath = opts.storePath;
    this.onExecute = opts.onExecute;
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

  /**
   * Run all enabled hook tasks matching the given event and context filters.
   * Non-blocking: tasks are dispatched to `onExecute` and the method returns immediately.
   */
  runHooks(event: "startup" | "session.complete", context?: HookContext): void {
    void this.locked(async () => {
      await this.ensureLoaded();
      const now = new Date().toISOString();
      const matched = this.store!.hooks.filter((h) => {
        if (!h.enabled || h.hookEvent !== event) return false;
        const f = h.hookFilter;
        if (!f) return true;
        if (f.assistantId && context?.assistantId !== f.assistantId) return false;
        if (f.onlyOnError && context?.status !== "error") return false;
        if (f.titlePattern && context?.sessionTitle) {
          if (!context.sessionTitle.includes(f.titlePattern)) return false;
        }
        return true;
      });

      for (const hook of matched) {
        console.log(`[HookRunner] Running hook "${hook.name}" for event: ${event}`);
        try {
          this.onExecute(hook, context);
        } catch (err) {
          console.error(`[HookRunner] Error executing hook "${hook.name}":`, err);
        }
        hook.lastRun = now;
      }

      if (matched.length > 0) {
        await this.persist();
      }
    }).catch((err) => {
      console.error("[HookRunner] Error in runHooks:", err);
    });
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async add(input: HookTaskCreateInput): Promise<HookTask> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const now = new Date().toISOString();
      const hook: HookTask = {
        ...input,
        id: `hook_${Date.now()}_${randomBytes(4).toString("hex")}`,
        createdAt: now,
        updatedAt: now,
      };
      this.store!.hooks.push(hook);
      await this.persist();
      return hook;
    });
  }

  async delete(id: string): Promise<boolean> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const before = this.store!.hooks.length;
      this.store!.hooks = this.store!.hooks.filter((h) => h.id !== id);
      const removed = this.store!.hooks.length < before;
      if (removed) await this.persist();
      return removed;
    });
  }

  /** Synchronous accessor for cached hooks (used by backward-compatible loadScheduledTasks). */
  getCachedHooks(): HookTask[] {
    return this.store?.hooks ?? [];
  }

  async list(): Promise<HookTask[]> {
    return await this.locked(async () => {
      await this.ensureLoaded();
      return [...this.store!.hooks];
    });
  }

  async reload(): Promise<void> {
    await this.locked(async () => {
      this.store = null;
      await this.ensureLoaded();
    });
  }
}
