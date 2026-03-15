import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const tempHome = vi.hoisted(
  () => `/tmp/vk-cowork-heartbeat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const mockState = vi.hoisted(() => ({
  assistant: {
    id: "assistant-1",
    name: "小助理",
    provider: "claude" as const,
    heartbeatRules: "检查未完成事项",
  },
  readRecentNotified: vi.fn<(...args: any[]) => any[]>(() => []),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/mock/user-data",
  },
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
    assistants: [mockState.assistant],
  }),
}));

vi.mock("../notification-log.js", () => ({
  readRecentNotified: mockState.readRecentNotified,
}));

import {
  buildHeartbeatPrompt,
  getHeartbeatSnapshots,
  onHeartbeatResult,
  parseHeartbeatResultText,
  resetHeartbeatStateForTests,
} from "../heartbeat.js";
import { upsertAssistantTask } from "../memory-store.js";

function today(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function writeMemory(shared: string, assistantDaily: string): void {
  const date = today();
  const sharedPath = join(tempHome, ".vk-cowork", "memory", "daily", `${date}.md`);
  const assistantPath = join(
    tempHome,
    ".vk-cowork",
    "memory",
    "assistants",
    mockState.assistant.id,
    "daily",
    `${date}.md`,
  );
  mkdirSync(join(tempHome, ".vk-cowork", "memory", "daily"), { recursive: true });
  mkdirSync(join(tempHome, ".vk-cowork", "memory", "assistants", mockState.assistant.id, "daily"), {
    recursive: true,
  });
  writeFileSync(sharedPath, shared, "utf8");
  writeFileSync(assistantPath, assistantDaily, "utf8");
}

describe("heartbeat helpers", () => {
  beforeEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    mkdirSync(tempHome, { recursive: true });
    resetHeartbeatStateForTests();
    mockState.readRecentNotified.mockClear();
  });

  afterEach(() => {
    resetHeartbeatStateForTests();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("parses JSON receipt lines even when extra text follows later", () => {
    const parsed = parseHeartbeatResultText([
      "本次已完成巡检",
      "HEARTBEAT_RESULT: {\"noAction\": false, \"reason\": \"发现新待办\"}",
      "补充说明：已处理完成。",
    ].join("\n"));

    expect(parsed).toEqual({
      noAction: false,
      source: "json",
      reason: "发现新待办",
    });
  });

  it("keeps uncommitted memory deltas visible after a failed heartbeat", () => {
    writeMemory(
      "shared task: 跟进发布节奏",
      "assistant note: 明天提醒用户确认回归结果",
    );

    const firstPrompt = buildHeartbeatPrompt(mockState.assistant as any);
    expect(firstPrompt).toContain("shared task: 跟进发布节奏");
    expect(firstPrompt).toContain("assistant note: 明天提醒用户确认回归结果");

    onHeartbeatResult(mockState.assistant.id, false, "error", {
      reason: "结构化回执缺失",
      source: "missing",
    });

    const retryPrompt = buildHeartbeatPrompt(mockState.assistant as any);
    expect(retryPrompt).toContain("shared task: 跟进发布节奏");
    expect(retryPrompt).toContain("assistant note: 明天提醒用户确认回归结果");

    onHeartbeatResult(mockState.assistant.id, false, "completed", {
      reason: "已提醒用户",
      source: "json",
    });

    const nextPrompt = buildHeartbeatPrompt(mockState.assistant as any);
    expect(nextPrompt).not.toContain("shared task: 跟进发布节奏");
    expect(nextPrompt).not.toContain("assistant note: 明天提醒用户确认回归结果");
  });

  it("tracks healthy and failed snapshots with streak updates", () => {
    onHeartbeatResult(mockState.assistant.id, true, "completed", {
      reason: "暂无新事项",
      source: "json",
    });

    let snapshot = getHeartbeatSnapshots().find((item) => item.assistantId === mockState.assistant.id);
    expect(snapshot).toMatchObject({
      assistantId: mockState.assistant.id,
      assistantName: "小助理",
      status: "healthy",
      noAction: true,
      noActionStreak: 1,
      errorStreak: 0,
    });

    onHeartbeatResult(mockState.assistant.id, false, "error", {
      reason: "心跳执行失败",
      source: "missing",
    });

    snapshot = getHeartbeatSnapshots().find((item) => item.assistantId === mockState.assistant.id);
    expect(snapshot).toMatchObject({
      assistantId: mockState.assistant.id,
      status: "heartbeat_failed",
      reason: "心跳执行失败",
      noAction: false,
      noActionStreak: 0,
      errorStreak: 1,
    });
  });

  it("injects structured tasks and task-based notification history", () => {
    const task = upsertAssistantTask(mockState.assistant.id, {
      title: "跟进发布回归结果",
      dueDate: "2026-03-20",
    });
    mockState.readRecentNotified.mockReturnValue([
      {
        key: "abc12345",
        summary: "已提醒用户跟进发布回归结果",
        ts: Date.now(),
        assistantId: mockState.assistant.id,
        taskId: task.id,
      },
    ]);

    const prompt = buildHeartbeatPrompt(mockState.assistant as any);

    expect(prompt).toContain("## 结构化未完成任务");
    expect(prompt).toContain(task.id);
    expect(prompt).toContain("跟进发布回归结果");
    expect(prompt).toContain(`[task:${task.id}]`);
    expect(prompt).toContain("尽量传 task_id");
  });
});
