import { createServer } from "http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({
  settings: {} as {
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    openaiModel?: string;
  },
  oauthToken: "oauth-token",
}));

// Mock electron's app module (required by transitive imports)
vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/mock-user-data",
    isPackaged: false,
  },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../user-settings.js", () => ({
  loadUserSettings: () => mockState.settings,
}));

vi.mock("../openai-auth.js", () => ({
  getValidOpenAIToken: vi.fn(async () => mockState.oauthToken),
}));

vi.mock("../usage-tracker.js", () => ({
  recordUsage: vi.fn(),
}));

import {
  mapClaudeModel,
  toOpenAIToolId,
  toAnthropicToolId,
  convertAnthropicToResponsesAPI,
  startProxy,
  stopProxy,
  registerProxyRoute,
  unregisterProxyRoute,
  getProxyBaseUrl,
  isProxyRunning,
} from "../openai-proxy.js";

describe("mapClaudeModel", () => {
  it("maps known Claude models to OpenAI equivalents", () => {
    expect(mapClaudeModel("claude-sonnet-4-20250514")).toBe("gpt-5.4");
    expect(mapClaudeModel("claude-opus-4-5")).toBe("gpt-5.4");
    expect(mapClaudeModel("claude-haiku-4-5")).toBe("gpt-5.4");
  });

  it("maps short aliases", () => {
    expect(mapClaudeModel("sonnet")).toBe("gpt-5.4");
    expect(mapClaudeModel("opus")).toBe("gpt-5.4");
    expect(mapClaudeModel("haiku")).toBe("gpt-5.4");
  });

  it("falls back to gpt-5.4 for unknown models", () => {
    expect(mapClaudeModel("unknown-model-xyz")).toBe("gpt-5.4");
    expect(mapClaudeModel("")).toBe("gpt-5.4");
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

    expect(result.model).toBe("gpt-5.4");
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

type MockUpstreamRequest = {
  url: string;
  authorization?: string;
  body: Record<string, unknown>;
};

async function startMockUpstream() {
  const requests: MockUpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    requests.push({
      url: req.url ?? "",
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : {},
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to start mock upstream");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function postAnthropicMessages(proxyBaseUrl: string): Promise<Response> {
  return fetch(`${proxyBaseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
}

describe("openai proxy routing overrides", () => {
  beforeEach(() => {
    mockState.settings = {};
    mockState.oauthToken = "oauth-token";
  });

  afterEach(() => {
    stopProxy();
  });

  it("reports running state and base url correctly", async () => {
    expect(isProxyRunning()).toBe(false);
    expect(getProxyBaseUrl()).toBeNull();

    const port = await startProxy();
    expect(port).toBeGreaterThan(0);
    expect(isProxyRunning()).toBe(true);
    expect(getProxyBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    stopProxy();
    expect(isProxyRunning()).toBe(false);
    expect(getProxyBaseUrl()).toBeNull();
  });

  it("uses per-route assistant overrides over global settings", async () => {
    const upstreamGlobal = await startMockUpstream();
    const upstreamAssistant = await startMockUpstream();

    try {
      mockState.settings = {
        openaiApiKey: "global-key",
        openaiBaseUrl: upstreamGlobal.baseUrl,
        openaiModel: "global-model",
      };

      await startProxy();
      const routeId = registerProxyRoute({
        apiKey: "assistant-key",
        baseUrl: upstreamAssistant.baseUrl,
        model: "assistant-model",
      });
      const routeBaseUrl = getProxyBaseUrl(routeId);
      if (!routeBaseUrl) throw new Error("Proxy base url unavailable");

      const resp = await postAnthropicMessages(routeBaseUrl);
      expect(resp.status).toBe(200);
      await resp.text();

      expect(upstreamAssistant.requests).toHaveLength(1);
      expect(upstreamAssistant.requests[0].authorization).toBe("Bearer assistant-key");
      expect(upstreamAssistant.requests[0].body.model).toBe("assistant-model");
      expect(upstreamGlobal.requests).toHaveLength(0);
    } finally {
      await upstreamGlobal.close();
      await upstreamAssistant.close();
    }
  });

  it("uses global API settings on default route", async () => {
    const upstreamGlobal = await startMockUpstream();
    try {
      mockState.settings = {
        openaiApiKey: "global-key",
        openaiBaseUrl: upstreamGlobal.baseUrl,
        openaiModel: "global-model",
      };

      await startProxy();
      const base = getProxyBaseUrl();
      if (!base) throw new Error("Proxy base url unavailable");

      const resp = await postAnthropicMessages(base);
      expect(resp.status).toBe(200);
      await resp.text();

      expect(upstreamGlobal.requests).toHaveLength(1);
      expect(upstreamGlobal.requests[0].authorization).toBe("Bearer global-key");
      expect(upstreamGlobal.requests[0].body.model).toBe("global-model");
    } finally {
      await upstreamGlobal.close();
    }
  });

  it("uses oauth token when no api key, while still honoring route base/model", async () => {
    const upstreamAssistant = await startMockUpstream();
    try {
      mockState.settings = {};
      mockState.oauthToken = "oauth-xyz";

      await startProxy();
      const routeId = registerProxyRoute({
        baseUrl: upstreamAssistant.baseUrl,
        model: "assistant-model",
      });
      const routeBaseUrl = getProxyBaseUrl(routeId);
      if (!routeBaseUrl) throw new Error("Proxy base url unavailable");

      const resp = await postAnthropicMessages(routeBaseUrl);
      expect(resp.status).toBe(200);
      await resp.text();

      expect(upstreamAssistant.requests).toHaveLength(1);
      expect(upstreamAssistant.requests[0].authorization).toBe("Bearer oauth-xyz");
      expect(upstreamAssistant.requests[0].body.model).toBe("assistant-model");
    } finally {
      await upstreamAssistant.close();
    }
  });

  it("falls back to global settings after route is unregistered", async () => {
    const upstreamGlobal = await startMockUpstream();
    const upstreamAssistant = await startMockUpstream();

    try {
      mockState.settings = {
        openaiApiKey: "global-key",
        openaiBaseUrl: upstreamGlobal.baseUrl,
        openaiModel: "global-model",
      };
      await startProxy();

      const routeId = registerProxyRoute({
        apiKey: "assistant-key",
        baseUrl: upstreamAssistant.baseUrl,
        model: "assistant-model",
      });
      const routeBaseUrl = getProxyBaseUrl(routeId);
      if (!routeBaseUrl) throw new Error("Proxy base url unavailable");

      const first = await postAnthropicMessages(routeBaseUrl);
      expect(first.status).toBe(200);
      await first.text();
      expect(upstreamAssistant.requests).toHaveLength(1);
      expect(upstreamGlobal.requests).toHaveLength(0);

      unregisterProxyRoute(routeId);

      const second = await postAnthropicMessages(routeBaseUrl);
      expect(second.status).toBe(200);
      await second.text();
      expect(upstreamGlobal.requests).toHaveLength(1);
      expect(upstreamGlobal.requests[0].authorization).toBe("Bearer global-key");
      expect(upstreamGlobal.requests[0].body.model).toBe("global-model");
    } finally {
      await upstreamGlobal.close();
      await upstreamAssistant.close();
    }
  });

  it("returns 401 when neither api key nor oauth token is available", async () => {
    mockState.settings = {};
    mockState.oauthToken = "";
    await startProxy();
    const base = getProxyBaseUrl();
    if (!base) throw new Error("Proxy base url unavailable");

    const resp = await postAnthropicMessages(base);
    expect(resp.status).toBe(401);
    const body = await resp.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("authentication_error");
  });

  it("returns 400 for invalid json body", async () => {
    mockState.settings = { openaiApiKey: "global-key" };
    await startProxy();
    const base = getProxyBaseUrl();
    if (!base) throw new Error("Proxy base url unavailable");

    const resp = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    expect(resp.status).toBe(400);
  });

  it("returns 404 for unsupported path", async () => {
    await startProxy();
    const base = getProxyBaseUrl();
    if (!base) throw new Error("Proxy base url unavailable");

    const resp = await fetch(`${base}/v1/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(404);
  });

  it("returns same port for concurrent startProxy calls", async () => {
    const ports = await Promise.all(Array.from({ length: 12 }, () => startProxy()));
    const uniquePorts = Array.from(new Set(ports));
    expect(uniquePorts).toHaveLength(1);
  });
});
