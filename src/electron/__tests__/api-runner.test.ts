import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  runAgent: vi.fn(),
  promptOnce: vi.fn(),
  buildSmartMemoryContext: vi.fn(),
  createSharedMcpServer: vi.fn(() => ({})),
  loadMcporterServers: vi.fn(() => ({})),
  loadAssistantsConfig: vi.fn(() => ({ assistants: [] })),
  loadUserSettings: vi.fn(() => ({})),
  recordMessage: vi.fn(),
  updateSession: vi.fn(),
  addPendingPermission: vi.fn(),
}));

vi.mock("../libs/agent-client.js", () => ({
  runAgent: mockState.runAgent,
  promptOnce: mockState.promptOnce,
}));

vi.mock("../libs/shared-mcp.js", () => ({
  createSharedMcpServer: mockState.createSharedMcpServer,
}));

vi.mock("../libs/mcporter-loader.js", () => ({
  loadMcporterServers: mockState.loadMcporterServers,
}));

vi.mock("../libs/memory-store.js", () => ({
  buildSmartMemoryContext: mockState.buildSmartMemoryContext,
}));

vi.mock("../libs/assistants-config.js", () => ({
  loadAssistantsConfig: mockState.loadAssistantsConfig,
}));

vi.mock("../libs/user-settings.js", () => ({
  loadUserSettings: mockState.loadUserSettings,
}));

vi.mock("../api/services/session.js", () => ({
  recordMessage: mockState.recordMessage,
  updateSession: mockState.updateSession,
  addPendingPermission: mockState.addPendingPermission,
}));

import { runClaude } from "../api/services/runner.js";

function createSession() {
  return {
    id: "session-1",
    title: "Test Session",
    status: "running" as const,
    pendingPermissions: new Map(),
    assistantSkillNames: [],
    assistantDiscoverySkillNames: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("api runner background heartbeat permissions", () => {
  beforeEach(() => {
    mockState.runAgent.mockReset();
    mockState.promptOnce.mockReset();
    mockState.buildSmartMemoryContext.mockReset();
    mockState.createSharedMcpServer.mockReset();
    mockState.createSharedMcpServer.mockReturnValue({});
    mockState.buildSmartMemoryContext.mockResolvedValue(null);
    mockState.addPendingPermission.mockReset();
  });

  it("denies AskUserQuestion for background heartbeat sessions", async () => {
    mockState.runAgent.mockResolvedValue((async function* () {})());

    const iterator = runClaude({
      prompt: "执行心跳",
      session: {
        ...createSession(),
        title: "[心跳] 小助理",
        background: true,
      } as any,
    });
    await iterator.next();

    const opts = mockState.runAgent.mock.calls[0]?.[1];
    expect(opts).toBeTruthy();

    const result = await opts.canUseTool(
      "AskUserQuestion",
      { question: "需要用户确认吗？" },
      { signal: new AbortController().signal, toolUseID: "tool-use-1" },
    );

    expect(result).toEqual({
      behavior: "deny",
      message: "后台心跳/记忆任务禁止向用户提问，请直接完成任务或明确失败原因。",
    });
    expect(mockState.addPendingPermission).not.toHaveBeenCalled();
  });

  it("passes includeCursorDelegation through to shared MCP creation", async () => {
    mockState.runAgent.mockResolvedValue((async function* () {})());

    const iterator = runClaude({
      prompt: "执行任务",
      session: createSession() as any,
      includeCursorDelegation: false,
    });
    await iterator.next();

    expect(mockState.createSharedMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ includeCursorDelegation: false }),
    );
  });
});
