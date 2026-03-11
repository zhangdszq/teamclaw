import { describe, expect, it } from "vitest";
import {
  defaultAssistantUsesProvider,
  maybeSwitchDefaultAssistantToOpenAI,
} from "../../ui/lib/openai-default-assistant.js";

function buildConfig(overrides?: Partial<AssistantsConfig>): AssistantsConfig {
  return {
    assistants: [
      {
        id: "default-assistant",
        name: "小助理",
        provider: "claude",
      },
    ],
    defaultAssistantId: "default-assistant",
    ...overrides,
  };
}

describe("openai default assistant migration", () => {
  it("switches the built-in default assistant for codex-only users", () => {
    const result = maybeSwitchDefaultAssistantToOpenAI(buildConfig(), {
      hasClaudeAuth: false,
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe("switched");
    expect(defaultAssistantUsesProvider(result.config, "openai")).toBe(true);
  });

  it("does not switch when Claude auth is already configured", () => {
    const result = maybeSwitchDefaultAssistantToOpenAI(buildConfig(), {
      hasClaudeAuth: true,
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("has-claude-auth");
    expect(defaultAssistantUsesProvider(result.config, "claude")).toBe(true);
  });

  it("does not switch when there are multiple assistants", () => {
    const result = maybeSwitchDefaultAssistantToOpenAI(
      buildConfig({
        assistants: [
          {
            id: "default-assistant",
            name: "小助理",
            provider: "claude",
          },
          {
            id: "writer",
            name: "写作助理",
            provider: "openai",
          },
        ],
      }),
      { hasClaudeAuth: false },
    );

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("multiple-assistants");
    expect(defaultAssistantUsesProvider(result.config, "claude")).toBe(true);
  });

  it("does not switch custom default assistants", () => {
    const result = maybeSwitchDefaultAssistantToOpenAI(
      buildConfig({
        assistants: [
          {
            id: "custom-assistant",
            name: "自定义助理",
            provider: "claude",
          },
        ],
        defaultAssistantId: "custom-assistant",
      }),
      { hasClaudeAuth: false },
    );

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("unsupported-default-assistant");
  });
});
