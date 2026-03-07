import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendRunLog, readRunLog, pruneRunLogIfNeeded } from "../core/run-log.js";
import type { RunRecord } from "../core/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-log-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    taskId: "task1",
    taskName: "Test Task",
    taskKind: "task",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 100,
    status: "ok",
    ...overrides,
  };
}

describe("appendRunLog", () => {
  it("creates log file and appends a record", async () => {
    await appendRunLog(tmpDir, makeRecord());
    const records = await readRunLog(tmpDir, "task1");
    expect(records).toHaveLength(1);
    expect(records[0].taskId).toBe("task1");
  });

  it("appends multiple records", async () => {
    await appendRunLog(tmpDir, makeRecord({ status: "ok" }));
    await appendRunLog(tmpDir, makeRecord({ status: "error", error: "oops" }));
    const records = await readRunLog(tmpDir, "task1");
    expect(records).toHaveLength(2);
    expect(records[0].status).toBe("ok");
    expect(records[1].status).toBe("error");
    expect(records[1].error).toBe("oops");
  });

  it("creates log directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "logs");
    await appendRunLog(nestedDir, makeRecord());
    expect(fs.existsSync(nestedDir)).toBe(true);
  });
});

describe("readRunLog", () => {
  it("returns empty array when file does not exist", async () => {
    const records = await readRunLog(tmpDir, "nonexistent");
    expect(records).toEqual([]);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await appendRunLog(tmpDir, makeRecord({ taskName: `Task ${i}` }));
    }
    const records = await readRunLog(tmpDir, "task1", 5);
    expect(records).toHaveLength(5);
    expect(records[4].taskName).toBe("Task 9"); // newest last
  });
});

describe("pruneRunLogIfNeeded", () => {
  it("does not prune when file is within size limit", async () => {
    await appendRunLog(tmpDir, makeRecord());
    const logPath = path.join(tmpDir, "task1.jsonl");
    await pruneRunLogIfNeeded(logPath, { maxBytes: 1_000_000, keepLines: 100 });
    const records = await readRunLog(tmpDir, "task1");
    expect(records).toHaveLength(1);
  });

  it("prunes when file exceeds maxBytes", async () => {
    // Write 10 records, then prune to keep only 3
    for (let i = 0; i < 10; i++) {
      await appendRunLog(tmpDir, makeRecord({ taskName: `Task ${i}` }), {
        maxBytes: 1_000_000, // no prune during append
        keepLines: 1000,
      });
    }
    const logPath = path.join(tmpDir, "task1.jsonl");
    await pruneRunLogIfNeeded(logPath, { maxBytes: 0, keepLines: 3 });
    const records = await readRunLog(tmpDir, "task1");
    expect(records).toHaveLength(3);
    // Should keep the newest 3
    expect(records[2].taskName).toBe("Task 9");
  });
});
