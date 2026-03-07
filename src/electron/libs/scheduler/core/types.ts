// ─── Scheduler core types ─────────────────────────────────────────────────────
// Unified type definitions for the scheduler subsystem.
// These types are pure (no Electron dependencies) to enable unit testing.

// ─── Schedule configuration ──────────────────────────────────────────────────

export type ScheduleConfig =
  | { kind: "once"; scheduledTime: string }
  | {
      kind: "interval";
      intervalValue: number;
      intervalUnit: "minutes" | "hours" | "days" | "weeks";
      anchorMs?: number;
    }
  | { kind: "daily"; dailyTime: string; dailyDays?: number[] }
  | { kind: "cron"; expr: string; timezone?: string };

// ─── Task runtime state ───────────────────────────────────────────────────────

export interface TaskState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  consecutiveErrors?: number;
  runningAtMs?: number;
}

// ─── Regular (general-purpose) task ──────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: ScheduleConfig;
  assistantId?: string;
  cwd?: string;
  skillPath?: string;
  suppressIfShort?: boolean;
  notifyText?: string;
  timeoutSeconds?: number;
  failureAlertAfter?: number;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

export type TaskCreateInput = Omit<ScheduledTask, "id" | "state" | "createdAt" | "updatedAt"> & {
  state?: Partial<TaskState>;
};

// ─── SOP workflow task (decoupled) ────────────────────────────────────────────

export interface SopScheduledTask {
  id: string;
  sopId: string;
  stageId?: string;
  name: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  hidden: boolean;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

export type SopTaskCreateInput = Omit<SopScheduledTask, "id" | "state" | "createdAt" | "updatedAt"> & {
  state?: Partial<TaskState>;
};

// ─── Hook task ────────────────────────────────────────────────────────────────

export interface HookTaskFilter {
  assistantId?: string;
  titlePattern?: string;
  onlyOnError?: boolean;
}

export interface HookTask {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  hookEvent: "startup" | "session.complete";
  hookFilter?: HookTaskFilter;
  assistantId?: string;
  lastRun?: string;
  createdAt: string;
  updatedAt: string;
}

export type HookTaskCreateInput = Omit<HookTask, "id" | "createdAt" | "updatedAt">;

export interface HookContext {
  assistantId?: string;
  status?: string;
  sessionTitle?: string;
}

// ─── Run log record ───────────────────────────────────────────────────────────

export interface RunRecord {
  taskId: string;
  taskName: string;
  taskKind: "task" | "sop" | "hook";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error" | "skipped";
  error?: string;
}

// ─── Store file formats ───────────────────────────────────────────────────────

export interface SchedulerStoreV1 {
  tasks: LegacyTaskV1[];
}

export interface LegacyTaskV1 {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  scheduleType: "once" | "interval" | "daily" | "heartbeat" | "hook";
  scheduledTime?: string;
  intervalValue?: number;
  intervalUnit?: "minutes" | "hours" | "days" | "weeks";
  dailyTime?: string;
  dailyDays?: number[];
  heartbeatInterval?: number;
  suppressIfShort?: boolean;
  hookEvent?: "startup" | "session.complete";
  hookFilter?: HookTaskFilter;
  lastRun?: string;
  nextRun?: string;
  sopId?: string;
  stageId?: string;
  hidden?: boolean;
  assistantId?: string;
  cwd?: string;
  skillPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerStoreV2 {
  version: 2;
  tasks: ScheduledTask[];
  sopTasks: SopScheduledTask[];
  hooks: HookTask[];
}
