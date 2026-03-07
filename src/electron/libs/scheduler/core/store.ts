import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  SchedulerStoreV2,
  SchedulerStoreV1,
  LegacyTaskV1,
  ScheduledTask,
  SopScheduledTask,
  HookTask,
  ScheduleConfig,
} from "./types.js";

// ─── Default paths ─────────────────────────────────────────────────────────

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

// ─── Migration: v1 → v2 ──────────────────────────────────────────────────────

function buildScheduleConfigFromV1(t: LegacyTaskV1): ScheduleConfig | null {
  if (t.scheduleType === "once") {
    if (!t.scheduledTime) return null;
    return { kind: "once", scheduledTime: t.scheduledTime };
  }
  if (t.scheduleType === "interval") {
    if (t.intervalValue == null || !t.intervalUnit) return null;
    return {
      kind: "interval",
      intervalValue: t.intervalValue,
      intervalUnit: t.intervalUnit,
    };
  }
  if (t.scheduleType === "daily") {
    if (!t.dailyTime) return null;
    return {
      kind: "daily",
      dailyTime: t.dailyTime,
      ...(t.dailyDays?.length ? { dailyDays: t.dailyDays } : {}),
    };
  }
  return null;
}

function migrateV1ToV2(v1: SchedulerStoreV1): SchedulerStoreV2 {
  const tasks: ScheduledTask[] = [];
  const sopTasks: SopScheduledTask[] = [];
  const hooks: HookTask[] = [];

  for (const t of v1.tasks ?? []) {
    // Hook tasks → HookTask
    if (t.scheduleType === "hook") {
      if (!t.hookEvent) continue;
      hooks.push({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        prompt: t.prompt ?? "",
        hookEvent: t.hookEvent,
        hookFilter: t.hookFilter,
        assistantId: t.assistantId,
        lastRun: t.lastRun,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
      continue;
    }

    // Heartbeat tasks are handled separately by heartbeat.ts — skip
    if (t.scheduleType === "heartbeat") continue;

    const schedule = buildScheduleConfigFromV1(t);
    if (!schedule) continue;

    // SOP-linked tasks → SopScheduledTask
    if (t.sopId) {
      sopTasks.push({
        id: t.id,
        sopId: t.sopId,
        stageId: t.stageId,
        name: t.name,
        enabled: t.enabled,
        schedule,
        hidden: t.hidden ?? true,
        state: {
          nextRunAtMs: t.nextRun ? new Date(t.nextRun).getTime() : undefined,
          lastRunAtMs: t.lastRun ? new Date(t.lastRun).getTime() : undefined,
        },
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
      continue;
    }

    // Regular tasks → ScheduledTask
    tasks.push({
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      prompt: t.prompt ?? "",
      schedule,
      assistantId: t.assistantId,
      cwd: t.cwd,
      skillPath: t.skillPath,
      suppressIfShort: t.suppressIfShort,
      state: {
        nextRunAtMs: t.nextRun ? new Date(t.nextRun).getTime() : undefined,
        lastRunAtMs: t.lastRun ? new Date(t.lastRun).getTime() : undefined,
      },
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }

  return { version: 2, tasks, sopTasks, hooks };
}

// ─── Atomic write helpers ─────────────────────────────────────────────────────

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt),
        );
        continue;
      }
      // Windows: atomic rename may fail with EPERM/EEXIST when dest exists
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadStore(storePath: string): Promise<SchedulerStoreV2> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).version === 2
    ) {
      const v2 = parsed as SchedulerStoreV2;
      return {
        version: 2,
        tasks: Array.isArray(v2.tasks) ? v2.tasks : [],
        sopTasks: Array.isArray(v2.sopTasks) ? v2.sopTasks : [],
        hooks: Array.isArray(v2.hooks) ? v2.hooks : [],
      };
    }

    // Attempt v1 migration
    let v1Tasks: LegacyTaskV1[] = [];
    if (Array.isArray((parsed as Record<string, unknown>).tasks)) {
      v1Tasks = (parsed as SchedulerStoreV1).tasks;
    }
    return migrateV1ToV2({ tasks: v1Tasks });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { version: 2, tasks: [], sopTasks: [], hooks: [] };
    }
    throw err;
  }
}

export async function saveStore(
  storePath: string,
  store: SchedulerStoreV2,
  opts?: { skipBackup?: boolean },
): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const json = JSON.stringify(store, null, 2);

  // Best-effort backup of previous file
  if (!opts?.skipBackup) {
    const backupPath = `${storePath}.bak`;
    await fs.promises.copyFile(storePath, backupPath).catch(() => {});
  }

  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8" });
  await renameWithRetry(tmp, storePath);
}
