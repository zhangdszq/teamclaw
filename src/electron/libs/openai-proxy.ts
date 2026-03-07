/**
 * Local HTTP proxy that translates Anthropic Messages API requests
 * into OpenAI Responses API format, using OpenAI OAuth tokens for auth.
 *
 * Architecture inspired by codex-claude-proxy.
 * Runs an in-process HTTP server on 127.0.0.1 (auto-assigned port).
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { getValidOpenAIToken } from "./openai-auth.js";
import crypto from "crypto";
import { recordUsage } from "./usage-tracker.js";

let proxyServer: Server | null = null;
let proxyPort: number | null = null;

// ─── Model Mapping ──────────────────────────────────────────

const CLAUDE_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-6-20250219": "gpt-5.3-codex",
  "claude-opus-4-6": "gpt-5.3-codex",
  "claude-sonnet-4-6-20250219": "gpt-5.2",
  "claude-sonnet-4-6": "gpt-5.2",
  "claude-opus-4-5-20250514": "gpt-5.3-codex",
  "claude-opus-4-5": "gpt-5.3-codex",
  "claude-sonnet-4-5-20250514": "gpt-5.2",
  "claude-sonnet-4-5": "gpt-5.2",
  "claude-sonnet-4-20250514": "gpt-5.2",
  "claude-haiku-4-5-20250219": "gpt-5.1-codex-mini",
  "claude-haiku-4-5": "gpt-5.1-codex-mini",
  "claude-haiku-4-20250514": "gpt-5.1-codex-mini",
  "claude-3-5-sonnet-20240620": "gpt-5.2",
  "claude-3-opus-20240229": "gpt-5.3-codex",
  sonnet: "gpt-5.2",
  opus: "gpt-5.3-codex",
  haiku: "gpt-5.1-codex-mini",
};

export function mapClaudeModel(model: string): string {
  if (!model) return "gpt-5.2";
  if (CLAUDE_MODEL_MAP[model]) return CLAUDE_MODEL_MAP[model];
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "gpt-5.3-codex";
  if (lower.includes("sonnet")) return "gpt-5.2";
  if (lower.includes("haiku")) return "gpt-5.1-codex-mini";
  return "gpt-5.2";
}

// ─── Tool ID Conversion ─────────────────────────────────────

export function toOpenAIToolId(anthropicId: string): string {
  if (!anthropicId) return `fc_${crypto.randomBytes(12).toString("hex")}`;
  if (anthropicId.startsWith("fc_")) return anthropicId;
  const baseId = anthropicId.replace(/^(call_|toolu_)/, "");
  return `fc_${baseId}`;
}

export function toAnthropicToolId(openAIId: string): string {
  if (!openAIId) return `toolu_${crypto.randomBytes(12).toString("hex")}`;
  if (openAIId.startsWith("toolu_")) return openAIId;
  const baseId = openAIId.replace(/^fc_/, "");
  return `toolu_${baseId}`;
}

// ─── Format Conversion: Anthropic → OpenAI ──────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  cache_control?: unknown;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: unknown;
  max_tokens?: number;
  stream?: boolean;
}

function cleanCacheControl(messages: AnthropicMessage[]): AnthropicMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: (msg.content as AnthropicContentBlock[]).map((block) => {
        const { cache_control: _, ...rest } = block;
        return rest;
      }),
    };
  });
}

function extractSystemPrompt(system: AnthropicRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.filter((b) => b.type === "text").map((b) => b.text).join("\n\n") || undefined;
  }
  return undefined;
}

function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return { type: "object" };

  const result: Record<string, unknown> = {};
  const skipKeys = new Set([
    "$schema", "$id", "$ref", "$defs", "$comment",
    "additionalItems", "definitions", "examples",
    "minLength", "maxLength", "pattern", "format",
    "minItems", "maxItems", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum",
    "allOf", "anyOf", "oneOf", "not",
  ]);

  for (const [key, value] of Object.entries(schema)) {
    if (key === "const") {
      result.enum = [value];
    } else if (skipKeys.has(key)) {
      continue;
    } else if (key === "additionalProperties" && typeof value === "boolean") {
      continue;
    } else if (key === "type" && Array.isArray(value)) {
      const nonNull = (value as string[]).filter((t) => t !== "null");
      result.type = nonNull.length > 0 ? nonNull[0] : "string";
    } else if (key === "properties" && value && typeof value === "object") {
      result.properties = {};
      for (const [pk, pv] of Object.entries(value as Record<string, Record<string, unknown>>)) {
        (result.properties as Record<string, unknown>)[pk] = sanitizeSchema(pv);
      }
    } else if (key === "items") {
      result.items = Array.isArray(value)
        ? (value as Record<string, unknown>[]).map(sanitizeSchema)
        : typeof value === "object"
          ? sanitizeSchema(value as Record<string, unknown>)
          : value;
    } else if (["type", "description", "title", "required", "enum"].includes(key)) {
      result[key] = value;
    }
  }

  if (!result.type) result.type = "object";
  if (result.type === "object" && !result.properties) result.properties = {};
  return result;
}

export function convertAnthropicToResponsesAPI(req: AnthropicRequest): Record<string, unknown> {
  const cleaned = cleanCacheControl(req.messages || []);
  const instructions = extractSystemPrompt(req.system);

  const input: unknown[] = [];
  for (const msg of cleaned) {
    if (msg.role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];

      if (typeof msg.content === "string") {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content as AnthropicContentBlock[]) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            const outputContent = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as AnthropicContentBlock[]).filter((c) => c.type === "text").map((c) => c.text).join("\n")
                : JSON.stringify(block.content);
            toolResults.push({
              type: "function_call_output",
              call_id: toOpenAIToolId(block.tool_use_id!),
              output: block.is_error ? `Error: ${outputContent}` : outputContent,
            });
          }
        }
      }

      if (textParts.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content: textParts.length === 1 ? textParts[0] : textParts.map((t) => ({ type: "input_text", text: t })),
        });
      }
      input.push(...toolResults);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];

      if (typeof msg.content === "string") {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content as AnthropicContentBlock[]) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              type: "function_call",
              id: toOpenAIToolId(block.id!),
              call_id: toOpenAIToolId(block.id!),
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
            });
          }
        }
      }

      if (textParts.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: textParts.length === 1 ? textParts[0] : textParts.map((t) => ({ type: "output_text", text: t })),
        });
      }
      input.push(...toolCalls);
    }
  }

  const result: Record<string, unknown> = {
    model: mapClaudeModel(req.model),
    input,
    tools: req.tools
      ? req.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description || "",
          parameters: sanitizeSchema(t.input_schema || { type: "object" }),
        }))
      : [],
    tool_choice: req.tool_choice || "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
  if (instructions) result.instructions = instructions;
  else result.instructions = "";

  return result;
}

// ─── Streaming: OpenAI SSE → Anthropic SSE ──────────────────

function generateMessageId(): string {
  return `msg_${crypto.randomBytes(16).toString("hex")}`;
}

async function* streamResponsesAPI(
  response: Response,
  model: string,
  onUsageFinal?: (usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }) => void,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const messageId = generateMessageId();
  let hasEmittedStart = false;
  let blockIndex = 0;
  let currentBlockType: string | null = null;
  let stopReason = "end_turn";
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const jsonText = line.slice(5).trim();
      if (!jsonText) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(jsonText);
      } catch {
        continue;
      }

      const eventType = event.type as string;

      if (eventType === "response.completed") {
        const resp = event.response as Record<string, unknown> | undefined;
        const usageObj = resp?.usage as Record<string, unknown> | undefined;
        const u = usageObj as Record<string, number> | undefined;
        const inputDetails = usageObj?.input_tokens_details as Record<string, number> | undefined;
        if (u) {
          usage.input_tokens = u.input_tokens || 0;
          usage.output_tokens = u.output_tokens || 0;
          usage.cache_read_tokens =
            u["cache_read_input_tokens"] ||
            u["cached_tokens"] ||
            inputDetails?.["cached_tokens"] ||
            inputDetails?.["cache_read_tokens"] ||
            0;
          usage.cache_creation_tokens =
            u["cache_creation_input_tokens"] ||
            inputDetails?.["cache_creation_tokens"] ||
            inputDetails?.["cache_creation_input_tokens"] ||
            0;
        }
      }

      if (eventType === "response.output_item.added") {
        const item = event.item as Record<string, unknown>;

        if (!hasEmittedStart) {
          hasEmittedStart = true;
          yield {
            event: "message_start",
            data: {
              type: "message_start",
              message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
            },
          };
        }

        if (currentBlockType !== null) {
          yield { event: "content_block_stop", data: { type: "content_block_stop", index: blockIndex } };
          blockIndex++;
        }

        if (item.type === "message") {
          currentBlockType = "text";
          yield { event: "content_block_start", data: { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } } };
        } else if (item.type === "function_call") {
          currentBlockType = "tool_use";
          const openAIId = (item.call_id || item.id) as string;
          stopReason = "tool_use";
          yield {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: toAnthropicToolId(openAIId), name: item.name, input: {} },
            },
          };
        } else if (item.type === "reasoning") {
          currentBlockType = "thinking";
          yield { event: "content_block_start", data: { type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } } };
        }
      }

      if (eventType === "response.output_text.delta") {
        const delta = event.delta as string;
        if (delta) {
          if (currentBlockType === "thinking") {
            yield { event: "content_block_delta", data: { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: delta } } };
          } else if (currentBlockType === "text") {
            yield { event: "content_block_delta", data: { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta } } };
          }
        }
      }

      if (eventType === "response.reasoning.delta" || eventType === "response.thinking.delta") {
        const delta = (event.delta || event.thinking) as string;
        if (delta && currentBlockType === "thinking") {
          yield { event: "content_block_delta", data: { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: delta } } };
        }
      }

      if (eventType === "response.function_call_arguments.delta") {
        const delta = event.delta as string;
        if (delta && currentBlockType === "tool_use") {
          yield { event: "content_block_delta", data: { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: delta } } };
        }
      }
    }
  }

  if (!hasEmittedStart) {
    hasEmittedStart = true;
    yield {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      },
    };
    yield { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
    yield { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } } };
    yield { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } };
  } else if (currentBlockType !== null) {
    yield { event: "content_block_stop", data: { type: "content_block_stop", index: blockIndex } };
  }

  onUsageFinal?.(usage);
  yield { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage } };
  yield { event: "message_stop", data: { type: "message_stop" } };
}

// ─── Request Handler ────────────────────────────────────────

async function handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method !== "POST" || !req.url?.includes("/v1/messages")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const token = await getValidOpenAIToken();
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "OpenAI OAuth token not available. Please login first." } }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let anthropicReq: AnthropicRequest;
  try {
    anthropicReq = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }));
    return;
  }

  const openAIPayload = convertAnthropicToResponsesAPI(anthropicReq);
  const mappedModel = openAIPayload.model as string;
  let finalUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(openAIPayload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error("[openai-proxy] Upstream error:", upstream.status, errText);
      recordUsage({
        provider: "openai",
        model: mappedModel,
        status: "error",
        latencyMs: Date.now() - startedAt,
        error: `OpenAI API error: ${upstream.status} ${errText.slice(0, 500)}`,
      });
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `OpenAI API error: ${upstream.status} ${errText.slice(0, 500)}` } }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    for await (const sseEvent of streamResponsesAPI(upstream, mappedModel, (usage) => {
      finalUsage = usage;
    })) {
      res.write(`event: ${sseEvent.event}\ndata: ${JSON.stringify(sseEvent.data)}\n\n`);
    }
    res.end();
    recordUsage({
      provider: "openai",
      model: mappedModel,
      inputTokens: finalUsage.input_tokens,
      outputTokens: finalUsage.output_tokens,
      cacheReadTokens: finalUsage.cache_read_tokens,
      cacheCreationTokens: finalUsage.cache_creation_tokens,
      latencyMs: Date.now() - startedAt,
      status: "ok",
    });
  } catch (error) {
    console.error("[openai-proxy] Request failed:", error);
    recordUsage({
      provider: "openai",
      model: mappedModel,
      status: "error",
      latencyMs: Date.now() - startedAt,
      error: `Proxy error: ${error instanceof Error ? error.message : String(error)}`,
    });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Proxy error: ${error instanceof Error ? error.message : String(error)}` } }));
  }
}

// ─── Proxy Lifecycle ────────────────────────────────────────

export function startProxy(): Promise<number> {
  if (proxyServer && proxyPort) return Promise.resolve(proxyPort);

  return new Promise((resolve, reject) => {
    const server = createServer(handleProxyRequest);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get proxy address"));
        return;
      }
      proxyPort = addr.port;
      proxyServer = server;
      console.log(`[openai-proxy] Started on 127.0.0.1:${proxyPort}`);
      resolve(proxyPort);
    });
    server.on("error", reject);
  });
}

export function stopProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    proxyPort = null;
    console.log("[openai-proxy] Stopped");
  }
}

export function getProxyBaseUrl(): string | null {
  if (!proxyPort) return null;
  return `http://127.0.0.1:${proxyPort}`;
}

export function isProxyRunning(): boolean {
  return proxyServer !== null && proxyPort !== null;
}
