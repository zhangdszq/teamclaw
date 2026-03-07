import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskScheduler } from "../modules/task-scheduler.js";
import type { TaskCreateInput } from "../core/types.js";

// Mock electron app module
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/fake-electron" },
}));

let tmpDir: string;
let storePath: string;
let logDir: string;
let time: number;

function fakeNow() { return time; }

function makeScheduler(onExecute = vi.fn().mockResolvedValue(undefined)) {
  return new TaskScheduler({
    storePath,
    logDir,
    onExecute,
    nowMs: fakeNow,
  });
}

function dailyInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    name: "Daily Task",
    enabled: true,
    prompt: "do stuff",
    schedule: { kind: "daily", dailyTime: "09:00" },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-scheduler-test-"));
  storePath = path.join(tmpDir, "tasks.json");
  logDir = path.join(tmpDir, "logs");
  // Set time to 2024-06-15 08:00:00 local
  time = new Date("2024-06-15T08:00:00").getTime();
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("TaskScheduler.add", () => {
  it("adds a task and computes nextRunAtMs", async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.add(dailyInput());
    expect(task.id).toMatch(/^task_/);
    expect(task.state.nextRunAtMs).toBeDefined();
    expect(task.state.nextRunAtMs!).toBeGreaterThan(time);
  });

  it("adds a disabled task without nextRunAtMs", async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.add(dailyInput({ enabled: false }));
    expect(task.state.nextRunAtMs).toBeUndefined();
  });

  it("persists the task to disk", async () => {
    const scheduler = makeScheduler();
    await scheduler.add(dailyInput());
    expect(fs.existsSync(storePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(raw.tasks).toHaveLength(1);
  });
});

describe("TaskScheduler.update", () => {
  it("updates task fields", async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.add(dailyInput());
    const updated = await scheduler.update(task.id, { name: "Updated" });
    expect(updated?.name).toBe("Updated");
  });

  it("returns null for non-existent id", async () => {
    const scheduler = makeScheduler();
    expect(await scheduler.update("no-such-id", { name: "x" })).toBeNull();
  });

  it("recomputes nextRunAtMs when schedule changes", async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.add(dailyInput());
    const oldNext = task.state.nextRunAtMs;
    const updated = await scheduler.update(task.id, {
      schedule: { kind: "daily", dailyTime: "20:00" },
    });
    expect(updated?.state.nextRunAtMs).not.toBe(oldNext);
  });
});

describe("TaskScheduler.delete", () => {
  it("removes the task", async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.add(dailyInput());
    const removed = await scheduler.delete(task.id);
    expect(removed).toBe(true);
    expect(await scheduler.list({ includeDisabled: true })).toHaveLength(0);
  });

  it("returns false for non-existent id", async () => {
    const scheduler = makeScheduler();
    expect(await scheduler.delete("no-such")).toBe(false);
  });
});

describe("TaskScheduler.list", () => {
  it("filters out disabled tasks by default", async () => {
    const scheduler = makeScheduler();
    await scheduler.add(dailyInput({ enabled: true }));
    await scheduler.add(dailyInput({ enabled: false }));
    expect(await scheduler.list()).toHaveLength(1);
    expect(await scheduler.list({ includeDisabled: true })).toHaveLength(2);
  });
});

describe("TaskScheduler.start — once task execution", () => {
  it("executes a once task that is due and disables it on success", async () => {
    let resolveExec!: () => void;
    const execDone = new Promise<void>((r) => { resolveExec = r; });
    const exec = vi.fn().mockImplementation(async () => { resolveExec(); });
    const scheduler = makeScheduler(exec);

    const past = new Date(time - 60_000).toISOString();
    const task = await scheduler.add({
      name: "Once",
      enabled: true,
      prompt: "run once",
      schedule: { kind: "once", scheduledTime: past },
    });

    await scheduler.runMissed();
    await execDone; // wait until execute is called
    // Allow post-execution lock to complete
    await scheduler.list({ includeDisabled: true });

    expect(exec).toHaveBeenCalled();
    const updated = await scheduler.get(task.id);
    expect(updated?.enabled).toBe(false);
  });

  it("retries a once task on transient error", async () => {
    let resolveExec!: () => void;
    const execDone = new Promise<void>((r) => { resolveExec = r; });
    const exec = vi.fn().mockImplementation(async () => {
      resolveExec();
      throw new Error("fetch failed");
    });
    const scheduler = makeScheduler(exec);

    const past = new Date(time - 60_000).toISOString();
    await scheduler.add({
      name: "Once Retry",
      enabled: true,
      prompt: "run once",
      schedule: { kind: "once", scheduledTime: past },
    });

    await scheduler.runMissed();
    await execDone;
    // Give the post-execution locked() a moment to complete
    await scheduler.list({ includeDisabled: true });

    const tasks = await scheduler.list({ includeDisabled: true });
    expect(tasks[0].enabled).toBe(true);
    expect(tasks[0].state.consecutiveErrors).toBe(1);
  });
});

describe("TaskScheduler stop", () => {
  it("calling stop does not throw", async () => {
    const scheduler = makeScheduler();
    await scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
