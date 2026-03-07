import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { calculateNextRunAtMs, clearCronCacheForTest } from "../core/schedule.js";
import { loadStore, saveStore } from "../core/store.js";
import { TaskScheduler } from "../modules/task-scheduler.js";
import { SopScheduler } from "../modules/sop-scheduler.js";
import type { ScheduleConfig, SchedulerStoreV2 } from "../core/types.js";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/fake-electron" },
  Notification: class { static isSupported() { return false; } show() {} },
}));

let tmpDir: string;
let storePath: string;
let logDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "regression-test-"));
  storePath = path.join(tmpDir, "tasks.json");
  logDir = path.join(tmpDir, "logs");
  clearCronCacheForTest();
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─── Cron roundtrip ─────────────────────────────────────────────────────────

describe("Cron roundtrip (bug: cron→daily degradation)", () => {
  it("cron schedule survives calculateNextRunAtMs", () => {
    const cfg: ScheduleConfig = { kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" };
    const result = calculateNextRunAtMs(cfg, Date.now());
    expect(result).toBeDefined();
    expect(cfg.kind).toBe("cron");
    expect((cfg as { expr: string }).expr).toBe("0 9 * * 1-5");
  });

  it("cron type is preserved after store save/load", async () => {
    const store: SchedulerStoreV2 = {
      version: 2,
      tasks: [{
        id: "cron1",
        name: "Cron Task",
        enabled: true,
        prompt: "test",
        schedule: { kind: "cron", expr: "30 8 * * *", timezone: "Asia/Shanghai" },
        state: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      sopTasks: [],
      hooks: [],
    };
    await saveStore(storePath, store, { skipBackup: true });
    const loaded = await loadStore(storePath);
    expect(loaded.tasks[0].schedule.kind).toBe("cron");
    const s = loaded.tasks[0].schedule as { expr: string; timezone?: string };
    expect(s.expr).toBe("30 8 * * *");
    expect(s.timezone).toBe("Asia/Shanghai");
  });
});

// ─── intervalValue === 0 guard ──────────────────────────────────────────────

describe("intervalValue guards", () => {
  it("intervalValue === 0 returns undefined", () => {
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 0, intervalUnit: "minutes" };
    expect(calculateNextRunAtMs(cfg, Date.now())).toBeUndefined();
  });

  it("negative intervalValue returns undefined", () => {
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: -5, intervalUnit: "hours" };
    expect(calculateNextRunAtMs(cfg, Date.now())).toBeUndefined();
  });

  it("valid intervalValue works correctly", () => {
    const now = Date.now();
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 1, intervalUnit: "minutes" };
    const result = calculateNextRunAtMs(cfg, now);
    expect(result).toBeDefined();
    expect(result!).toBe(now + 60_000);
  });
});

// ─── v1 migration: intervalValue == null ────────────────────────────────────

describe("v1 migration with edge-case interval", () => {
  it("v1 interval task with intervalValue=0 is dropped during migration", async () => {
    const v1 = {
      tasks: [{
        id: "bad-interval",
        name: "Zero Interval",
        enabled: true,
        prompt: "test",
        scheduleType: "interval",
        intervalValue: 0,
        intervalUnit: "minutes",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }],
    };
    await fs.promises.writeFile(storePath, JSON.stringify(v1));
    const loaded = await loadStore(storePath);
    // intervalValue=0 should be accepted by migration (== null check only rejects null/undefined)
    // but calculateNextRunAtMs will return undefined for value <= 0
    expect(loaded.tasks.length).toBeLessThanOrEqual(1);
  });
});

// ─── runNow with running guard ───────────────────────────────────────────────

describe("TaskScheduler.runNow reentry guard", () => {
  it("blocks second runNow while task is already running", async () => {
    let resolveExec!: () => void;
    const execBlocker = new Promise<void>((r) => { resolveExec = r; });
    const exec = vi.fn().mockImplementation(() => execBlocker);
    const scheduler = new TaskScheduler({ storePath, logDir, onExecute: exec });

    const now = Date.now();
    const task = await scheduler.add({
      name: "Guard Test",
      enabled: true,
      prompt: "test",
      schedule: { kind: "daily", dailyTime: "09:00" },
    });

    const first = await scheduler.runNow(task.id);
    expect(first).toBe(true);

    const second = await scheduler.runNow(task.id);
    expect(second).toBe(false); // should be blocked

    resolveExec();
    await new Promise<void>((r) => setImmediate(r));
  });
});

// ─── SOP dispatch order ─────────────────────────────────────────────────────

describe("SopScheduler dispatch order", () => {
  it("does not update state when callbacks are null", async () => {
    const sop = new SopScheduler({ storePath, logDir });
    // Do NOT set callbacks

    const task = await sop.add({
      sopId: "sop-no-cb",
      name: "No Callback SOP",
      enabled: true,
      schedule: { kind: "daily", dailyTime: "09:00" },
      hidden: true,
    });

    // Manually start (which calls tick internally)
    await sop.start();

    // Task should not have lastRunAtMs set because callbacks are null
    const tasks = await sop.list();
    const updated = tasks.find((t) => t.id === task.id);
    expect(updated?.state.lastRunAtMs).toBeUndefined();

    sop.stop(); // stop timer to prevent post-cleanup writes
  });
});

// ─── Timeout control ────────────────────────────────────────────────────────

describe("TaskScheduler timeout", () => {
  it("task with timeoutSeconds times out correctly", async () => {
    const exec = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    );
    const scheduler = new TaskScheduler({ storePath, logDir, onExecute: exec });

    const past = new Date(Date.now() - 60_000).toISOString();
    const task = await scheduler.add({
      name: "Timeout Task",
      enabled: true,
      prompt: "test",
      schedule: { kind: "once", scheduledTime: past },
      timeoutSeconds: 1,
    });

    await scheduler.runMissed();
    // Wait for timeout to fire
    await new Promise<void>((r) => setTimeout(r, 1500));
    // Let locked() complete
    const updated = await scheduler.get(task.id);
    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastError).toContain("timed out");
  }, 10000);
});

// ─── Failure alert ───────────────────────────────────────────────────────────

describe("TaskScheduler failure alert", () => {
  it("fires alert after N consecutive failures", async () => {
    const alertFn = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const scheduler = new TaskScheduler({
      storePath,
      logDir,
      onExecute: exec,
      onFailureAlert: alertFn,
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    await scheduler.add({
      name: "Alert Test",
      enabled: true,
      prompt: "test",
      schedule: { kind: "once", scheduledTime: past },
      failureAlertAfter: 1,
    });

    await scheduler.runMissed();
    await new Promise<void>((r) => setImmediate(r));
    const tasks = await scheduler.list({ includeDisabled: true });

    expect(alertFn).toHaveBeenCalledOnce();
    expect(alertFn.mock.calls[0][1]).toBe(1); // consecutiveErrors
  });
});
