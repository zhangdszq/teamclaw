import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app } from "electron";
import type { ClientEvent } from "../types.js";
import { loadAssistantsConfig } from "./assistants-config.js";

// Task cache to reduce frequent file I/O
let taskCache: ScheduledTask[] | null = null;
let taskCacheTime = 0;
const TASK_CACHE_TTL_MS = 60000; // 1 minute cache

// Types
export interface ScheduledTaskHookFilter {
  assistantId?: string;
  titlePattern?: string;
  onlyOnError?: boolean;
}

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  // Task configuration
  prompt: string;
  cwd?: string;
  skillPath?: string;
  assistantId?: string;
  // Schedule configuration
  scheduleType: "once" | "interval" | "daily" | "heartbeat" | "hook";
  // For "once" type
  scheduledTime?: string;  // ISO date string
  // For "interval" type
  intervalValue?: number;
  intervalUnit?: "minutes" | "hours" | "days" | "weeks";
  // For "daily" type — fixed clock time, optional day-of-week filter
  dailyTime?: string;    // "HH:MM"
  dailyDays?: number[];  // 0=Sun…6=Sat; empty = every day
  // For "heartbeat" type — periodic self-check
  heartbeatInterval?: number;  // minutes, default 30
  suppressIfShort?: boolean;   // hide session if response < 80 chars or contains <no-action>
  // For "hook" type — triggered by internal events, not time-based
  hookEvent?: "startup" | "session.complete";
  hookFilter?: ScheduledTaskHookFilter;
  lastRun?: string;  // ISO date string
  nextRun?: string;  // ISO date string
  // Metadata
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerState {
  tasks: ScheduledTask[];
}

// ─── SessionRunner injection ──────────────────────────────────
type SessionRunner = (event: ClientEvent) => Promise<void>;
let sessionRunner: SessionRunner | null = null;

export function setSchedulerSessionRunner(fn: SessionRunner): void {
  sessionRunner = fn;
}

// File path
const SCHEDULER_FILE = join(app.getPath("userData"), "scheduled-tasks.json");

// Ensure directory exists
function ensureDirectory() {
  const dir = dirname(SCHEDULER_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Load tasks with caching to reduce I/O
export function loadScheduledTasks(): ScheduledTask[] {
  const now = Date.now();

  // Return cached tasks if still valid
  if (taskCache !== null && (now - taskCacheTime) < TASK_CACHE_TTL_MS) {
    return taskCache;
  }

  try {
    if (!existsSync(SCHEDULER_FILE)) {
      taskCache = [];
      taskCacheTime = now;
      return [];
    }
    const raw = readFileSync(SCHEDULER_FILE, "utf8");
    const state = JSON.parse(raw) as SchedulerState;
    taskCache = state.tasks || [];
    taskCacheTime = now;
    return taskCache;
  } catch (error) {
    console.error("Failed to load scheduled tasks:", error);
    return [];
  }
}

// Invalidate cache when tasks are modified
export function invalidateTaskCache(): void {
  taskCache = null;
  taskCacheTime = 0;
}

// Save tasks
export function saveScheduledTasks(tasks: ScheduledTask[]): void {
  ensureDirectory();
  const state: SchedulerState = { tasks };
  writeFileSync(SCHEDULER_FILE, JSON.stringify(state, null, 2), "utf8");
  // Invalidate cache after saving
  invalidateTaskCache();
}

// Add task
export function addScheduledTask(task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">): ScheduledTask {
  const tasks = loadScheduledTasks();
  const newTask: ScheduledTask = {
    ...task,
    id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  
  // Calculate next run time
  newTask.nextRun = calculateNextRun(newTask);
  
  tasks.push(newTask);
  saveScheduledTasks(tasks);
  return newTask;
}

// Update task
export function updateScheduledTask(id: string, updates: Partial<ScheduledTask>): ScheduledTask | null {
  const tasks = loadScheduledTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return null;
  
  tasks[index] = {
    ...tasks[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  
  // Recalculate next run time
  tasks[index].nextRun = calculateNextRun(tasks[index]);
  
  saveScheduledTasks(tasks);
  return tasks[index];
}

// Delete task
export function deleteScheduledTask(id: string): boolean {
  const tasks = loadScheduledTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return false;
  
  tasks.splice(index, 1);
  saveScheduledTasks(tasks);
  return true;
}

// Calculate next run time
export function calculateNextRun(task: ScheduledTask): string | undefined {
  if (!task.enabled) return undefined;
  
  // Hook tasks are event-driven, not time-based
  if (task.scheduleType === "hook") return undefined;

  const now = new Date();
  
  if (task.scheduleType === "once") {
    if (!task.scheduledTime) return undefined;
    const scheduled = new Date(task.scheduledTime);
    return scheduled > now ? task.scheduledTime : undefined;
  }
  
  // Heartbeat tasks are now handled by heartbeat.ts process-level timer
  if (task.scheduleType === "heartbeat") return undefined;

  if (task.scheduleType === "interval") {
    if (!task.intervalValue || !task.intervalUnit) return undefined;
    
    const lastRun = task.lastRun ? new Date(task.lastRun) : now;
    const nextRun = new Date(lastRun);
    
    switch (task.intervalUnit) {
      case "minutes":
        nextRun.setMinutes(nextRun.getMinutes() + task.intervalValue);
        break;
      case "hours":
        nextRun.setHours(nextRun.getHours() + task.intervalValue);
        break;
      case "days":
        nextRun.setDate(nextRun.getDate() + task.intervalValue);
        break;
      case "weeks":
        nextRun.setDate(nextRun.getDate() + task.intervalValue * 7);
        break;
    }
    
    // If next run is in the past, calculate from now
    if (nextRun <= now) {
      const newNextRun = new Date(now);
      switch (task.intervalUnit) {
        case "minutes":
          newNextRun.setMinutes(newNextRun.getMinutes() + task.intervalValue);
          break;
        case "hours":
          newNextRun.setHours(newNextRun.getHours() + task.intervalValue);
          break;
        case "days":
          newNextRun.setDate(newNextRun.getDate() + task.intervalValue);
          break;
        case "weeks":
          newNextRun.setDate(newNextRun.getDate() + task.intervalValue * 7);
          break;
      }
      return newNextRun.toISOString();
    }
    
    return nextRun.toISOString();
  }

  if (task.scheduleType === "daily") {
    if (!task.dailyTime) return undefined;
    const [hours, minutes] = task.dailyTime.split(":").map(Number);

    // Start candidate at today's target time
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);

    // If that moment has already passed today, advance to tomorrow
    if (candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }

    // If specific weekdays are required, find the next matching day (≤7 iterations)
    if (task.dailyDays && task.dailyDays.length > 0) {
      for (let i = 0; i < 8; i++) {
        if (task.dailyDays.includes(candidate.getDay())) {
          return candidate.toISOString();
        }
        candidate.setDate(candidate.getDate() + 1);
      }
      return undefined;
    }

    return candidate.toISOString();
  }
  
  return undefined;
}

// ─── Run a single scheduled task via sessionRunner ───────────
function runScheduledTask(task: ScheduledTask): void {
  // Combine updates into a single atomic operation
  const updates: Partial<ScheduledTask> = { lastRun: new Date().toISOString() };
  if (task.scheduleType === "once") {
    updates.enabled = false;
  }
  updateScheduledTask(task.id, updates);

  if (!sessionRunner) {
    console.warn(`[Scheduler] sessionRunner not set, cannot run task: ${task.name}`);
    return;
  }

  // Look up assistant config to get skills, persona, provider, model
  const config = loadAssistantsConfig();
  const assistant = task.assistantId
    ? config.assistants.find(a => a.id === task.assistantId)
    : config.assistants.find(a => a.id === config.defaultAssistantId) ?? config.assistants[0];

  const isHeartbeat = task.scheduleType === "heartbeat";
  const title = isHeartbeat
    ? `[心跳] ${task.name}`
    : `定时任务: ${task.name}`;

  sessionRunner({
    type: "session.start",
    payload: {
      title,
      prompt: task.prompt,
      cwd: task.cwd || assistant?.defaultCwd,
      assistantId: assistant?.id,
      assistantSkillNames: assistant?.skillNames ?? [],
      assistantPersona: assistant?.persona,
      provider: assistant?.provider ?? "claude",
      model: assistant?.model,
    },
  }).catch(e => console.error(`[Scheduler] Failed to start session for task "${task.name}":`, e));
}

// ─── Run hook tasks triggered by an internal event ───────────
export function runHookTasks(
  hookEvent: "startup" | "session.complete",
  context?: { assistantId?: string; status?: string }
): void {
  if (!sessionRunner) return;

  const tasks = loadScheduledTasks().filter(
    t => t.enabled && t.scheduleType === "hook" && t.hookEvent === hookEvent
  );

  for (const task of tasks) {
    const f = task.hookFilter;
    if (f?.assistantId && context?.assistantId !== f.assistantId) continue;
    if (f?.onlyOnError && context?.status !== "error") continue;
    if (f?.titlePattern) {
      // titlePattern filter is checked in ipc-handlers where we have the session title
    }
    console.log(`[Scheduler] Running hook task "${task.name}" for event: ${hookEvent}`);
    runScheduledTask(task);
  }
}

// ─── Scheduler loop ──────────────────────────────────────────
let schedulerInterval: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (schedulerInterval) return;
  
  console.log("[Scheduler] Starting scheduler...");
  
  // Check every minute
  schedulerInterval = setInterval(() => {
    checkAndRunTasks();
  }, 60 * 1000);
  
  // Also check immediately
  checkAndRunTasks();
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Scheduler] Scheduler stopped");
  }
}

function checkAndRunTasks(): void {
  const tasks = loadScheduledTasks();
  const now = new Date();
  
  for (const task of tasks) {
    // Hook tasks are event-driven, skip in time-based loop
    if (task.scheduleType === "hook") continue;
    if (!task.enabled || !task.nextRun) continue;
    
    const nextRun = new Date(task.nextRun);
    
    if (nextRun <= now) {
      console.log(`[Scheduler] Running task: ${task.name} (${task.scheduleType})`);
      runScheduledTask(task);
    }
  }
}

// Get due tasks count (for badge display)
export function getDueTasksCount(): number {
  const tasks = loadScheduledTasks();
  const now = new Date();
  let count = 0;
  
  for (const task of tasks) {
    if (task.enabled && task.nextRun) {
      const nextRun = new Date(task.nextRun);
      // Count tasks due within next hour
      if (nextRun.getTime() - now.getTime() < 60 * 60 * 1000) {
        count++;
      }
    }
  }
  
  return count;
}
