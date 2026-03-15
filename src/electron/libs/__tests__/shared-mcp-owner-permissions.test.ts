import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const tempHome = vi.hoisted(
  () => `/tmp/vk-cowork-shared-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const mockState = vi.hoisted(() => ({
  delegateToCursor: vi.fn(async (task: string, cwd: string) => `delegated:${task}:${cwd}`),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/mock/user-data",
  },
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  const mocked = {
    ...actual,
    homedir: () => tempHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock("../scheduler/index.js", () => ({
  addScheduledTask: vi.fn(async () => ({ id: "task-1" })),
  loadScheduledTasks: vi.fn(() => []),
  deleteScheduledTask: vi.fn(() => true),
  updateScheduledTask: vi.fn(async () => ({ id: "task-1" })),
}));

vi.mock("../memory-store.js", () => ({
  writeWorkingMemory: vi.fn(),
  readWorkingMemory: vi.fn(() => ""),
  readSop: vi.fn(() => null),
  completeAssistantTask: vi.fn(() => ({ id: "task-1" })),
  listAssistantTasks: vi.fn(() => []),
  upsertAssistantTask: vi.fn(() => ({ id: "task-1" })),
  writeLongTermMemory: vi.fn(),
  readLongTermMemory: vi.fn(() => ""),
  listAssistantIds: vi.fn(() => ["assistant-1"]),
  ScopedMemory: class {
    appendLongTermMemory() {}
    writeWorkingMemory() {}
    readWorkingMemory() { return ""; }
    readLongTermMemory() { return ""; }
  },
  validateMemoryEntry: vi.fn((content: string) => ({ ok: true, normalized: content })),
}));

vi.mock("../plan-store.js", () => ({
  loadPlanItems: vi.fn(() => []),
  upsertPlanItem: vi.fn(() => ({ id: "plan-1" })),
  updatePlanItem: vi.fn(() => ({ id: "plan-1" })),
}));

vi.mock("../dingtalk-bot.js", () => ({
  sendProactiveDingtalkMessage: vi.fn(async () => ({ ok: false, error: "disabled" })),
  getDingtalkBotStatus: vi.fn(() => "disconnected"),
  getAnyConnectedDingtalkAssistantId: vi.fn(() => null),
}));

vi.mock("../telegram-bot.js", () => ({
  sendProactiveTelegramMessage: vi.fn(async () => ({ ok: false, error: "disabled" })),
  getTelegramBotStatus: vi.fn(() => "disconnected"),
  getAnyConnectedTelegramAssistantId: vi.fn(() => null),
}));

vi.mock("../feishu-bot.js", () => ({
  sendProactiveFeishuMessage: vi.fn(async () => ({ ok: false, error: "disabled" })),
  getFeishuBotStatus: vi.fn(() => "disconnected"),
  getAnyConnectedFeishuAssistantId: vi.fn(() => null),
}));

vi.mock("../qqbot-bot.js", () => ({
  sendProactiveQQMessage: vi.fn(async () => ({ ok: false, error: "disabled" })),
  getQQBotStatus: vi.fn(() => "disconnected"),
  getAnyConnectedQQBotAssistantId: vi.fn(() => null),
}));

vi.mock("../notification-log.js", () => ({
  appendNotified: vi.fn(),
}));

vi.mock("../knowledge-store.js", () => ({
  createKnowledgeCandidate: vi.fn(() => ({ id: "knowledge-1", title: "经验" })),
}));

vi.mock("../assistants-config.js", () => ({
  loadAssistantsConfig: vi.fn(() => ({
    assistants: [{ id: "assistant-1", name: "小助理" }],
  })),
  resolveAssistantReference: vi.fn((reference: string | undefined | null, config?: { assistants: Array<{ id: string; name: string }> }) => {
    const cfg = config ?? { assistants: [{ id: "assistant-1", name: "小助理" }] };
    const ref = String(reference ?? "").trim();
    if (!ref) return { matchedBy: "none" };
    const byId = cfg.assistants.find((assistant) => assistant.id === ref);
    if (byId) return { assistant: byId, matchedBy: "id" };
    const byName = cfg.assistants.filter((assistant) => assistant.name === ref);
    if (byName.length === 1) return { assistant: byName[0], matchedBy: "name" };
    if (byName.length > 1) return { matchedBy: "ambiguous-name" };
    return { matchedBy: "none" };
  }),
}));

vi.mock("../user-settings.js", () => ({
  loadUserSettings: vi.fn(() => ({ memoryIsolationV3: true })),
}));

vi.mock("../pathResolver.js", () => ({
  resolveAppAsset: vi.fn(() => join(tempHome, "non-existent-asset.json")),
}));

vi.mock("../python-env.js", () => ({
  ensurePyPackages: vi.fn(async () => true),
  ensurePythonEnv: vi.fn(async () => null),
  getManagedPythonInfo: vi.fn(() => ({ pythonPath: "" })),
  getPythonEnvDir: vi.fn(() => join(tempHome, ".python-env")),
}));

vi.mock("../acp-bridge.js", () => ({
  delegateToCursor: mockState.delegateToCursor,
}));

vi.mock("../bot-base.js", () => ({
  prepareVisibleArtifact: vi.fn((filePath: string) => ({ filePath, originalPath: filePath })),
}));

vi.mock("../heartbeat-metrics.js", () => ({
  recordHeartbeatMetric: vi.fn(),
}));

import { createSharedMcpServer, isSensitiveLocalPath, type SharedMcpSensitiveTurnState } from "../shared-mcp.js";
import { addScheduledTask } from "../scheduler/index.js";

function toolText(result: any): string {
  return result?.content?.map((item: any) => item.text).join("\n") ?? "";
}

function getTool(server: any, name: string) {
  return server.instance._registeredTools[name];
}

describe("shared MCP bot whitelist access", () => {
  beforeEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    mkdirSync(tempHome, { recursive: true });
    mockState.delegateToCursor.mockClear();
    vi.mocked(addScheduledTask).mockClear();
    vi.mocked(addScheduledTask).mockResolvedValue({
      id: "task-1",
      name: "喝水提醒",
      scheduleType: "once",
      nextRun: undefined,
    } as any);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("detects sensitive local paths", () => {
    expect(isSensitiveLocalPath("~/.vk-cowork/user-settings.json")).toBe(true);
    expect(isSensitiveLocalPath("~/.claude/settings.json")).toBe(true);
    expect(isSensitiveLocalPath(join(tempHome, "project", ".env"))).toBe(true);
    expect(isSensitiveLocalPath(join(tempHome, "project", "notes.txt"))).toBe(false);
  });

  it("denies dangerous tools for non-whitelist bot sessions", async () => {
    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: tempHome,
      isOwner: false,
    }) as any;
    const result = await getTool(server, "delegate_to_cursor").handler({ task: "实现需求" });

    expect(toolText(result)).toContain("仅允许私聊白名单用户执行");
    expect(mockState.delegateToCursor).not.toHaveBeenCalled();
  });

  it("allows desktop or heartbeat sessions when isOwner is undefined", async () => {
    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: tempHome,
    }) as any;
    const result = await getTool(server, "delegate_to_cursor").handler({ task: "实现需求" });

    expect(toolText(result)).toContain("delegated:实现需求");
    expect(mockState.delegateToCursor).toHaveBeenCalledOnce();
  });

  it("blocks sensitive path reads for non-whitelist sessions but keeps normal files readable", async () => {
    const normalDir = join(tempHome, "project");
    const sensitivePath = join(tempHome, ".vk-cowork", "user-settings.json");
    mkdirSync(normalDir, { recursive: true });
    writeFileSync(join(normalDir, "notes.txt"), "普通文件", "utf8");
    mkdirSync(join(tempHome, ".vk-cowork"), { recursive: true });
    writeFileSync(sensitivePath, "{\"token\":\"secret\"}", "utf8");

    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: normalDir,
      isOwner: false,
    }) as any;

    const normal = await getTool(server, "read_document").handler({ file_path: "./notes.txt" });
    const sensitive = await getTool(server, "read_document").handler({ file_path: sensitivePath });

    expect(toolText(normal)).toContain("普通文件");
    expect(toolText(sensitive)).toContain("无权读取敏感本地路径");
  });

  it("marks sensitive turn for whitelist private reads and blocks persistence tools afterwards", async () => {
    const sensitivePath = join(tempHome, ".vk-cowork", "user-settings.json");
    mkdirSync(join(tempHome, ".vk-cowork"), { recursive: true });
    writeFileSync(sensitivePath, "{\"token\":\"secret\"}", "utf8");

    const sensitiveTurnState: SharedMcpSensitiveTurnState = { active: false };
    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: tempHome,
      isOwner: true,
      sensitiveTurnState,
    }) as any;

    const readResult = await getTool(server, "read_document").handler({ file_path: sensitivePath });
    const saveMemoryResult = await getTool(server, "save_memory").handler({ content: "- [P0] 记住这个密钥", scope: "private" });

    expect(toolText(readResult)).toContain("\"token\":\"secret\"");
    expect(sensitiveTurnState.active).toBe(true);
    expect(sensitiveTurnState.matchedPath).toBe(sensitivePath);
    expect(toolText(saveMemoryResult)).toContain("已禁用 save_memory");
  });

  it("defaults scheduled tasks to the current assistant in bot sessions", async () => {
    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: tempHome,
    }) as any;

    const result = await getTool(server, "create_scheduled_task").handler({
      name: "喝水提醒",
      notifyText: "该喝水啦",
      scheduleType: "once",
      delay_minutes: 5,
    });

    expect(vi.mocked(addScheduledTask)).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: "assistant-1",
    }));
    expect(toolText(result)).toContain("执行助理：小助理（assistant-1）");
  });

  it("normalizes assistant display names to assistant ids for scheduled tasks", async () => {
    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: tempHome,
    }) as any;

    const result = await getTool(server, "create_scheduled_task").handler({
      name: "喝水提醒",
      notifyText: "该喝水啦",
      scheduleType: "once",
      delay_minutes: 5,
      assistantId: "小助理",
    });

    expect(vi.mocked(addScheduledTask)).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: "assistant-1",
    }));
    expect(toolText(result)).toContain("执行助理：小助理（assistant-1）");
  });

  it("rejects unknown assistant references for scheduled tasks", async () => {
    const server = createSharedMcpServer({
      assistantId: "assistant-1",
      sessionCwd: tempHome,
    }) as any;

    const result = await getTool(server, "create_scheduled_task").handler({
      name: "喝水提醒",
      notifyText: "该喝水啦",
      scheduleType: "once",
      delay_minutes: 5,
      assistantId: "不存在的助理",
    });

    expect(toolText(result)).toContain("未找到助理");
    expect(vi.mocked(addScheduledTask)).not.toHaveBeenCalled();
  });
});
