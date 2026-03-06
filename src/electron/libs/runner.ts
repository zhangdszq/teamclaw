/**
 * Direct Claude runner for fallback mode when sidecar isn't available.
 * This is used in development or when the API sidecar fails to start.
 */
import { query, type SDKMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent } from "../types.js";
import type { Session } from "./session-store.js";
import { claudeCodeEnv, getSettingSources } from "./claude-settings.js";
import { buildSmartMemoryContext } from "./memory-store.js";
import { createSharedMcpServer } from "./shared-mcp.js";
import { app } from "electron";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export type RunnerOptions = {
  prompt: string;
  session: Session;
  resumeSessionId?: string;
  onEvent: (event: ServerEvent) => void;
  onSessionUpdate?: (updates: Partial<Session>) => void;
};

export type RunnerHandle = {
  abort: () => void;
};

const DEFAULT_CWD = homedir();

// Get Claude Code CLI path for packaged app
function getClaudeCodePath(): string | undefined {
  if (app.isPackaged) {
    // Check for bundled CLI first (use .mjs for SDK compatibility)
    const bundledCliPath = join(process.resourcesPath, 'cli-bundle', 'claude.mjs');
    if (existsSync(bundledCliPath)) {
      return bundledCliPath;
    }
    // Fall back to unpacked SDK
    return join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }
  return undefined;
}

// Build enhanced PATH for packaged environment
function getEnhancedEnv(): Record<string, string | undefined> {
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

  return {
    ...process.env,
    ...claudeCodeEnv,
    PATH: newPath,
  };
}

const claudeCodePath = getClaudeCodePath();
const enhancedEnv = getEnhancedEnv();

export async function runClaude(options: RunnerOptions): Promise<RunnerHandle> {
  const { prompt, session, resumeSessionId, onEvent, onSessionUpdate } = options;
  const abortController = new AbortController();

  // Inject smart memory context for new sessions (scoped to assistant)
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
    onEvent({
      type: "stream.message",
      payload: { sessionId: session.id, message }
    });
  };

  const sendPermissionRequest = (toolUseId: string, toolName: string, input: unknown) => {
    onEvent({
      type: "permission.request",
      payload: { sessionId: session.id, toolUseId, toolName, input }
    });
  };

  // Start the query in the background
  (async () => {
    try {
      const q = query({
        prompt: effectivePrompt,
        options: {
          cwd: session.cwd ?? DEFAULT_CWD,
          resume: resumeSessionId,
          abortController,
          env: enhancedEnv,
          pathToClaudeCodeExecutable: claudeCodePath,
          permissionMode: "bypassPermissions",
          includePartialMessages: true,
          allowDangerouslySkipPermissions: true,
          maxTurns: 300,
          // Load user settings to enable skills from ~/.claude/skills/
          settingSources: getSettingSources(),
          mcpServers: { "vk-shared": createSharedMcpServer({ assistantId: session.assistantId, sessionCwd: session.cwd, workflowSopId: session.workflowSopId, scheduledTaskId: session.scheduledTaskId }) },
          canUseTool: async (toolName, input, { signal, toolUseID }) => {
            // For AskUserQuestion, we need to wait for user response
            if (toolName === "AskUserQuestion") {
              // Use the SDK's toolUseID for proper matching
              const toolUseId = toolUseID;

              // Send permission request to frontend
              sendPermissionRequest(toolUseId, toolName, input);

              // Create a promise that will be resolved when user responds
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

                // Handle abort
                signal.addEventListener("abort", () => {
                  session.pendingPermissions.delete(toolUseId);
                  resolve({ behavior: "deny", message: "Session aborted" });
                });
              });
            }

            // Auto-approve other tools
            return { behavior: "allow", updatedInput: input };
          }
        }
      });

      // Capture session_id from init message
      for await (const message of q) {
        // Extract session_id from system init message
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          const sdkSessionId = (message as any).session_id;
          if (sdkSessionId) {
            session.claudeSessionId = sdkSessionId;
            onSessionUpdate?.({ claudeSessionId: sdkSessionId });
          }
        }

        // Send message to frontend
        sendMessage(message);

        // Check for result to update session status
        if (message.type === "result") {
          const status = (message as any).subtype === "success" ? "completed" : "error";
          onEvent({
            type: "session.status",
            payload: { sessionId: session.id, status, title: session.title }
          });
        }
      }

      // Query completed normally
      if (session.status === "running") {
        onEvent({
          type: "session.status",
          payload: { sessionId: session.id, status: "completed", title: session.title }
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Session was aborted, don't treat as error
        return;
      }
      onEvent({
        type: "session.status",
        payload: { sessionId: session.id, status: "error", title: session.title, error: String(error) }
      });
    }
  })();

  return {
    abort: () => abortController.abort()
  };
}
