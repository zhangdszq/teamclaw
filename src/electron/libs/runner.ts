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
import { runAgent } from "./agent-client.js";
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
  };
}

export async function runClaude(options: RunnerOptions): Promise<RunnerHandle> {
  const { prompt, session, resumeSessionId, provider, onEvent, onSessionUpdate } = options;
  const abortController = new AbortController();
  const effectiveProvider = provider ?? session.provider ?? "claude";

  const assistantConfig = loadAssistantsConfig().assistants.find(a => a.id === session.assistantId);
  const enhancedEnv = buildEnhancedEnv(assistantConfig);

  let effectivePrompt = prompt;
  if (!resumeSessionId) {
    try {
      const memoryCtx = await buildSmartMemoryContext(prompt, session.assistantId, session.cwd);
      if (memoryCtx) {
        effectivePrompt = memoryCtx + "\n\n" + prompt;
        console.log("[Runner/fallback] Memory context injected, length:", memoryCtx.length);
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

  (async () => {
    try {
      const q = await runAgent(effectivePrompt, {
        cwd: session.cwd ?? DEFAULT_CWD,
        resume: resumeSessionId,
        abortController,
        ...(effectiveProvider !== "openai" && { env: enhancedEnv }),
        provider: effectiveProvider,
        mcpServers: { "vk-shared": createSharedMcpServer({ assistantId: session.assistantId, sessionCwd: session.cwd, workflowSopId: session.workflowSopId, scheduledTaskId: session.scheduledTaskId }) },
        canUseTool: async (toolName, input, { signal, toolUseID }) => {
          if (toolName === "AskUserQuestion") {
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
          return { behavior: "allow", updatedInput: input as Record<string, unknown> };
        },
      });

      for await (const message of q) {
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          const sdkSessionId = (message as any).session_id;
          if (sdkSessionId) {
            session.claudeSessionId = sdkSessionId;
            onSessionUpdate?.({ claudeSessionId: sdkSessionId });
          }
        }

        sendMessage(message);

        if (message.type === "result") {
          const resultMessage = message as unknown as { subtype?: string; result?: unknown };
          const status = resultMessage.subtype === "success" ? "completed" : "error";
          onEvent({ type: "session.status", payload: { sessionId: session.id, status, title: session.title } });
        }
      }

      if (session.status === "running") {
        onEvent({ type: "session.status", payload: { sessionId: session.id, status: "completed", title: session.title } });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      onEvent({ type: "session.status", payload: { sessionId: session.id, status: "error", title: session.title, error: String(error) } });
    }
  })();

  return { abort: () => abortController.abort() };
}
