/**
 * Direct Claude runner for fallback mode when sidecar isn't available.
 * This is used in development or when the API sidecar fails to start.
 */
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "./agent-client.js";
import type { ServerEvent } from "../types.js";
import type { Session } from "./session-store.js";
import { claudeCodeEnv } from "./claude-settings.js";
import { loadUserSettings } from "./user-settings.js";
import { loadAssistantsConfig, type AssistantConfig } from "./assistants-config.js";
import { buildSmartMemoryContext } from "./memory-store.js";
import { createSharedMcpServer } from "./shared-mcp.js";
import { loadMcporterServers } from "./mcporter-loader.js";
import { runAgent } from "./agent-client.js";
import { shouldFallbackFromContinueError } from "./session-resume.js";
import { app } from "electron";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export type RunnerOptions = {
  prompt: string;
  session: Session;
  resumeSessionId?: string;
  provider?: "claude" | "openai";
  onEvent: (event: ServerEvent) => void;
  onSessionUpdate?: (updates: Partial<Session>) => void;
  onContinueMissingConversation?: () => void | Promise<void>;
};

export type RunnerHandle = {
  abort: () => void;
};

const DEFAULT_CWD = homedir();

// Build enhanced PATH for packaged environment
// Called on every runClaude() invocation so user settings changes take effect immediately.
function buildEnhancedEnv(assistantConfig?: AssistantConfig): Record<string, string | undefined> {
  const home = homedir();
  const isWindows = process.platform === 'win32';
  const pathSeparator = isWindows ? ';' : ':';
  
  const additionalPaths = isWindows ? [
    join(home, 'AppData', 'Roaming', 'npm'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
  ] : [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${home}/.bun/bin`,
    `${home}/.nvm/versions/node/v20.0.0/bin`,
    `${home}/.nvm/versions/node/v22.0.0/bin`,
    `${home}/.nvm/versions/node/v18.0.0/bin`,
    `${home}/.volta/bin`,
    `${home}/.fnm/aliases/default/bin`,
    '/usr/bin',
    '/bin',
  ];

  // Add cli-bundle to PATH if packaged
  if (app.isPackaged) {
    const cliBundlePath = join(process.resourcesPath, 'cli-bundle');
    if (existsSync(cliBundlePath)) {
      additionalPaths.unshift(cliBundlePath);
    }
  }

  const currentPath = process.env.PATH || '';
  const newPath = [...additionalPaths, currentPath].join(pathSeparator);

  // Read user settings fresh on every call so new key/url takes effect immediately
  // and overrides whatever is in ~/.claude/settings.json
  const userSettings = loadUserSettings();

  // Per-assistant config takes priority over global user settings.
  // Each assistant's claude CLI subprocess gets its own env, so parallel assistants
  // with different keys run independently without interfering with each other.
  const authToken = assistantConfig?.apiAuthToken || userSettings.anthropicAuthToken;
  const baseUrl   = assistantConfig?.apiBaseUrl   || userSettings.anthropicBaseUrl;
  const model     = assistantConfig?.model        || userSettings.anthropicModel;

  const userOverrides: Record<string, string> = {};
  if (authToken) {
    userOverrides.ANTHROPIC_AUTH_TOKEN = authToken;
    userOverrides.ANTHROPIC_API_KEY = authToken;
  }
  if (baseUrl) {
    userOverrides.ANTHROPIC_BASE_URL = baseUrl;
  }
  if (model) {
    userOverrides.ANTHROPIC_MODEL = model;
  }

  return {
    ...process.env,
    ...claudeCodeEnv,
    ...userOverrides,  // assistant-level (or user-level) settings take highest priority
    PATH: newPath,
    NODE_COMPILE_CACHE: join(home, ".vk-cowork", ".compile-cache"),
  };
}

function buildOpenAIOverrides(
  assistantConfig?: AssistantConfig,
  sessionModel?: string,
): { apiKey?: string; baseUrl?: string; model?: string } | undefined {
  const apiKey = assistantConfig?.apiAuthToken?.trim() || undefined;
  const baseUrl = assistantConfig?.apiBaseUrl?.trim() || undefined;
  const model = (sessionModel || assistantConfig?.model || "").trim() || undefined;
  if (!apiKey && !baseUrl && !model) return undefined;
  return { apiKey, baseUrl, model };
}

export async function runClaude(options: RunnerOptions): Promise<RunnerHandle> {
  const {
    prompt,
    session,
    resumeSessionId,
    provider,
    onEvent,
    onSessionUpdate,
    onContinueMissingConversation,
  } = options;
  const abortController = new AbortController();
  const effectiveProvider = provider ?? session.provider ?? "claude";

  const assistantConfig = loadAssistantsConfig().assistants.find(a => a.id === session.assistantId);
  const enhancedEnv = buildEnhancedEnv(assistantConfig);
  const providerOverrides = buildOpenAIOverrides(assistantConfig, session.model);
  const isNonInteractiveBackgroundSession =
    session.background === true
    && (session.title?.startsWith("[心跳]") || session.title?.startsWith("[记忆压缩]"));

  const t0 = Date.now();
  let effectivePrompt = prompt;
  if (!resumeSessionId) {
    try {
      const t1 = Date.now();
      const memoryCtx = await buildSmartMemoryContext(prompt, session.assistantId, session.cwd);
      if (memoryCtx) {
        effectivePrompt = memoryCtx + "\n\n" + prompt;
        console.log(`[Runner/fallback] Memory context injected, length: ${memoryCtx.length} (+${Date.now() - t1}ms)`);
      }
    } catch (err) {
      console.warn("[Runner/fallback] Failed to load memory context:", err);
    }
  }

  const sendMessage = (message: SDKMessage) => {
    onEvent({ type: "stream.message", payload: { sessionId: session.id, message } });
  };

  const sendPermissionRequest = (toolUseId: string, toolName: string, input: unknown) => {
    onEvent({ type: "permission.request", payload: { sessionId: session.id, toolUseId, toolName, input } });
  };

  const fallbackToLocalHistory = async (source: "result" | "error") => {
    if (!onContinueMissingConversation) return false;
    const prefix = source === "result"
      ? "[Runner/fallback] Continue session missing upstream conversation, using local history"
      : "[Runner/fallback] Continue session threw missing upstream conversation, using local history";
    console.warn(prefix);
    try {
      await onContinueMissingConversation();
      return true;
    } catch (fallbackError) {
      onEvent({
        type: "session.status",
        payload: {
          sessionId: session.id,
          status: "error",
          title: session.title,
          error: String(fallbackError),
        },
      });
      return true;
    }
  };

  (async () => {
    try {
      const tAgent = Date.now();
      console.log(`[Runner/timing] pre-agent setup: ${tAgent - t0}ms`);
      const q = await runAgent(effectivePrompt, {
        cwd: session.cwd ?? DEFAULT_CWD,
        resume: resumeSessionId,
        abortController,
        ...(effectiveProvider === "claude" && { env: enhancedEnv }),
        ...(effectiveProvider === "openai" && { openaiOverrides: providerOverrides }),
        provider: effectiveProvider,
        mcpServers: { "vk-shared": createSharedMcpServer({ assistantId: session.assistantId, sessionId: session.id, sessionCwd: session.cwd, workflowSopId: session.workflowSopId, scheduledTaskId: session.scheduledTaskId }), ...loadMcporterServers() },
        canUseTool: async (toolName, input, { signal, toolUseID }) => {
          if (toolName === "AskUserQuestion") {
            if (isNonInteractiveBackgroundSession) {
              return {
                behavior: "deny",
                message: "后台心跳/记忆任务禁止向用户提问，请直接完成任务或明确失败原因。",
              };
            }
            const toolUseId = toolUseID;
            sendPermissionRequest(toolUseId, toolName, input);
            return new Promise<PermissionResult>((resolve) => {
              session.pendingPermissions.set(toolUseId, {
                toolUseId,
                toolName,
                input,
                resolve: (result) => {
                  session.pendingPermissions.delete(toolUseId);
                  resolve(result as PermissionResult);
                }
              });
              signal.addEventListener("abort", () => {
                session.pendingPermissions.delete(toolUseId);
                resolve({ behavior: "deny", message: "Session aborted" });
              });
            });
          }
          if (toolName === "Skill") {
            const pool = session.assistantDiscoverySkillNames;
            if (pool && pool.length > 0) {
              const skillInput = input as { name?: string } | undefined;
              const requestedSkill = skillInput?.name;
              if (requestedSkill && !pool.includes(requestedSkill)) {
                console.log(`[Runner] Skill tool denied: "${requestedSkill}" not in discovery pool`);
                return { behavior: "deny", message: `技能 "${requestedSkill}" 未分配给当前助理，请使用已分配的技能。` };
              }
            }
          }
          return { behavior: "allow", updatedInput: input as Record<string, unknown> };
        },
      });

      let tFirstToken: number | null = null;
      let tSystemInit: number | null = null;
      for await (const message of q) {
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          tSystemInit = Date.now();
          console.log(`[Runner/timing] subprocess cold-start: ${tSystemInit - tAgent}ms`);
          const sdkSessionId = (message as any).session_id;
          if (sdkSessionId) {
            session.claudeSessionId = sdkSessionId;
            onSessionUpdate?.({ claudeSessionId: sdkSessionId });
          }
        }
        if (tFirstToken === null && message.type === "assistant") {
          tFirstToken = Date.now();
          console.log(`[Runner/timing] TTFT (system-init→first-assistant): ${tFirstToken - (tSystemInit ?? tAgent)}ms | total-from-start: ${tFirstToken - t0}ms`);
        }

        if (
          resumeSessionId &&
          onContinueMissingConversation &&
          message.type === "result" &&
          shouldFallbackFromContinueError(message)
        ) {
          if (await fallbackToLocalHistory("result")) return;
        }

        sendMessage(message);

        if (message.type === "result") {
          const resultMessage = message as unknown as { subtype?: string; result?: unknown };
          const status = resultMessage.subtype === "success" ? "completed" : "error";
          console.log(`[Runner/timing] total e2e: ${Date.now() - t0}ms (status=${status})`);
          onEvent({ type: "session.status", payload: { sessionId: session.id, status, title: session.title } });
        }
      }

      if (session.status === "running") {
        onEvent({ type: "session.status", payload: { sessionId: session.id, status: "completed", title: session.title } });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      if (resumeSessionId && onContinueMissingConversation && shouldFallbackFromContinueError(error)) {
        if (await fallbackToLocalHistory("error")) return;
      }
      onEvent({ type: "session.status", payload: { sessionId: session.id, status: "error", title: session.title, error: String(error) } });
    }
  })();

  return { abort: () => abortController.abort() };
}
