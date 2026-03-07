import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock electron's app module (required by transitive imports)
vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/mock-user-data",
    isPackaged: false,
  },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import {
  mapClaudeModel,
  toOpenAIToolId,
  toAnthropicToolId,
  convertAnthropicToResponsesAPI,
} from "../openai-proxy.js";

describe("mapClaudeModel", () => {
  it("maps known Claude models to OpenAI equivalents", () => {
    expect(mapClaudeModel("claude-sonnet-4-20250514")).toBe("gpt-5.2");
    expect(mapClaudeModel("claude-opus-4-5")).toBe("gpt-5.3-codex");
    expect(mapClaudeModel("claude-haiku-4-5")).toBe("gpt-5.1-codex-mini");
  });

  it("maps short aliases", () => {
    expect(mapClaudeModel("sonnet")).toBe("gpt-5.2");
    expect(mapClaudeModel("opus")).toBe("gpt-5.3-codex");
    expect(mapClaudeModel("haiku")).toBe("gpt-5.1-codex-mini");
  });

  it("infers from partial model names", () => {
    expect(mapClaudeModel("claude-sonnet-4-6-1m")).toBe("gpt-5.2");
    expect(mapClaudeModel("my-custom-opus-model")).toBe("gpt-5.3-codex");
  });

  it("falls back to gpt-5.2 for unknown models", () => {
    expect(mapClaudeModel("unknown-model-xyz")).toBe("gpt-5.2");
    expect(mapClaudeModel("")).toBe("gpt-5.2");
  });
});

describe("Tool ID conversion", () => {
  it("converts Anthropic tool IDs to OpenAI format", () => {
    expect(toOpenAIToolId("toolu_abc123")).toBe("fc_abc123");
    expect(toOpenAIToolId("call_abc123")).toBe("fc_abc123");
  });

  it("passes through already-converted IDs", () => {
    expect(toOpenAIToolId("fc_abc123")).toBe("fc_abc123");
  });

  it("converts OpenAI tool IDs back to Anthropic format", () => {
    expect(toAnthropicToolId("fc_abc123")).toBe("toolu_abc123");
  });

  it("passes through already-Anthropic IDs", () => {
    expect(toAnthropicToolId("toolu_abc123")).toBe("toolu_abc123");
  });

  it("round-trips correctly", () => {
    const original = "toolu_test12345";
    const openai = toOpenAIToolId(original);
    const restored = toAnthropicToolId(openai);
    expect(restored).toBe(original);
  });

  it("generates random IDs for empty input", () => {
    const id1 = toOpenAIToolId("");
    const id2 = toOpenAIToolId("");
    expect(id1).toMatch(/^fc_/);
    expect(id2).toMatch(/^fc_/);
    expect(id1).not.toBe(id2);
  });
});

describe("convertAnthropicToResponsesAPI", () => {
  it("converts a basic text message", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hello world" },
      ],
      stream: true,
    });

    expect(result.model).toBe("gpt-5.2");
    expect(result.stream).toBe(true);
    expect(result.store).toBe(false);
    expect(Array.isArray(result.input)).toBe(true);
    const input = result.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: "Hello world",
    });
  });

  it("converts system prompt", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      system: "You are a helpful assistant.",
      stream: true,
    });

    expect(result.instructions).toBe("You are a helpful assistant.");
  });

  it("converts array system prompt", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      system: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
      stream: true,
    });

    expect(result.instructions).toBe("Part 1\n\nPart 2");
  });

  it("converts tool definitions", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Get weather info",
          input_schema: {
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          },
        },
      ],
      stream: true,
    });

    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("get_weather");
    expect(tools[0].description).toBe("Get weather info");
  });

  it("converts tool_use blocks in assistant messages", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_abc", name: "get_weather", input: { city: "SF" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_abc", content: "72°F sunny" },
          ],
        },
      ],
      stream: true,
    });

    const input = result.input as Array<Record<string, unknown>>;
    expect(input.length).toBeGreaterThanOrEqual(3);

    const toolCall = input.find((i) => (i as any).type === "function_call") as Record<string, unknown>;
    expect(toolCall).toBeDefined();
    expect(toolCall.name).toBe("get_weather");
    expect(toolCall.call_id).toBe("fc_abc");

    const toolResult = input.find((i) => (i as any).type === "function_call_output") as Record<string, unknown>;
    expect(toolResult).toBeDefined();
    expect(toolResult.call_id).toBe("fc_abc");
    expect(toolResult.output).toBe("72°F sunny");
  });

  it("strips cache_control from messages", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      stream: true,
    });

    const input = result.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
  });

  it("sanitizes JSON schema by removing unsupported fields", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          name: "test",
          input_schema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                pattern: "^[a-z]+$",
                format: "email",
              },
            },
            additionalProperties: false,
            $schema: "http://json-schema.org/draft-07/schema#",
          },
        },
      ],
      stream: true,
    });

    const tools = result.tools as Array<Record<string, unknown>>;
    const params = tools[0].parameters as Record<string, unknown>;
    expect(params.$schema).toBeUndefined();
    expect(params.additionalProperties).toBeUndefined();
    const nameProp = (params.properties as Record<string, Record<string, unknown>>).name;
    expect(nameProp.minLength).toBeUndefined();
    expect(nameProp.maxLength).toBeUndefined();
    expect(nameProp.pattern).toBeUndefined();
    expect(nameProp.format).toBeUndefined();
    expect(nameProp.type).toBe("string");
  });

  it("handles error tool results", () => {
    const result = convertAnthropicToResponsesAPI({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_err", content: "File not found", is_error: true },
          ],
        },
      ],
      stream: true,
    });

    const input = result.input as Array<Record<string, unknown>>;
    const errorResult = input.find((i) => (i as any).type === "function_call_output") as Record<string, unknown>;
    expect(errorResult.output).toBe("Error: File not found");
  });
});
