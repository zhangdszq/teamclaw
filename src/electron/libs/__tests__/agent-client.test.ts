import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  query: vi.fn(),
  unstablePrompt: vi.fn(),
  realHome: `/tmp/vk-cowork-agent-client-home-${process.pid}`,
  tmpBase: `/tmp/vk-cowork-agent-client-tmp-${process.pid}`,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockState.query,
  unstable_v2_prompt: mockState.unstablePrompt,
}));

vi.mock("../util.js", () => ({
  getClaudeCodePath: vi.fn(),
  getEnhancedEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
}));

vi.mock("os", () => ({
  homedir: () => mockState.realHome,
  tmpdir: () => mockState.tmpBase,
}));

vi.mock("../openai-proxy.js", () => ({
  startProxy: vi.fn(async () => 63150),
  getProxyBaseUrl: vi.fn(() => "http://127.0.0.1:63150/session/test"),
  registerProxyRoute: vi.fn(() => "route-1"),
  unregisterProxyRoute: vi.fn(),
}));

vi.mock("../usage-tracker.js", () => ({
  recordUsage: vi.fn(),
}));

vi.mock("../claude-settings.js", () => ({
  getSettingSources: () => ["user", "project", "local"],
}));

import { buildOpenAIProviderEnv, runAgent } from "../agent-client.js";

beforeEach(() => {
  rmSync(mockState.realHome, { recursive: true, force: true });
  rmSync(mockState.tmpBase, { recursive: true, force: true });
  mkdirSync(join(mockState.realHome, ".claude", "skills", "demo-skill"), { recursive: true });
  mkdirSync(mockState.tmpBase, { recursive: true });
  writeFileSync(join(mockState.realHome, ".claude", "skills", "demo-skill", "SKILL.md"), "# Demo skill\n\nTest skill.");
  mockState.query.mockReset();
  mockState.unstablePrompt.mockReset();
});

afterEach(() => {
  rmSync(mockState.realHome, { recursive: true, force: true });
  rmSync(mockState.tmpBase, { recursive: true, force: true });
  delete process.env.ANTHROPIC_BASE_URL;
});

describe("buildOpenAIProviderEnv", () => {
  it("replaces inherited Anthropic credentials with local proxy settings", () => {
    const env = buildOpenAIProviderEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_AUTH_TOKEN: "real-minimax-token",
        ANTHROPIC_API_KEY: "real-api-key",
        ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
        ANTHROPIC_MODEL: "MiniMax-M2.5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.5",
      },
      "http://127.0.0.1:63150/session/test",
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("openai-proxy-dummy");
    expect(env.ANTHROPIC_API_KEY).toBe("openai-proxy-dummy");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:63150/session/test");
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it("keeps proxy placeholder model even without explicit proxy url", () => {
    const env = buildOpenAIProviderEnv({ PATH: "/bin", ANTHROPIC_MODEL: "MiniMax-M2.5" });

    expect(env.PATH).toBe("/bin");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("openai-proxy-dummy");
    expect(env.ANTHROPIC_API_KEY).toBe("openai-proxy-dummy");
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe("runAgent openai provider env", () => {
  it("uses proxy-only env, preserves default setting sources, and keeps process env untouched", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
    mockState.query.mockImplementation(async () => (async function* () {})());

    const iterable = await runAgent("hello", { provider: "openai" });

    expect(mockState.query).toHaveBeenCalledTimes(1);
    const [{ options }] = mockState.query.mock.calls[0] as Array<{ options: Record<string, unknown> }>;
    const env = options.env as Record<string, string>;

    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("openai-proxy-dummy");
    expect(env.ANTHROPIC_API_KEY).toBe("openai-proxy-dummy");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:63150/session/test");
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514");
    expect(env.HOME).toBeUndefined();
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");

    for await (const _ of iterable) {
      // no-op
    }
  });
});
