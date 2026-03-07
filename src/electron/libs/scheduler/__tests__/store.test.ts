import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadStore, saveStore } from "../core/store.js";
import type { SchedulerStoreV2 } from "../core/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const storePath = () => path.join(tmpDir, "scheduled-tasks.json");

describe("loadStore", () => {
  it("returns empty v2 store when file does not exist", async () => {
    const store = await loadStore(storePath());
    expect(store).toEqual({ version: 2, tasks: [], sopTasks: [], hooks: [] });
  });

  it("loads a valid v2 store", async () => {
    const v2: SchedulerStoreV2 = {
      version: 2,
      tasks: [
        {
          id: "t1",
          name: "Test",
          enabled: true,
          prompt: "hello",
          schedule: { kind: "daily", dailyTime: "09:00" },
          state: {},
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      sopTasks: [],
      hooks: [],
    };
    await fs.promises.writeFile(storePath(), JSON.stringify(v2));
    const loaded = await loadStore(storePath());
    expect(loaded.version).toBe(2);
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].name).toBe("Test");
  });

  it("migrates v1 tasks to v2 format", async () => {
    const v1 = {
      tasks: [
        {
          id: "old1",
          name: "Daily task",
          enabled: true,
          prompt: "do stuff",
          scheduleType: "daily",
          dailyTime: "08:00",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "old2",
          name: "SOP task",
          enabled: true,
          prompt: "",
          scheduleType: "daily",
          dailyTime: "10:00",
          sopId: "sop123",
          hidden: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "old3",
          name: "Hook task",
          enabled: true,
          prompt: "startup hook",
          scheduleType: "hook",
          hookEvent: "startup",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "old4",
          name: "Heartbeat",
          enabled: true,
          prompt: "",
          scheduleType: "heartbeat",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.promises.writeFile(storePath(), JSON.stringify(v1));
    const store = await loadStore(storePath());

    expect(store.version).toBe(2);
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0].id).toBe("old1");
    expect(store.tasks[0].schedule).toEqual({ kind: "daily", dailyTime: "08:00" });

    expect(store.sopTasks).toHaveLength(1);
    expect(store.sopTasks[0].id).toBe("old2");
    expect(store.sopTasks[0].sopId).toBe("sop123");

    expect(store.hooks).toHaveLength(1);
    expect(store.hooks[0].id).toBe("old3");
    expect(store.hooks[0].hookEvent).toBe("startup");

    // heartbeat tasks should be dropped
  });

  it("migrates v1 interval tasks correctly", async () => {
    const v1 = {
      tasks: [
        {
          id: "interval1",
          name: "Interval",
          enabled: true,
          prompt: "check",
          scheduleType: "interval",
          intervalValue: 30,
          intervalUnit: "minutes",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.promises.writeFile(storePath(), JSON.stringify(v1));
    const store = await loadStore(storePath());
    expect(store.tasks[0].schedule).toEqual({
      kind: "interval",
      intervalValue: 30,
      intervalUnit: "minutes",
    });
  });
});

describe("saveStore", () => {
  it("writes store to file", async () => {
    const store: SchedulerStoreV2 = {
      version: 2,
      tasks: [],
      sopTasks: [],
      hooks: [],
    };
    await saveStore(storePath(), store, { skipBackup: true });
    const raw = await fs.promises.readFile(storePath(), "utf-8");
    const loaded = JSON.parse(raw) as SchedulerStoreV2;
    expect(loaded.version).toBe(2);
  });

  it("creates parent directory if needed", async () => {
    const deepPath = path.join(tmpDir, "nested", "dir", "store.json");
    await saveStore(deepPath, { version: 2, tasks: [], sopTasks: [], hooks: [] }, { skipBackup: true });
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  it("creates backup of existing file", async () => {
    const p = storePath();
    await fs.promises.writeFile(p, '{"version":2,"tasks":[],"sopTasks":[],"hooks":[]}');
    await saveStore(p, { version: 2, tasks: [], sopTasks: [], hooks: [] });
    expect(fs.existsSync(`${p}.bak`)).toBe(true);
  });
});
