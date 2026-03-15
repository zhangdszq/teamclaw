// ─── SchedulerService — unified entry point ───────────────────────────────────
// Wraps TaskScheduler, SopScheduler, and HookRunner into a single service.
// Also exports backward-compatible free functions so existing call sites
// (main.ts, shared-mcp.ts, ipc-handlers.ts) require minimal changes.

import { Notification } from "electron";
import type { ClientEvent } from "../../types.js";
import { TaskScheduler, getDefaultStorePath, getDefaultLogDir } from "./modules/task-scheduler.js";
import { SopScheduler } from "./modules/sop-scheduler.js";
import { HookRunner } from "./modules/hook-runner.js";
import { loadAssistantsConfig, resolveAssistantReference, type AssistantConfig } from "../assistants-config.js";
import { sendNotificationDirect } from "../shared-mcp.js";
import { calculateNextRunAtMs } from "./core/schedule.js";
import type {
  ScheduledTask,
  SopScheduledTask,
  HookTask,
  HookContext,
  TaskCreateInput,
  SopTaskCreateInput,
  HookTaskCreateInput,
} from "./core/types.js";

// Re-export core types for callers that imported from the old scheduler.ts
export type {
  ScheduledTask,
  SopScheduledTask,
  HookTask,
  HookContext,
  TaskCreateInput,
  SopTaskCreateInput,
  HookTaskCreateInput,
  ScheduleConfig,
  TaskState,
  RunRecord,
} from "./core/types.js";

export { TaskScheduler } from "./modules/task-scheduler.js";
export { SopScheduler } from "./modules/sop-scheduler.js";
export { HookRunner } from "./modules/hook-runner.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

type SessionRunner = (event: ClientEvent) => Promise<void>;

type SopRunner = (sopId: string, scheduledTaskId: string) => void;
type SopStageRunner = (sopId: string, stageId: string, scheduledTaskId: string) => void;

// ─── Singleton ────────────────────────────────────────────────────────────────

let _service: SchedulerService | null = null;

export function getSchedulerService(): SchedulerService {
  if (!_service) throw new Error("SchedulerService has not been initialized. Call createSchedulerService() first.");
  return _service;
}

// ─── SchedulerService ─────────────────────────────────────────────────────────

export class SchedulerService {
  readonly tasks: TaskScheduler;
  readonly sop: SopScheduler;
  readonly hooks: HookRunner;

  private sessionRunner: SessionRunner | null = null;

  constructor(storePath?: string, logDir?: string) {
    const sp = storePath ?? getDefaultStorePath();
    const ld = logDir ?? getDefaultLogDir();

    this.tasks = new TaskScheduler({
      storePath: sp,
      logDir: ld,
      onExecute: (task) => this.executeTask(task),
      onFailureAlert: (task, errors, error) => {
        if (Notification.isSupported()) {
          new Notification({
            title: `定时任务失败: ${task.name}`,
            body: `连续失败 ${errors} 次。${error.slice(0, 100)}`,
          }).show();
        }
      },
    });

    this.sop = new SopScheduler({ storePath: sp, logDir: ld });

    this.hooks = new HookRunner({
      storePath: sp,
      onExecute: (hook, ctx) => this.executeHook(hook, ctx),
    });
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    const config = loadAssistantsConfig();
    const assistantMatch = task.assistantId ? resolveAssistantReference(task.assistantId, config) : { matchedBy: "none" as const };
    const assistant: AssistantConfig | undefined = assistantMatch.assistant
      ?? (task.assistantId
        ? undefined
        : config.assistants.find((a: AssistantConfig) => a.id === config.defaultAssistantId) ?? config.assistants[0]);

    // Direct push mode: skip AI session entirely, just send notification
    if (task.notifyText) {
      console.log(`[Scheduler] Direct push for task "${task.name}": ${task.notifyText.slice(0, 60)}`);
      const result = await sendNotificationDirect(task.notifyText, {
        assistantId: assistant?.id ?? assistantMatch.assistant?.id ?? task.assistantId,
        skipCooldown: true,
      });
      if (!result.ok) {
        throw new Error(`Notification failed: ${result.error}`);
      }
      return;
    }

    // Full AI session mode
    if (!this.sessionRunner) {
      console.warn(`[Scheduler] sessionRunner not set, cannot run task: ${task.name}`);
      return;
    }

    const scheduledPrefix =
      `[系统] 这是一个自动触发的定时任务「${task.name}」，请直接执行以下指令并输出结果。` +
      `不要创建新的定时任务或提醒，你本身就是那个提醒。` +
      `如果任务涉及通知用户，请使用 send_notification 工具推送消息。\n\n`;

    await this.sessionRunner({
      type: "session.start",
      payload: {
        title: `定时任务: ${task.name}`,
        prompt: scheduledPrefix + task.prompt,
        cwd: task.cwd ?? assistant?.defaultCwd,
        assistantId: assistant?.id,
        assistantSkillNames: assistant?.skillNames ?? [],
        assistantPersona: assistant?.persona,
        provider: assistant?.provider ?? "claude",
        model: assistant?.model,
        scheduledTaskId: task.id,
        background: true,
      },
    });
  }

  private executeHook(hook: HookTask, ctx?: HookContext): void {
    if (!this.sessionRunner) {
      console.warn(`[Scheduler] sessionRunner not set, cannot run hook: ${hook.name}`);
      return;
    }
    const config = loadAssistantsConfig();
    const assistant: AssistantConfig | undefined = hook.assistantId
      ? resolveAssistantReference(hook.assistantId, config).assistant
      : config.assistants.find((a: AssistantConfig) => a.id === config.defaultAssistantId) ?? config.assistants[0];

    const hookPrefix =
      `[系统] 这是由事件「${hook.hookEvent}」自动触发的钩子任务「${hook.name}」，请直接执行以下指令。` +
      `不要创建新的定时任务。\n\n`;

    void this.sessionRunner({
      type: "session.start",
      payload: {
        title: `[Hook] ${hook.name}`,
        prompt: hookPrefix + hook.prompt,
        assistantId: assistant?.id,
        assistantSkillNames: assistant?.skillNames ?? [],
        assistantPersona: assistant?.persona,
        provider: assistant?.provider ?? "claude",
        model: assistant?.model,
        scheduledTaskId: hook.id,
        background: true,
      },
    }).catch((e: unknown) => {
      console.error(`[Scheduler] Hook session start failed for "${hook.name}":`, e);
    });
  }

  setSessionRunner(fn: SessionRunner): void {
    this.sessionRunner = fn;
  }

  setSopCallbacks(runSop: SopRunner, runSopStage: SopStageRunner): void {
    this.sop.setCallbacks({ runSop, runSopStage });
  }

  async start(): Promise<void> {
    await this.tasks.start();
    await this.sop.start();
  }

  stop(): void {
    this.tasks.stop();
    this.sop.stop();
  }
}

// ─── Initialize singleton ─────────────────────────────────────────────────────

export function createSchedulerService(storePath?: string, logDir?: string): SchedulerService {
  _service = new SchedulerService(storePath, logDir);
  return _service;
}

// ─── Backward-compatible free functions ──────────────────────────────────────
// These mirror the old scheduler.ts public API so existing callers need
// only change their import path, not their call sites.
//
// The legacy API uses a flat structure (scheduleType, intervalValue, etc.)
// while the new internal API uses a typed ScheduleConfig union.
// These adapters translate between the two.

// Legacy flat task shape (matches types.d.ts ScheduledTask for UI/IPC callers)
export interface LegacyTask {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  cwd?: string;
  skillPath?: string;
  assistantId?: string;
  scheduleType: "once" | "interval" | "daily" | "cron" | "heartbeat" | "hook";
  scheduledTime?: string;
  intervalValue?: number;
  intervalUnit?: "minutes" | "hours" | "days" | "weeks";
  dailyTime?: string;
  dailyDays?: number[];
  cronExpr?: string;
  cronTimezone?: string;
  notifyText?: string;
  suppressIfShort?: boolean;
  hookEvent?: "startup" | "session.complete";
  hookFilter?: { assistantId?: string; titlePattern?: string; onlyOnError?: boolean };
  lastRun?: string;
  nextRun?: string;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  consecutiveErrors?: number;
  sopId?: string;
  stageId?: string;
  hidden?: boolean;
  createdAt: string;
  updatedAt: string;
}

function internalToLegacy(task: ScheduledTask): LegacyTask {
  const { schedule, state, ...rest } = task;
  const base: LegacyTask = {
    ...rest,
    scheduleType: schedule.kind,
    nextRun: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : undefined,
    lastRun: state.lastRunAtMs ? new Date(state.lastRunAtMs).toISOString() : undefined,
    lastRunStatus: state.lastRunStatus,
    lastError: state.lastError,
    consecutiveErrors: state.consecutiveErrors,
  };
  if (schedule.kind === "once") {
    base.scheduledTime = schedule.scheduledTime;
  } else if (schedule.kind === "interval") {
    base.intervalValue = schedule.intervalValue;
    base.intervalUnit = schedule.intervalUnit;
  } else if (schedule.kind === "daily") {
    base.dailyTime = schedule.dailyTime;
    base.dailyDays = schedule.dailyDays;
  } else if (schedule.kind === "cron") {
    base.cronExpr = schedule.expr;
    base.cronTimezone = schedule.timezone;
  }
  return base;
}

function legacyToInternal(input: Partial<LegacyTask>): TaskCreateInput {
  const { scheduleType, scheduledTime, intervalValue, intervalUnit, dailyTime, dailyDays,
    cronExpr, cronTimezone,
    sopId, stageId, hidden, hookEvent, hookFilter,
    nextRun: _nextRun, lastRun: _lastRun, lastRunStatus: _lrs, lastError: _le, consecutiveErrors: _ce,
    ...rest } = input;

  let schedule: import("./core/types.js").ScheduleConfig;
  if (scheduleType === "once") {
    schedule = { kind: "once", scheduledTime: scheduledTime ?? "" };
  } else if (scheduleType === "interval") {
    schedule = {
      kind: "interval",
      intervalValue: intervalValue ?? 1,
      intervalUnit: intervalUnit ?? "hours",
    };
  } else if (scheduleType === "cron" && cronExpr) {
    schedule = { kind: "cron", expr: cronExpr, timezone: cronTimezone };
  } else {
    schedule = { kind: "daily", dailyTime: dailyTime ?? "09:00", dailyDays };
  }

  return {
    name: rest.name ?? "",
    enabled: rest.enabled ?? true,
    prompt: rest.prompt ?? "",
    schedule,
    assistantId: rest.assistantId,
    cwd: rest.cwd,
    skillPath: rest.skillPath,
    suppressIfShort: rest.suppressIfShort,
  };
}

export function loadScheduledTasks(): LegacyTask[] {
  const service = getSchedulerService();
  const internalTasks = service.tasks.getCachedTasks();
  const sopTasks = service.sop.getCachedTasks();
  const hooks = service.hooks.getCachedHooks();

  const legacyTasks = internalTasks.map(internalToLegacy);

  const legacySopTasks: LegacyTask[] = sopTasks.map((t) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
    prompt: "",
    scheduleType: t.schedule.kind,
    sopId: t.sopId,
    stageId: t.stageId,
    hidden: t.hidden,
    ...(t.schedule.kind === "once" ? { scheduledTime: t.schedule.scheduledTime } : {}),
    ...(t.schedule.kind === "interval" ? { intervalValue: t.schedule.intervalValue, intervalUnit: t.schedule.intervalUnit } : {}),
    ...(t.schedule.kind === "daily" ? { dailyTime: t.schedule.dailyTime, dailyDays: t.schedule.dailyDays } : {}),
    ...(t.schedule.kind === "cron" ? { cronExpr: t.schedule.expr, cronTimezone: t.schedule.timezone } : {}),
    nextRun: t.state.nextRunAtMs ? new Date(t.state.nextRunAtMs).toISOString() : undefined,
    lastRun: t.state.lastRunAtMs ? new Date(t.state.lastRunAtMs).toISOString() : undefined,
    lastRunStatus: t.state.lastRunStatus,
    lastError: t.state.lastError,
    consecutiveErrors: t.state.consecutiveErrors,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  const legacyHooks: LegacyTask[] = hooks.map((h) => ({
    id: h.id,
    name: h.name,
    enabled: h.enabled,
    prompt: h.prompt,
    scheduleType: "hook" as const,
    hookEvent: h.hookEvent,
    hookFilter: h.hookFilter,
    assistantId: h.assistantId,
    lastRun: h.lastRun,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  }));

  return [...legacyTasks, ...legacySopTasks, ...legacyHooks];
}

export async function addScheduledTask(
  input: Partial<LegacyTask>,
): Promise<LegacyTask> {
  const svc = getSchedulerService();
  const normalizedAssistantId = input.assistantId
    ? (resolveAssistantReference(input.assistantId).assistant?.id ?? input.assistantId)
    : input.assistantId;

  // SOP task
  if (input.sopId) {
    const sopInput: SopTaskCreateInput = {
      sopId: input.sopId,
      stageId: input.stageId,
      name: input.name ?? "",
      enabled: input.enabled ?? true,
      schedule: legacyToInternal(input).schedule,
      hidden: input.hidden ?? true,
    };
    const created = await svc.sop.add(sopInput);
    return {
      id: created.id,
      name: created.name,
      enabled: created.enabled,
      prompt: "",
      scheduleType: input.scheduleType ?? "daily",
      sopId: created.sopId,
      stageId: created.stageId,
      hidden: created.hidden,
      nextRun: created.state.nextRunAtMs ? new Date(created.state.nextRunAtMs).toISOString() : undefined,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  }

  // Hook task
  if (input.scheduleType === "hook" && input.hookEvent) {
    const hook = await svc.hooks.add({
      name: input.name ?? "",
      enabled: input.enabled ?? true,
      prompt: input.prompt ?? "",
      hookEvent: input.hookEvent,
      hookFilter: input.hookFilter,
      assistantId: normalizedAssistantId,
    });
    return {
      id: hook.id,
      name: hook.name,
      enabled: hook.enabled,
      prompt: hook.prompt,
      scheduleType: "hook",
      hookEvent: hook.hookEvent,
      hookFilter: hook.hookFilter,
      assistantId: hook.assistantId,
      lastRun: hook.lastRun,
      createdAt: hook.createdAt,
      updatedAt: hook.updatedAt,
    };
  }

  // Regular task
  const internal = legacyToInternal({ ...input, assistantId: normalizedAssistantId });
  const created = await svc.tasks.add(internal);
  return internalToLegacy(created);
}

export async function updateScheduledTask(
  id: string,
  updates: Partial<LegacyTask>,
): Promise<LegacyTask | null> {
  const svc = getSchedulerService();

  // Check SOP tasks first
  const sopTasks = await svc.sop.list();
  const sopTask = sopTasks.find((t) => t.id === id);
  if (sopTask) {
    const patch: Partial<import("./core/types.js").SopScheduledTask> = {};
    if (updates.enabled !== undefined) patch.enabled = updates.enabled;
    if (updates.name !== undefined) patch.name = updates.name;
    const updated = await svc.sop.update(id, patch);
    if (!updated) return null;
    return {
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      prompt: "",
      scheduleType: updates.scheduleType ?? "daily",
      sopId: updated.sopId,
      stageId: updated.stageId,
      hidden: updated.hidden,
      nextRun: updated.state.nextRunAtMs ? new Date(updated.state.nextRunAtMs).toISOString() : undefined,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  // Check hooks
  const allHooks = await svc.hooks.list();
  if (allHooks.find((h) => h.id === id)) {
    // Hook updates not supported via this shim; return as-is
    return null;
  }

  // Regular task
  const patch: Partial<ScheduledTask> = {};
  if (updates.enabled !== undefined) patch.enabled = updates.enabled;
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.prompt !== undefined) patch.prompt = updates.prompt;
  if (updates.assistantId !== undefined) {
    patch.assistantId = updates.assistantId
      ? (resolveAssistantReference(updates.assistantId).assistant?.id ?? updates.assistantId)
      : updates.assistantId;
  }
  if (updates.cwd !== undefined) patch.cwd = updates.cwd;
  if (updates.scheduleType !== undefined || updates.dailyTime !== undefined ||
      updates.intervalValue !== undefined || updates.scheduledTime !== undefined) {
    patch.schedule = legacyToInternal(updates).schedule;
  }
  const updated = await svc.tasks.update(id, patch);
  if (!updated) return null;
  return internalToLegacy(updated);
}

export async function deleteScheduledTask(id: string): Promise<boolean> {
  const svc = getSchedulerService();
  const fromTasks = await svc.tasks.delete(id);
  if (fromTasks) return true;
  const fromSop = await svc.sop.delete(id);
  if (fromSop) return true;
  return false;
}

export async function deleteScheduledTasksBySopId(sopId: string): Promise<number> {
  return getSchedulerService().sop.deleteBySopId(sopId);
}

export function runHookTasks(
  event: "startup" | "session.complete",
  context?: HookContext,
): void {
  getSchedulerService().hooks.runHooks(event, context);
}

// ─── Legacy injection shims (kept for main.ts call sites) ────────────────────

export function startScheduler(): void {
  void getSchedulerService().start();
}

export function stopScheduler(): void {
  getSchedulerService().stop();
}

export function setSchedulerSessionRunner(fn: SessionRunner): void {
  getSchedulerService().setSessionRunner(fn);
}

export function setSopRunner(fn: SopRunner): void {
  const svc = getSchedulerService();
  const existing = svc.sop.getCallbacks();
  svc.setSopCallbacks(fn, existing?.runSopStage ?? (() => {}));
}

export function setSopStageRunner(fn: SopStageRunner): void {
  const svc = getSchedulerService();
  const existing = svc.sop.getCallbacks();
  svc.setSopCallbacks(existing?.runSop ?? (() => {}), fn);
}

export async function runTaskNow(id: string): Promise<boolean> {
  return getSchedulerService().tasks.runNow(id);
}

export { readRunLog } from "./core/run-log.js";
export { getDefaultLogDir } from "./modules/task-scheduler.js";

export function invalidateTaskCache(): void {
  // No-op: new architecture has no TTL cache
}

export function calculateNextRun(task: Pick<ScheduledTask, "enabled" | "schedule">): string | undefined {
  if (!task.enabled) return undefined;
  const ms = calculateNextRunAtMs(task.schedule, Date.now());
  return ms ? new Date(ms).toISOString() : undefined;
}
