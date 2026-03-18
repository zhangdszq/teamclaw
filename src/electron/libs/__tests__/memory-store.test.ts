import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const tempHome = vi.hoisted(
  () => `/tmp/vk-cowork-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const mockState = vi.hoisted(() => ({
  userSettings: {},
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

vi.mock("../assistants-config.js", () => ({
  loadAssistantsConfig: () => ({
    assistants: [
      { id: "assistant-1", name: "小助理", provider: "claude" },
      { id: "assistant-2", name: "小欣", provider: "claude" },
    ],
  }),
}));

vi.mock("../user-settings.js", () => ({
  loadUserSettingsAsync: vi.fn(async () => mockState.userSettings),
}));

vi.mock("../knowledge-store.js", () => ({
  listKnowledgeDocs: () => [],
}));

vi.mock("child_process", () => ({
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => proc.emit("close", 1));
    return proc;
  },
}));

import {
  ScopedMemory,
  buildSmartMemoryContext,
  completeAssistantTask,
  isConfiguredAssistantId,
  listAssistantIds,
  listAssistantTasks,
  runMemoryJanitor,
  upsertAssistantTask,
} from "../memory-store.js";

describe("memory-store enhancements", () => {
  beforeEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    mkdirSync(tempHome, { recursive: true });
    mockState.userSettings = {};
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("rejects unsafe assistant IDs and filters them from listing", () => {
    const assistantsDir = join(tempHome, ".vk-cowork", "memory", "assistants");
    mkdirSync(join(assistantsDir, "assistant-1"), { recursive: true });
    mkdirSync(join(assistantsDir, ".hidden"), { recursive: true });

    expect(listAssistantIds()).toEqual(["assistant-1"]);
    expect(isConfiguredAssistantId("assistant-1")).toBe(true);
    expect(isConfiguredAssistantId("../evil")).toBe(false);
    expect(() => new ScopedMemory("../evil")).toThrow(/Invalid assistantId/);
  });

  it("keeps mixed P0 lines during janitor cleanup", () => {
    const memoryRoot = join(tempHome, ".vk-cowork", "memory");
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(
      join(memoryRoot, "MEMORY.md"),
      [
        "- [P0] 保留的重要偏好 [P1|expire:2000-01-01] 旧备注",
        "- [P1|expire:2000-01-01] 应归档的临时项",
      ].join("\n"),
      "utf8",
    );

    runMemoryJanitor();

    const remaining = readFileSync(join(memoryRoot, "MEMORY.md"), "utf8");
    const archive = readFileSync(join(memoryRoot, "archive", `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}.md`), "utf8");

    expect(remaining).toContain("保留的重要偏好");
    expect(remaining).not.toContain("应归档的临时项");
    expect(archive).toContain("应归档的临时项");
    expect(archive).not.toContain("保留的重要偏好");
  });

  it("versions working memory checkpoints", () => {
    const scoped = new ScopedMemory("assistant-1");

    scoped.writeWorkingMemory({ keyInfo: "第一版上下文", currentTask: "任务 A" });
    scoped.writeWorkingMemory({ keyInfo: "第二版上下文", currentTask: "任务 B" });

    const currentPath = join(tempHome, ".vk-cowork", "memory", "assistants", "assistant-1", "SESSION-STATE.md");
    const versionPath = join(tempHome, ".vk-cowork", "memory", "assistants", "assistant-1", "SESSION-STATE.v1.md");

    expect(readFileSync(currentPath, "utf8")).toContain("第二版上下文");
    expect(readFileSync(versionPath, "utf8")).toContain("第一版上下文");
  });

  it("stores and completes structured tasks", () => {
    const created = upsertAssistantTask("assistant-1", {
      title: "跟进回归结果",
      dueDate: "2026-03-20",
    });

    expect(listAssistantTasks("assistant-1")).toHaveLength(1);

    const completed = completeAssistantTask("assistant-1", created.id);
    expect(completed?.status).toBe("completed");
    expect(listAssistantTasks("assistant-1")).toHaveLength(0);
    expect(listAssistantTasks("assistant-1", { includeCompleted: true })[0]?.id).toBe(created.id);
  });

  it("isolates structured tasks by contact scope", () => {
    const ownerTask = upsertAssistantTask("assistant-1", {
      title: "owner 任务",
    });
    const contactTask = upsertAssistantTask("assistant-1", {
      title: "联系人任务",
    }, { contactKey: "telegram_123" });

    expect(listAssistantTasks("assistant-1")).toHaveLength(1);
    expect(listAssistantTasks("assistant-1")[0]?.id).toBe(ownerTask.id);
    expect(listAssistantTasks("assistant-1", { contactKey: "telegram_123" })).toHaveLength(1);
    expect(listAssistantTasks("assistant-1", { contactKey: "telegram_123" })[0]?.id).toBe(contactTask.id);

    const completed = completeAssistantTask("assistant-1", contactTask.id, { contactKey: "telegram_123" });
    expect(completed?.status).toBe("completed");
    expect(listAssistantTasks("assistant-1", { contactKey: "telegram_123" })).toHaveLength(0);
    expect(listAssistantTasks("assistant-1", { includeCompleted: true, contactKey: "telegram_123" })[0]?.id).toBe(contactTask.id);
  });

  it("caps oversized memory context and marks truncation", async () => {
    const memoryRoot = join(tempHome, ".vk-cowork", "memory");
    const assistantRoot = join(memoryRoot, "assistants", "assistant-1");
    mkdirSync(join(memoryRoot, "daily"), { recursive: true });
    mkdirSync(join(assistantRoot, "daily"), { recursive: true });
    writeFileSync(join(memoryRoot, ".abstract"), "索引\n".repeat(4000), "utf8");
    writeFileSync(join(memoryRoot, "MEMORY.md"), "- [P0] " + "长期记忆".repeat(7000), "utf8");
    writeFileSync(join(assistantRoot, "MEMORY.md"), "- [P0] " + "专属记忆".repeat(7000), "utf8");
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(join(memoryRoot, "daily", `${todayStr}.md`), "- " + "共享日志".repeat(9000), "utf8");
    writeFileSync(join(assistantRoot, "daily", `${todayStr}.md`), "- " + "专属日志".repeat(9000), "utf8");

    const context = await buildSmartMemoryContext("检查记忆", "assistant-1");

    expect(context.length).toBeLessThanOrEqual(80_000);
    expect(context).toContain("[...已截断]");
  });

  it("appends private daily logs without losing content shape", () => {
    const scoped = new ScopedMemory("assistant-1");
    scoped.appendDaily("## 10:00\n第一条");
    scoped.appendDaily("## 10:05\n第二条");

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const dailyPath = join(tempHome, ".vk-cowork", "memory", "assistants", "assistant-1", "daily", `${todayStr}.md`);

    expect(existsSync(dailyPath)).toBe(true);
    const content = readFileSync(dailyPath, "utf8");
    expect(content).toContain("第一条");
    expect(content).toContain("第二条");
  });
});
