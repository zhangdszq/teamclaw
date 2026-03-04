import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
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
const lastAssistantMemoryMtime = new Map<string, number>();

// ── Optimization B: adaptive interval (consecutive no-action streak) ─────────
const noActionStreak = new Map<string, number>();

// ── Optimization C: incremental memory offset (per assistant) ────────────────
const lastMemoryOffset = new Map<string, number>();
const lastAssistantMemoryOffset = new Map<string, number>();

// ── Compaction persistence ────────────────────────────────────────────────────
const MEMORY_ROOT = join(homedir(), ".vk-cowork", "memory");
const COMPACT_STATE_FILE = join(MEMORY_ROOT, ".last-compact-key");
const COMPACT_LAST_RUN_FILE = join(MEMORY_ROOT, "insights", ".last-run");

/** Key used for the compaction currently in progress (to be written on success). */
let pendingCompactKey = "";

// ── Path helpers ─────────────────────────────────────────────────────────────

function getTodayMemoryPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(MEMORY_ROOT, "daily", `${today}.md`);
}

function getAssistantDailyPath(assistantId: string, date?: string): string {
  const today = date ?? new Date().toISOString().slice(0, 10);
  return join(MEMORY_ROOT, "assistants", assistantId, "daily", `${today}.md`);
}

// ── ISO week helpers ──────────────────────────────────────────────────────────

/** Returns ISO week number for a given date. */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Returns a cross-year-safe compaction key like "2026-W03".
 * String comparison is safe across year boundaries unlike bare week numbers.
 */
function compactKey(date: Date): string {
  return `${date.getFullYear()}-W${String(getISOWeek(date)).padStart(2, "0")}`;
}

// ── Compact state I/O ─────────────────────────────────────────────────────────

function readLastCompactKey(): string {
  try {
    return readFileSync(COMPACT_STATE_FILE, "utf8").trim();
  } catch { return ""; }
}

function writeLastCompactKey(key: string): void {
  try { writeFileSync(COMPACT_STATE_FILE, key, "utf8"); } catch { /* non-blocking */ }
}

function writeLastRunMetadata(key: string): void {
  try {
    const insightsDir = join(MEMORY_ROOT, "insights");
    if (!existsSync(insightsDir)) mkdirSync(insightsDir, { recursive: true });
    writeFileSync(
      COMPACT_LAST_RUN_FILE,
      JSON.stringify({ key, ranAt: new Date().toISOString() }),
      "utf8",
    );
  } catch { /* non-blocking */ }
}

export function readLastCompactionAt(): string | null {
  try {
    const raw = readFileSync(COMPACT_LAST_RUN_FILE, "utf8").trim();
    const parsed = JSON.parse(raw) as { ranAt?: string };
    return parsed.ranAt ?? null;
  } catch { return null; }
}

// ── Heartbeat interval helpers ────────────────────────────────────────────────

/** Returns the effective heartbeat interval in ms, extended by no-action streak. */
function effectiveInterval(baseMinutes: number, streak: number): number {
  const base = baseMinutes * 60_000;
  if (streak >= 6) return base * 4;
  if (streak >= 3) return base * 2;
  return base;
}

// ── Memory delta readers ──────────────────────────────────────────────────────

/**
 * Read only the portion of today's shared daily that was added since the last
 * heartbeat for this assistant.
 */
function readSharedMemoryDelta(assistantId: string): { delta: string; newOffset: number } | null {
  const path = getTodayMemoryPath();
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf8");
  if (!content.trim()) return null;

  const prevOffset = lastMemoryOffset.get(assistantId) ?? Math.max(0, content.length - DAILY_MEMORY_MAX_CHARS);
  const delta = content.slice(prevOffset).trim();

  return { delta, newOffset: content.length };
}

/**
 * Read only the portion of today's assistant-private daily that was added
 * since the last heartbeat for this assistant.
 */
function readAssistantMemoryDelta(assistantId: string): { delta: string; newOffset: number } | null {
  const path = getAssistantDailyPath(assistantId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf8");
  if (!content.trim()) return null;

  const prevOffset = lastAssistantMemoryOffset.get(assistantId) ?? Math.max(0, content.length - DAILY_MEMORY_MAX_CHARS);
  const delta = content.slice(prevOffset).trim();

  return { delta, newOffset: content.length };
}

// ── Heartbeat prompt builder ──────────────────────────────────────────────────

function buildHeartbeatPrompt(assistant: AssistantConfig): string {
  const sections: string[] = [];

  if (assistant.heartbeatRules?.trim()) {
    sections.push(`## 心跳行为规则\n${assistant.heartbeatRules.trim()}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Shared daily delta (Optimization C)
  const sharedResult = readSharedMemoryDelta(assistant.id);
  if (sharedResult?.delta) {
    const label = lastMemoryOffset.has(assistant.id)
      ? `## 今日共享记忆新增内容（${today}，自上次心跳后）`
      : `## 今日共享记忆（${today}，最新部分）`;
    sections.push(`${label}\n${sharedResult.delta}`);
    lastMemoryOffset.set(assistant.id, sharedResult.newOffset);
  }

  // Assistant-private daily delta (BUG 2 fix)
  const assistantResult = readAssistantMemoryDelta(assistant.id);
  if (assistantResult?.delta) {
    const label = lastAssistantMemoryOffset.has(assistant.id)
      ? `## 今日对话日志新增内容（${today}，自上次心跳后）`
      : `## 今日对话日志（${today}，最新部分）`;
    sections.push(`${label}\n${assistantResult.delta}`);
    lastAssistantMemoryOffset.set(assistant.id, assistantResult.newOffset);
  }

  // Recent notification history to avoid repeating
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

// ── Heartbeat result handler ──────────────────────────────────────────────────

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

/**
 * Called from ipc-handlers when a compaction session finishes.
 * Only persists the compact key on success, so failed compactions are retried.
 */
export function onCompactionResult(succeeded: boolean): void {
  if (succeeded && pendingCompactKey) {
    writeLastCompactKey(pendingCompactKey);
    writeLastRunMetadata(pendingCompactKey);
    console.log(`[Heartbeat] Memory compaction succeeded, persisted key: ${pendingCompactKey}`);
  } else if (!succeeded) {
    console.warn("[Heartbeat] Memory compaction failed or errored, will retry next opportunity");
  }
  pendingCompactKey = "";
}

// ── Heartbeat loop ────────────────────────────────────────────────────────────

export function startHeartbeatLoop(runner: SessionRunner): void {
  if (heartbeatTimer) return;

  console.log("[Heartbeat] Starting heartbeat loop...");

  heartbeatTimer = setInterval(() => {
    const { assistants } = loadAssistantsConfig();
    const now = Date.now();
    const sharedMemPath = getTodayMemoryPath();

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

      // Optimization A: skip if neither shared daily nor assistant daily has changed
      const assistantMemPath = getAssistantDailyPath(a.id);
      const sharedMtime = existsSync(sharedMemPath) ? statSync(sharedMemPath).mtimeMs : 0;
      const assistantMtime = existsSync(assistantMemPath) ? statSync(assistantMemPath).mtimeMs : 0;
      const latestMtime = Math.max(sharedMtime, assistantMtime);

      if (latestMtime > 0 && latestMtime === lastMemoryMtime.get(a.id)) {
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
          lastHeartbeatRun.set(a.id, now);
          recordHeartbeatMetric("skipped", { assistantId: a.id, reason: "memory_unchanged" });
          continue;
        }
        const forceReason = shouldRetryAfterError ? "retry_after_error" : "force_after_silence";
        console.log(`[Heartbeat] Forcing ${a.name}: ${forceReason}`);
        recordHeartbeatMetric("triggered", { assistantId: a.id, reason: forceReason });
      }
      if (latestMtime > 0) {
        lastMemoryMtime.set(a.id, latestMtime);
        lastAssistantMemoryMtime.set(a.id, assistantMtime);
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
  lastAssistantMemoryMtime.delete(assistantId);
  noActionStreak.delete(assistantId);
  lastMemoryOffset.delete(assistantId);
  lastAssistantMemoryOffset.delete(assistantId);
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

// ── Memory compaction ─────────────────────────────────────────────────────────

/**
 * Build the compaction prompt for an assistant, covering both shared daily
 * and all assistant-private daily directories (BUG 3 fix).
 */
function buildCompactionPrompt(assistants: AssistantConfig[]): string {
  const now = new Date();
  const yearMonth = now.toISOString().slice(0, 7);

  const assistantDailyPaths = assistants
    .map((a) => `  - ~/.vk-cowork/memory/assistants/${a.id}/daily/ （${a.name}）`)
    .join("\n");

  const assistantInsightPaths = assistants
    .map((a) => `  - ~/.vk-cowork/memory/assistants/${a.id}/insights/${yearMonth}.md （${a.name}）`)
    .join("\n");

  return `请执行每周记忆压缩任务：

1. 读取最近 7 天的日志文件（L2），包含以下目录：
   - ~/.vk-cowork/memory/daily/ （共享日志）
${assistantDailyPaths}

2. 将本周的关键事件、决策和洞察提炼，写入以下 L1 文件（内容追加，不要覆盖历史）：
   - ~/.vk-cowork/memory/insights/${yearMonth}.md （共享洞察）
${assistantInsightPaths}

3. 更新 ~/.vk-cowork/memory/insights/.abstract 索引，同时更新各助手对应的 insights/.abstract（如存在）

完成后输出一行压缩摘要：COMPACTION_DONE: {"weeks": 1, "entries": <提炼条目数>}`;
}

/**
 * Start a compaction session for the given key. Sets pendingCompactKey so that
 * ipc-handlers can call onCompactionResult() when the session finishes.
 */
function runCompaction(runner: SessionRunner, key: string): void {
  if (pendingCompactKey) {
    console.log(`[Heartbeat] Compaction already in progress (key=${pendingCompactKey}), skipping`);
    return;
  }

  const config = loadAssistantsConfig();
  const assistant = config.assistants.find((a) => a.id === config.defaultAssistantId) ?? config.assistants[0];
  if (!assistant) {
    console.warn("[Heartbeat] No assistant configured, cannot run compaction");
    return;
  }

  pendingCompactKey = key;
  const prompt = buildCompactionPrompt(config.assistants);

  console.log(`[Heartbeat] Running memory compaction for key=${key}...`);
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
  }).catch((e) => {
    console.error("[Heartbeat] Memory compaction start failed:", e);
    pendingCompactKey = ""; // reset so next check can retry
  });
}

export function startMemoryCompactTimer(runner: SessionRunner): void {
  if (memoryCompactTimer) return;

  console.log("[Heartbeat] Starting memory compaction timer (weekly Mon 03:xx, with catch-up)...");

  let lastCompactKey = readLastCompactKey();
  const currentKey = compactKey(new Date());

  // Catch-up: run immediately if a compaction was missed while app was closed.
  // Skip on very first run (no persisted key) to avoid unexpected compaction on first launch.
  if (lastCompactKey && currentKey > lastCompactKey) {
    console.log(`[Heartbeat] Compaction overdue (last=${lastCompactKey || "never"}, now=${currentKey}). Catching up in 15s...`);
    setTimeout(() => {
      lastCompactKey = currentKey;
      runCompaction(runner, currentKey);
    }, 15_000);
  }

  // Periodic check: relaxed to hour-level (no minute match) to avoid timing window misses.
  memoryCompactTimer = setInterval(() => {
    const now = new Date();
    const key = compactKey(now);
    // Run at any point during Monday 03:xx, once per ISO week.
    if (now.getDay() === 1 && now.getHours() === 3 && key !== lastCompactKey) {
      lastCompactKey = key; // Update in-memory to prevent double-trigger within same hour
      runCompaction(runner, key);
    }
  }, 60_000);
}

export function stopMemoryCompactTimer(): void {
  if (memoryCompactTimer) {
    clearInterval(memoryCompactTimer);
    memoryCompactTimer = null;
  }
}
