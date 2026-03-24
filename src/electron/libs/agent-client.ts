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
import type { SDKMessage, PermissionResult, SDKResultMessage, McpServerConfig, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeCodePath, getEnhancedEnv } from "./util.js";
import { getSettingSources } from "./claude-settings.js";
import { startProxy, getProxyBaseUrl, registerProxyRoute, unregisterProxyRoute, type OpenAIProxyOverrides } from "./openai-proxy.js";
import { recordUsage } from "./usage-tracker.js";
import { spawnOrAcquire, schedulePreWarm } from "./subprocess-pool.js";
import { homedir } from "os";
import { join } from "path";

export type AgentProvider = "claude" | "openai";
export type { SDKMessage, PermissionResult, SDKResultMessage };

const OPENAI_PROXY_SENTINEL = "openai-proxy-dummy";
const OPENAI_PROXY_PLACEHOLDER_MODEL = "claude-sonnet-4-20250514";
const OPENAI_ENV_KEYS_TO_CLEAR = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
] as const;

export interface PromptOnceOpts {
  model?: string;
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
  provider?: AgentProvider;
  openaiOverrides?: OpenAIProxyOverrides;
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
  openaiOverrides?: OpenAIProxyOverrides;
  settingSources?: ("user" | "project" | "local")[];
  agent?: string;
  agents?: Record<string, {
    description: string;
    prompt: string;
    skills?: string[];
    tools?: string[];
    disallowedTools?: string[];
    model?: "sonnet" | "opus" | "haiku" | "inherit";
    maxTurns?: number;
  }>;
}

type ProviderEnvResult = {
  env: Record<string, string | undefined>;
  cleanup?: () => void;
};

export function buildOpenAIProviderEnv(
  baseEnv?: Record<string, string | undefined>,
  proxyUrl?: string,
): Record<string, string | undefined> {
  const env = { ...(baseEnv ?? getEnhancedEnv()) };

  // OpenAI provider must not inherit Anthropic/Minimax credentials from process.env,
  // otherwise the SDK may bypass the local proxy and talk to the wrong upstream.
  for (const key of OPENAI_ENV_KEYS_TO_CLEAR) {
    delete env[key];
  }

  env.ANTHROPIC_API_KEY = OPENAI_PROXY_SENTINEL;
  env.ANTHROPIC_AUTH_TOKEN = OPENAI_PROXY_SENTINEL;
  env.ANTHROPIC_MODEL = OPENAI_PROXY_PLACEHOLDER_MODEL;
  if (proxyUrl) {
    env.ANTHROPIC_BASE_URL = proxyUrl;
  }

  return env;
}

async function getEnvForProvider(
  provider: AgentProvider | undefined,
  baseEnv?: Record<string, string | undefined>,
  openaiOverrides?: OpenAIProxyOverrides,
): Promise<ProviderEnvResult> {
  const env = { ...(baseEnv ?? getEnhancedEnv()) };
  // V8 bytecode cache — speeds up CLI subprocess cold start by ~1-2s
  if (!env.NODE_COMPILE_CACHE) {
    env.NODE_COMPILE_CACHE = join(homedir(), ".vk-cowork", ".compile-cache");
  }
  if (provider === "openai") {
    await startProxy();
    const routeId = registerProxyRoute(openaiOverrides);
    const proxyUrl = getProxyBaseUrl(routeId);
    const openaiEnv = buildOpenAIProviderEnv(env, proxyUrl ?? undefined);
    return {
      env: openaiEnv,
      cleanup: () => { unregisterProxyRoute(routeId); },
    };
  }
  return { env };
}

/**
 * Single-turn text generation via the Agent SDK.
 * Wraps `unstable_v2_prompt` with shared defaults.
 */
export async function promptOnce(prompt: string, opts?: PromptOnceOpts): Promise<string | null> {
  const { env, cleanup } = await getEnvForProvider(opts?.provider, opts?.env, opts?.openaiOverrides);
  const model = opts?.model ?? (env.ANTHROPIC_MODEL as string | undefined) ?? "claude-sonnet-4-20250514";
  try {
    const result: SDKResultMessage = await unstable_v2_prompt(prompt, {
      model,
      env,
      pathToClaudeCodeExecutable: opts?.pathToClaudeCodeExecutable ?? getClaudeCodePath(),
    });
    if (result.subtype === "success") return result.result;
    console.warn("[agent-client] promptOnce returned non-success:", result.subtype);
    return null;
  } finally {
    cleanup?.();
  }
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
  const { env, cleanup } = await getEnvForProvider(opts.provider, opts.env, opts.openaiOverrides);
  console.log("[agent-client] runAgent called, provider:", opts.provider ?? "claude", "cwd:", opts.cwd, "resume:", opts.resume ?? "none");
  const settingSources = opts.settingSources ?? (opts.provider === "openai" ? [] : getSettingSources());

  if (opts.provider === "openai") {
    console.log(
      "[agent-client] Proxy env:",
      "provider=", opts.provider,
      "ANTHROPIC_BASE_URL=", env.ANTHROPIC_BASE_URL,
      "ANTHROPIC_AUTH_TOKEN=", env.ANTHROPIC_AUTH_TOKEN === OPENAI_PROXY_SENTINEL ? OPENAI_PROXY_SENTINEL : "unexpected",
      "ANTHROPIC_MODEL=", env.ANTHROPIC_MODEL ?? "unset",
      "HOME=", env.HOME ?? "unset",
      "settingSources=", settingSources.length > 0 ? settingSources.join(",") : "<none>",
      "routeModel=", opts.openaiOverrides?.model ?? "default",
      "routeBaseUrl=", opts.openaiOverrides?.baseUrl ?? "default",
    );
  }

  let iterable: AsyncIterable<SDKMessage>;
  let lastSpawnOpts: SpawnOptions | null = null;
  try {
    iterable = await query({
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
        settingSources,
        mcpServers: opts.mcpServers,
        systemPrompt: opts.systemPrompt,
        canUseTool: opts.canUseTool,
        agent: opts.agent,
        agents: opts.agents,
        spawnClaudeCodeProcess: (spawnOpts) => {
          lastSpawnOpts = spawnOpts;
          return spawnOrAcquire(spawnOpts);
        },
      },
    });
  } catch (err) {
    cleanup?.();
    throw err;
  }

  if (opts.provider === "openai") {
    async function* withProxyCleanup(): AsyncGenerator<SDKMessage> {
      try {
        for await (const message of iterable) {
          yield message;
        }
      } finally {
        cleanup?.();
        if (lastSpawnOpts) schedulePreWarm(lastSpawnOpts);
      }
    }
    return withProxyCleanup();
  }

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
    } finally {
      if (lastSpawnOpts) schedulePreWarm(lastSpawnOpts);
    }
  }

  return withUsageTracking();
}
