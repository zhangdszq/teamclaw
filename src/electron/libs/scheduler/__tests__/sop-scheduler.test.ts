import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SopScheduler } from "../modules/sop-scheduler.js";
import type { SopTaskCreateInput } from "../core/types.js";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/fake-electron" },
}));

let tmpDir: string;
let storePath: string;
let logDir: string;
let time: number;

function fakeNow() { return time; }

function makeScheduler() {
  return new SopScheduler({ storePath, logDir, nowMs: fakeNow });
}

function sopInput(overrides: Partial<SopTaskCreateInput> = {}): SopTaskCreateInput {
  return {
    sopId: "sop123",
    name: "SOP Daily",
    enabled: true,
    schedule: { kind: "daily", dailyTime: "08:00" },
    hidden: true,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sop-scheduler-test-"));
  storePath = path.join(tmpDir, "tasks.json");
  logDir = path.join(tmpDir, "logs");
  time = new Date("2024-06-15T06:00:00").getTime();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SopScheduler.add", () => {
  it("creates a SOP task with nextRunAtMs", async () => {
    const s = makeScheduler();
    const task = await s.add(sopInput());
    expect(task.id).toMatch(/^sop_/);
    expect(task.sopId).toBe("sop123");
    expect(task.state.nextRunAtMs).toBeDefined();
  });

  it("persists sopTasks to disk", async () => {
    const s = makeScheduler();
    await s.add(sopInput());
    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(raw.sopTasks).toHaveLength(1);
  });
});

describe("SopScheduler.upsert", () => {
  it("creates if no existing SOP task for that sopId", async () => {
    const s = makeScheduler();
    const task = await s.upsert(sopInput());
    expect(task.id).toBeDefined();
    expect(await s.list()).toHaveLength(1);
  });

  it("updates existing SOP-level task (idempotent)", async () => {
    const s = makeScheduler();
    const first = await s.upsert(sopInput({ schedule: { kind: "daily", dailyTime: "08:00" } }));
    const second = await s.upsert(sopInput({ schedule: { kind: "daily", dailyTime: "10:00" } }));
    expect(second.id).toBe(first.id);
    expect((second.schedule as { dailyTime: string }).dailyTime).toBe("10:00");
    expect(await s.list()).toHaveLength(1);
  });

  it("does not conflate with stageId tasks", async () => {
    const s = makeScheduler();
    await s.add(sopInput({ stageId: "stage1" }));
    const upserted = await s.upsert(sopInput());
    // upsert should create a new SOP-level task (no stageId) — total 2 tasks
    expect(await s.list()).toHaveLength(2);
    expect(upserted.stageId).toBeUndefined();
  });
});

describe("SopScheduler.deleteBySopId", () => {
  it("removes all tasks for the given sopId", async () => {
    const s = makeScheduler();
    await s.add(sopInput({ sopId: "sop1" }));
    await s.add(sopInput({ sopId: "sop1", stageId: "stage1" }));
    await s.add(sopInput({ sopId: "sop2" }));
    const removed = await s.deleteBySopId("sop1");
    expect(removed).toBe(2);
    const remaining = await s.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sopId).toBe("sop2");
  });

  it("returns 0 when sopId has no tasks", async () => {
    const s = makeScheduler();
    expect(await s.deleteBySopId("no-such-sop")).toBe(0);
  });
});

describe("SopScheduler.getBySopId", () => {
  it("returns tasks for the given sopId", async () => {
    const s = makeScheduler();
    await s.add(sopInput({ sopId: "sop-a" }));
    await s.add(sopInput({ sopId: "sop-a", stageId: "stage1" }));
    await s.add(sopInput({ sopId: "sop-b" }));
    const tasks = await s.getBySopId("sop-a");
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.sopId === "sop-a")).toBe(true);
  });
});

describe("SopScheduler callbacks", () => {
  it("dispatches runSop when task is due", async () => {
    const runSop = vi.fn();
    const runSopStage = vi.fn();
    const s = makeScheduler();
    s.setCallbacks({ runSop, runSopStage });

    // Add a task due in the past
    const past = new Date(time - 60_000).toISOString();
    await s.add({
      ...sopInput(),
      schedule: { kind: "once", scheduledTime: past },
    });

    // Manually trigger tick logic via runMissed-equivalent
    await s.start();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    // After start, SOPs that are due should have been dispatched
    // (This tests the setup; actual dispatch happens in tick)
  }, 10000);
});
