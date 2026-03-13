import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  runAgent: vi.fn(),
  buildSmartMemoryContext: vi.fn(),
  createSharedMcpServer: vi.fn(() => ({})),
  loadMcporterServers: vi.fn(() => ({})),
  loadAssistantsConfig: vi.fn(() => ({ assistants: [] })),
  loadUserSettings: vi.fn(() => ({})),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/mock/app",
    getPath: () => "/mock/user-data",
  },
}));

vi.mock("../agent-client.js", () => ({
  runAgent: mockState.runAgent,
}));

vi.mock("../memory-store.js", () => ({
  buildSmartMemoryContext: mockState.buildSmartMemoryContext,
}));

vi.mock("../shared-mcp.js", () => ({
  createSharedMcpServer: mockState.createSharedMcpServer,
}));

vi.mock("../mcporter-loader.js", () => ({
  loadMcporterServers: mockState.loadMcporterServers,
}));

vi.mock("../assistants-config.js", () => ({
  loadAssistantsConfig: mockState.loadAssistantsConfig,
}));

vi.mock("../user-settings.js", () => ({
  loadUserSettings: mockState.loadUserSettings,
}));

vi.mock("../claude-settings.js", () => ({
  claudeCodeEnv: {},
}));

import { runClaude } from "../runner.js";

function createSession() {
  return {
    id: "session-1",
    title: "Test Session",
    status: "running" as const,
    pendingPermissions: new Map(),
    assistantSkillNames: [],
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("runClaude continue fallback", () => {
  beforeEach(() => {
    mockState.runAgent.mockReset();
    mockState.buildSmartMemoryContext.mockReset();
    mockState.buildSmartMemoryContext.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses missing upstream conversation result and triggers local fallback", async () => {
    mockState.runAgent.mockResolvedValue((async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        errors: ["No conversation found with session ID: lost-remote-session"],
      };
    })());

    const onEvent = vi.fn();
    const onContinueMissingConversation = vi.fn(async () => {});

    await runClaude({
      prompt: "继续这个对话",
      session: createSession() as any,
      resumeSessionId: "remote-session-1",
      onEvent,
      onContinueMissingConversation,
    });
    await flushAsyncWork();

    expect(onContinueMissingConversation).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("keeps unrelated continue errors visible to the caller", async () => {
    mockState.runAgent.mockResolvedValue((async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        errors: ["HTTP 502 upstream failed"],
      };
    })());

    const onEvent = vi.fn();
    const onContinueMissingConversation = vi.fn(async () => {});

    await runClaude({
      prompt: "继续这个对话",
      session: createSession() as any,
      resumeSessionId: "remote-session-1",
      onEvent,
      onContinueMissingConversation,
    });
    await flushAsyncWork();

    expect(onContinueMissingConversation).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: "stream.message",
      payload: {
        sessionId: "session-1",
        message: {
          type: "result",
          subtype: "error_during_execution",
          errors: ["HTTP 502 upstream failed"],
        },
      },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "session.status",
      payload: {
        sessionId: "session-1",
        status: "error",
        title: "Test Session",
      },
    });
  });
});
