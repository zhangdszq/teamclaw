import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
  },
}));

import { resolveDefaultProviderFromSettings } from "../assistants-config.js";

describe("resolveDefaultProviderFromSettings", () => {
  it("prefers OpenAI when only API key auth is configured", () => {
    expect(
      resolveDefaultProviderFromSettings({
        openaiApiKey: "sk-test",
      }),
    ).toBe("openai");
  });

  it("prefers OpenAI when only OAuth auth is configured", () => {
    expect(
      resolveDefaultProviderFromSettings({
        openaiTokens: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
    ).toBe("openai");
  });

  it("keeps Claude as default when both providers are configured", () => {
    expect(
      resolveDefaultProviderFromSettings({
        anthropicAuthToken: "claude-token",
        openaiApiKey: "sk-test",
      }),
    ).toBe("claude");
  });

  it("ignores blank OpenAI API keys", () => {
    expect(
      resolveDefaultProviderFromSettings({
        openaiApiKey: "   ",
      }),
    ).toBe("claude");
  });
});
