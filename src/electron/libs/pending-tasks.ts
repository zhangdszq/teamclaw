/**
 * Write-Ahead Log for bot messages being processed.
 *
 * DingTalk Stream ACKs messages immediately on receipt, so if the app crashes
 * mid-processing the message is gone from the server. This module persists
 * the message payload to disk before processing starts and removes it after
 * delivery succeeds (or fails with a user-visible error).
 *
 * On restart, any leftover entries are recovered and re-processed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { app } from "electron";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingTask {
  id: string;
  platform: "dingtalk" | "feishu";
  assistantId: string;
  /** Serialised platform message (DingtalkMessage / FeishuMessage) */
  msg: unknown;
  userText: string;
  hasFiles: boolean;
  createdAt: number;
}

interface PendingTasksState {
  tasks: PendingTask[];
}

// ─── File helpers ────────────────────────────────────────────────────────────

const MAX_TASK_AGE_MS = 30 * 60 * 1000; // 30 min — discard stale tasks on recovery

function getFilePath(): string {
  return join(app.getPath("userData"), "pending-tasks.json");
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

function readState(): PendingTasksState {
  const fp = getFilePath();
  if (!existsSync(fp)) return { tasks: [] };
  try {
    return JSON.parse(readFileSync(fp, "utf8")) as PendingTasksState;
  } catch {
    return { tasks: [] };
  }
}

function writeState(state: PendingTasksState): void {
  atomicWriteFile(getFilePath(), JSON.stringify(state, null, 2));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function savePendingTask(task: PendingTask): void {
  const state = readState();
  // Upsert by id
  const idx = state.tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    state.tasks[idx] = task;
  } else {
    state.tasks.push(task);
  }
  writeState(state);
}

export function removePendingTask(id: string): void {
  const state = readState();
  state.tasks = state.tasks.filter((t) => t.id !== id);
  writeState(state);
}

/**
 * Load pending tasks for a given platform (and optionally assistant).
 * Automatically discards tasks older than MAX_TASK_AGE_MS.
 */
export function loadPendingTasks(
  platform?: string,
  assistantId?: string,
): PendingTask[] {
  const state = readState();
  const now = Date.now();
  const stale: string[] = [];
  const result: PendingTask[] = [];

  for (const t of state.tasks) {
    if (now - t.createdAt > MAX_TASK_AGE_MS) {
      stale.push(t.id);
      continue;
    }
    if (platform && t.platform !== platform) continue;
    if (assistantId && t.assistantId !== assistantId) continue;
    result.push(t);
  }

  // Evict stale entries
  if (stale.length > 0) {
    state.tasks = state.tasks.filter((t) => !stale.includes(t.id));
    writeState(state);
    console.log(`[PendingTasks] Evicted ${stale.length} stale task(s)`);
  }

  return result;
}
