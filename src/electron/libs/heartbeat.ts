import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ClientEvent } from "../types.js";
import { loadAssistantsConfig, type AssistantConfig } from "./assistants-config.js";
import { readRecentNotified } from "./notification-log.js";
import { recordHeartbeatMetric } from "./heartbeat-metrics.js";

type SessionRunner = (event: ClientEvent) => Promise<void>;

const lastHeartbeatRun = new Map<string, number>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let memoryCompactTimer: NodeJS.Timeout | null = null;
const runningByAssistant = new Map<string, number>(); // assistantId -> startedAt
const lastCompletionAt = new Map<string, number>();
const lastCompletionOutcome = new Map<string, "no_action" | "action" | "error">();

const DAILY_MEMORY_MAX_CHARS = 4000;
const HEARTBEAT_RUN_TIMEOUT_MS = 10 * 60_000;
const RETRY_AFTER_ERROR_MS = 10 * 60_000;
const FORCE_RUN_MAX_SILENCE_MS = 4 * 60 * 60_000;

// ── Optimization A: memory mtime tracking (per assistant) ────────────────────
const lastMemoryMtime = new Map<string, number>();

// ── Optimization B: adaptive interval (consecutive no-action streak) ─────────
const noActionStreak = new Map<string, number>();

// ── Optimization C: incremental memory offset (per assistant) ────────────────
const lastMemoryOffset = new Map<string, number>();

function getTodayMemoryPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(homedir(), ".vk-cowork", "memory", "daily", `${today}.md`);
}

/** Returns the effective heartbeat interval in ms, extended by no-action streak. */
function effectiveInterval(baseMinutes: number, streak: number): number {
  const base = baseMinutes * 60_000;
  if (streak >= 6) return base * 4;
  if (streak >= 3) return base * 2;
  return base;
}

/**
 * Read only the portion of today's memory that was added since the last
 * heartbeat for this assistant. Falls back to last DAILY_MEMORY_MAX_CHARS
 * if this is the first run.
 */
function readMemoryDelta(assistantId: string): { delta: string; newOffset: number } | null {
  const path = getTodayMemoryPath();
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf8");
  if (!content.trim()) return null;

  const prevOffset = lastMemoryOffset.get(assistantId) ?? Math.max(0, content.length - DAILY_MEMORY_MAX_CHARS);
  const delta = content.slice(prevOffset).trim();

  return { delta, newOffset: content.length };
}

function buildHeartbeatPrompt(assistant: AssistantConfig): string {
  const sections: string[] = [];

  if (assistant.heartbeatRules?.trim()) {
    sections.push(`## 心跳行为规则\n${assistant.heartbeatRules.trim()}`);
  }

  // Optimization C: inject only new memory since last heartbeat
  const memResult = readMemoryDelta(assistant.id);
  if (memResult?.delta) {
    const today = new Date().toISOString().slice(0, 10);
    const label = lastMemoryOffset.has(assistant.id)
      ? `## 今日记忆新增内容（${today}，自上次心跳后）`
      : `## 今日记忆（${today}，最新部分）`;
    sections.push(`${label}\n${memResult.delta}`);
    // Update offset so next run only sees newer content
    lastMemoryOffset.set(assistant.id, memResult.newOffset);
  }

  // Optimization 1: inject recent notification history so AI avoids repeating
  const recentNotified = readRecentNotified(assistant.id);
  if (recentNotified.length > 0) {
    const lines = recentNotified.map((e) => {
      const time = new Date(e.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      return `- ${time}  ${e.summary}`;
    });
    sections.push(`## 今日已推送通知（不要重复汇报以下内容）\n${lines.join("\n")}`);
  }

  sections.push(
    "请根据以上规则，结合今日记忆中的待办/未完成事项执行心跳巡检。\n" +
    "如有需要通知的事项，使用 send_notification 工具主动推送给用户（不要设置 title 参数，直接在 text 中写内容）。\n" +
    "输出结尾必须包含一行结构化回执：HEARTBEAT_RESULT: {\"noAction\": true|false, \"reason\": \"一句话原因\"}。\n" +
    "若没有「已推送通知」列表之外的新情况，必须输出 noAction=true（并可附带 <no-action> 作为兼容兜底），禁止重复汇报。",
  );

  return sections.join("\n\n");
}

/**
 * Called from ipc-handlers when a heartbeat session finishes.
 * Updates the no-action streak counter for adaptive intervals.
 */
export function onHeartbeatResult(
  assistantId: string,
  wasNoAction: boolean,
  status: "completed" | "error" = "completed",
): void {
  const prev = noActionStreak.get(assistantId) ?? 0;
  const startedAt = runningByAssistant.get(assistantId);
  runningByAssistant.delete(assistantId);
  const durationMs = startedAt ? Date.now() - startedAt : undefined;
  lastCompletionAt.set(assistantId, Date.now());

  if (status === "error") {
    noActionStreak.set(assistantId, 0);
    lastCompletionOutcome.set(assistantId, "error");
    recordHeartbeatMetric("completed", {
      assistantId,
      outcome: "error",
      durationMs,
    });
    return;
  }

  noActionStreak.set(assistantId, wasNoAction ? prev + 1 : 0);
  lastCompletionOutcome.set(assistantId, wasNoAction ? "no_action" : "action");
  if (wasNoAction) {
    const streak = prev + 1;
    console.log(`[Heartbeat] ${assistantId} no-action streak: ${streak}`);
  }
  recordHeartbeatMetric("completed", {
    assistantId,
    outcome: wasNoAction ? "no_action" : "action",
    durationMs,
    streak: noActionStreak.get(assistantId) ?? 0,
  });
}

export function startHeartbeatLoop(runner: SessionRunner): void {
  if (heartbeatTimer) return;

  console.log("[Heartbeat] Starting heartbeat loop...");

  heartbeatTimer = setInterval(() => {
    const { assistants } = loadAssistantsConfig();
    const now = Date.now();
    const memPath = getTodayMemoryPath();

    for (const a of assistants) {
      const baseInterval = (a.heartbeatInterval ?? 30) * 60_000;
      const streak = noActionStreak.get(a.id) ?? 0;
      const interval = effectiveInterval(a.heartbeatInterval ?? 30, streak);
      const last = lastHeartbeatRun.get(a.id) ?? 0;

      if (now - last < interval) continue;

      const runningAt = runningByAssistant.get(a.id);
      if (runningAt) {
        const runningMs = now - runningAt;
        if (runningMs < HEARTBEAT_RUN_TIMEOUT_MS) {
          recordHeartbeatMetric("skipped", { assistantId: a.id, reason: "already_running", runningMs });
          continue;
        }
        console.warn(`[Heartbeat] Cleared stale running lock for ${a.name} after ${Math.round(runningMs / 1000)}s`);
        runningByAssistant.delete(a.id);
      }

      // Optimization A: skip if memory file has not changed since last run
      if (existsSync(memPath)) {
        const mtime = statSync(memPath).mtimeMs;
        if (mtime === lastMemoryMtime.get(a.id)) {
          const completionAt = lastCompletionAt.get(a.id) ?? 0;
          const completionOutcome = lastCompletionOutcome.get(a.id);
          const shouldRetryAfterError =
            completionOutcome === "error" &&
            completionAt > 0 &&
            now - completionAt >= RETRY_AFTER_ERROR_MS;
          const shouldForceRunAfterSilence =
            completionAt > 0 &&
            now - completionAt >= FORCE_RUN_MAX_SILENCE_MS;
          if (!shouldRetryAfterError && !shouldForceRunAfterSilence) {
            console.log(`[Heartbeat] Skipping ${a.name}: memory unchanged`);
            // Still update lastHeartbeatRun so we don't spam the log every minute
            lastHeartbeatRun.set(a.id, now);
            recordHeartbeatMetric("skipped", { assistantId: a.id, reason: "memory_unchanged" });
            continue;
          }
          const forceReason = shouldRetryAfterError ? "retry_after_error" : "force_after_silence";
          console.log(`[Heartbeat] Forcing ${a.name}: ${forceReason}`);
          recordHeartbeatMetric("triggered", { assistantId: a.id, reason: forceReason });
        }
        lastMemoryMtime.set(a.id, mtime);
      }

      lastHeartbeatRun.set(a.id, now);
      recordHeartbeatMetric("triggered", {
        assistantId: a.id,
        reason: "interval_due",
        intervalMs: interval,
        baseIntervalMs: baseInterval,
      });
      runAssistantHeartbeat(a, runner);
    }
  }, 60_000);
}

export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("[Heartbeat] Heartbeat loop stopped");
  }
}

/**
 * Clean up heartbeat data for a specific assistant.
 * Call this when an assistant is deleted or reconfigured.
 */
export function cleanupHeartbeatData(assistantId: string): void {
  lastHeartbeatRun.delete(assistantId);
  lastMemoryMtime.delete(assistantId);
  noActionStreak.delete(assistantId);
  lastMemoryOffset.delete(assistantId);
  runningByAssistant.delete(assistantId);
  lastCompletionAt.delete(assistantId);
  lastCompletionOutcome.delete(assistantId);
  console.log(`[Heartbeat] Cleaned up data for assistant: ${assistantId}`);
}

function runAssistantHeartbeat(assistant: AssistantConfig, runner: SessionRunner): void {
  const prompt = buildHeartbeatPrompt(assistant);
  const streak = noActionStreak.get(assistant.id) ?? 0;
  console.log(`[Heartbeat] Running heartbeat for assistant: ${assistant.name} (streak=${streak})`);
  runningByAssistant.set(assistant.id, Date.now());

  runner({
    type: "session.start",
    payload: {
      title: `[心跳] ${assistant.name}`,
      prompt,
      cwd: assistant.defaultCwd,
      assistantId: assistant.id,
      assistantSkillNames: assistant.skillNames ?? [],
      provider: assistant.provider,
      model: assistant.model,
      background: true,
    },
  }).catch((e) => {
    runningByAssistant.delete(assistant.id);
    lastCompletionAt.set(assistant.id, Date.now());
    lastCompletionOutcome.set(assistant.id, "error");
    recordHeartbeatMetric("completed", {
      assistantId: assistant.id,
      outcome: "start_error",
    });
    console.error(`[Heartbeat] Failed for "${assistant.name}":`, e);
  });
}

export function startMemoryCompactTimer(runner: SessionRunner): void {
  if (memoryCompactTimer) return;

  console.log("[Heartbeat] Starting memory compaction timer (weekly Mon 03:00)...");

  let lastCompactWeek = -1;

  const checkCompaction = () => {
    const now = new Date();
    const week = getISOWeek(now);
    if (now.getDay() === 1 && now.getHours() === 3 && now.getMinutes() === 0 && week !== lastCompactWeek) {
      lastCompactWeek = week;
      const config = loadAssistantsConfig();
      const assistant = config.assistants.find((a) => a.id === config.defaultAssistantId) ?? config.assistants[0];
      if (!assistant) return;

      const prompt = `请执行每周记忆压缩任务：
1. 读取 ~/.vk-cowork/memory/daily/ 目录下最近 7 天的日志文件（L2）
2. 将本周的关键事件、决策、和洞察提炼，追加到 ~/.vk-cowork/memory/insights/${now.toISOString().slice(0, 7)}.md（L1）
3. 更新 ~/.vk-cowork/memory/insights/.abstract 索引
完成后汇报压缩了哪些内容。`;

      console.log("[Heartbeat] Running weekly memory compaction...");
      runner({
        type: "session.start",
        payload: {
          title: "[记忆压缩] L2→L1",
          prompt,
          cwd: assistant.defaultCwd,
          assistantId: assistant.id,
          assistantSkillNames: assistant.skillNames ?? [],
          provider: assistant.provider,
          model: assistant.model,
          background: true,
        },
      }).catch((e) => console.error("[Heartbeat] Memory compaction failed:", e));
    }
  };

  memoryCompactTimer = setInterval(checkCompaction, 60_000);
}

export function stopMemoryCompactTimer(): void {
  if (memoryCompactTimer) {
    clearInterval(memoryCompactTimer);
    memoryCompactTimer = null;
  }
}

/** Returns ISO week number for a given date. */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
