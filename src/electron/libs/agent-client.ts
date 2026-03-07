/**
 * Unified SDK call layer — wraps @anthropic-ai/claude-agent-sdk
 * with shared defaults to eliminate boilerplate across all call sites.
 *
 * Supports two providers:
 * - "claude" (default): direct Anthropic API via ANTHROPIC_API_KEY
 * - "openai": routes through local openai-proxy which translates
 *   Anthropic Messages API → OpenAI Responses API using OAuth token
 */
import { query, unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, PermissionResult, SDKResultMessage, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeCodePath, getEnhancedEnv } from "./util.js";
import { getSettingSources } from "./claude-settings.js";
import { startProxy, getProxyBaseUrl } from "./openai-proxy.js";
import { recordUsage } from "./usage-tracker.js";
import { homedir } from "os";

export type AgentProvider = "claude" | "openai";
export type { SDKMessage, PermissionResult, SDKResultMessage };

export interface PromptOnceOpts {
  model?: string;
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
  provider?: AgentProvider;
}

export interface RunAgentOpts {
  cwd?: string;
  resume?: string;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
  systemPrompt?: string;
  maxTurns?: number;
  mcpServers?: Record<string, McpServerConfig>;
  canUseTool?: (
    toolName: string,
    input: unknown,
    context: { signal: AbortSignal; toolUseID: string },
  ) => Promise<PermissionResult>;
  includePartialMessages?: boolean;
  provider?: AgentProvider;
}

async function getEnvForProvider(
  provider: AgentProvider | undefined,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  const env = { ...(baseEnv ?? getEnhancedEnv()) };
  if (provider === "openai") {
    await startProxy();
    const proxyUrl = getProxyBaseUrl();
    if (proxyUrl) {
      env.ANTHROPIC_BASE_URL = proxyUrl;
      env.ANTHROPIC_API_KEY = "openai-proxy-dummy";
    }
  }
  return env;
}

/**
 * Single-turn text generation via the Agent SDK.
 * Wraps `unstable_v2_prompt` with shared defaults.
 */
export async function promptOnce(prompt: string, opts?: PromptOnceOpts): Promise<string | null> {
  const env = await getEnvForProvider(opts?.provider, opts?.env);
  const model = opts?.model ?? (env.ANTHROPIC_MODEL as string | undefined) ?? "claude-sonnet-4-20250514";
  const result: SDKResultMessage = await unstable_v2_prompt(prompt, {
    model,
    env,
    pathToClaudeCodeExecutable: opts?.pathToClaudeCodeExecutable ?? getClaudeCodePath(),
  });
  if (result.subtype === "success") return result.result;
  console.warn("[agent-client] promptOnce returned non-success:", result.subtype);
  return null;
}

/**
 * Full Agent session via the Agent SDK.
 * Wraps `query()` with shared defaults (permissionMode, settingSources, etc.).
 * When provider is "openai", starts the local proxy and injects ANTHROPIC_BASE_URL.
 *
 * Usage is automatically tracked via usage-tracker for every session:
 * - provider "openai": skipped here (tracked in openai-proxy.ts per request)
 * - provider "claude": extracted from the result message and recorded once
 */
export async function runAgent(prompt: string, opts: RunAgentOpts = {}): Promise<AsyncIterable<SDKMessage>> {
  const env = await getEnvForProvider(opts.provider, opts.env);
  console.log("[agent-client] runAgent called, provider:", opts.provider ?? "claude", "cwd:", opts.cwd, "resume:", opts.resume ?? "none");

  const iterable = await query({
    prompt,
    options: {
      cwd: opts.cwd ?? homedir(),
      resume: opts.resume,
      abortController: opts.abortController,
      env,
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable ?? getClaudeCodePath(),
      permissionMode: "bypassPermissions",
      includePartialMessages: opts.includePartialMessages ?? true,
      allowDangerouslySkipPermissions: true,
      maxTurns: opts.maxTurns ?? 300,
      settingSources: getSettingSources(),
      mcpServers: opts.mcpServers,
      systemPrompt: opts.systemPrompt,
      canUseTool: opts.canUseTool,
    },
  });

  // Only track Anthropic direct calls; OpenAI calls are tracked per-request in openai-proxy.ts
  if (opts.provider === "openai") return iterable;

  const startedAt = Date.now();

  async function* withUsageTracking(): AsyncGenerator<SDKMessage> {
    let recorded = false;
    try {
      for await (const message of iterable) {
        yield message;
        if (message.type === "result" && !recorded) {
          recorded = true;
          const resultMsg = message as unknown as Record<string, unknown>;
          const usage = resultMsg.usage as Record<string, unknown> | undefined;
          const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
          recordUsage({
            provider: "anthropic",
            model: (env.ANTHROPIC_MODEL as string | undefined) ?? "unknown",
            inputTokens: n(usage?.input_tokens),
            outputTokens: n(usage?.output_tokens),
            cacheReadTokens: n(usage?.cache_read_input_tokens ?? usage?.cache_read_tokens),
            cacheCreationTokens: n(usage?.cache_creation_input_tokens ?? usage?.cache_creation_tokens),
            latencyMs: Date.now() - startedAt,
            status: (resultMsg.subtype === "success") ? "ok" : "error",
            error: (resultMsg.subtype !== "success") ? String(resultMsg.result ?? "non-success result") : undefined,
          });
        }
      }
    } catch (err) {
      if (!recorded) {
        recorded = true;
        recordUsage({
          provider: "anthropic",
          model: (env.ANTHROPIC_MODEL as string | undefined) ?? "unknown",
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          latencyMs: Date.now() - startedAt,
          status: "error",
          error: String(err),
        });
      }
      throw err;
    }
  }

  return withUsageTracking();
}
