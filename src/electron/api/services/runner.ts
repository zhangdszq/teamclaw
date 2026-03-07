import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { promptOnce, runAgent, type AgentProvider } from '../../libs/agent-client.js';
import { createSharedMcpServer } from '../../libs/shared-mcp.js';
import type { Session } from '../types.js';
import { recordMessage, updateSession, addPendingPermission } from './session.js';
import { buildSmartMemoryContext } from '../../libs/memory-store.js';
import { loadAssistantsConfig } from '../../libs/assistants-config.js';
import { loadUserSettings } from '../../libs/user-settings.js';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

// Server event types
export type ServerEvent =
  | { type: 'session.status'; payload: { sessionId: string; status: string; title?: string; cwd?: string; error?: string } }
  | { type: 'stream.message'; payload: { sessionId: string; message: SDKMessage } }
  | { type: 'stream.user_prompt'; payload: { sessionId: string; prompt: string } }
  | { type: 'permission.request'; payload: { sessionId: string; toolUseId: string; toolName: string; input: unknown } }
  | { type: 'runner.error'; payload: { sessionId?: string; message: string } }
  | { type: 'session.list'; payload: { sessions: unknown[] } }
  | { type: 'session.history'; payload: { sessionId: string; status: string; messages: unknown[]; pendingPermissions: unknown[] } }
  | { type: 'session.deleted'; payload: { sessionId: string } };

// Runner options
export type RunnerOptions = {
  prompt: string;
  session: Session;
  resumeSessionId?: string;
  model?: string;
  provider?: AgentProvider;
  onSessionUpdate?: (updates: Partial<Session>) => void;
};

// Track active abort controllers
const activeControllers = new Map<string, AbortController>();

// Get Claude Code CLI path
function getClaudeCodePath(): string | undefined {
  // Check for bundled CLI first
  const bundledPath = process.env.CLAUDE_CLI_PATH;
  if (bundledPath && existsSync(bundledPath)) {
    return bundledPath;
  }

  // On Windows, don't return .cmd path - let SDK handle it via PATH
  // The SDK has issues spawning .cmd files directly
  if (process.platform === 'win32') {
    // Check if claude is in PATH by looking for the actual executable
    const npmPath = join(process.env.APPDATA || '', 'npm');
    const claudeJs = join(npmPath, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(claudeJs)) {
      return claudeJs;
    }
    // Return undefined to let SDK find it via PATH
    return undefined;
  }

  // Check for system-installed Claude Code on Unix
  const systemPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    join(homedir(), '.npm-global/bin/claude'),
  ];

  for (const p of systemPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return undefined;
}

// Build enhanced environment
function getEnhancedEnv(assistantId?: string): Record<string, string | undefined> {
  const home = homedir();
  
  let additionalPaths: string[];
  if (process.platform === 'win32') {
    additionalPaths = [
      join(process.env.APPDATA || '', 'npm'),
      join(process.env.LOCALAPPDATA || '', 'npm'),
      join(home, '.bun', 'bin'),
    ];
  } else {
    additionalPaths = [
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
  }

  // Add cli-bundle directory to PATH if CLAUDE_CLI_PATH is set
  const cliPath = process.env.CLAUDE_CLI_PATH;
  if (cliPath) {
    const cliBundleDir = join(cliPath, '..');
    if (existsSync(cliBundleDir)) {
      additionalPaths.unshift(cliBundleDir);
    }
  }

  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH || '';
  const newPath = [...additionalPaths, currentPath].join(pathSeparator);

  // Load Claude-specific env vars
  const claudeEnv: Record<string, string | undefined> = {};

  // Per-assistant config takes priority over global user settings.
  // Each assistant's claude CLI subprocess gets its own env, so parallel assistants
  // with different keys run independently without interfering with each other.
  const assistantConfig = assistantId
    ? loadAssistantsConfig().assistants.find(a => a.id === assistantId)
    : undefined;
  const userSettings = loadUserSettings();

  const apiKey = assistantConfig?.apiAuthToken || userSettings.anthropicAuthToken || process.env.ANTHROPIC_API_KEY;
  const baseUrl = assistantConfig?.apiBaseUrl   || userSettings.anthropicBaseUrl  || process.env.ANTHROPIC_BASE_URL;
  const model   = assistantConfig?.model        || userSettings.anthropicModel    || process.env.ANTHROPIC_MODEL;

  if (apiKey) {
    claudeEnv.ANTHROPIC_API_KEY = apiKey;
    claudeEnv.ANTHROPIC_AUTH_TOKEN = apiKey;
  }
  if (baseUrl) {
    claudeEnv.ANTHROPIC_BASE_URL = baseUrl;
  }
  if (model) {
    claudeEnv.ANTHROPIC_MODEL = model;
  }

  // Proxy settings
  if (process.env.PROXY_URL) {
    claudeEnv.HTTP_PROXY = process.env.PROXY_URL;
    claudeEnv.HTTPS_PROXY = process.env.PROXY_URL;
    claudeEnv.ALL_PROXY = process.env.PROXY_URL;
    claudeEnv.http_proxy = process.env.PROXY_URL;
    claudeEnv.https_proxy = process.env.PROXY_URL;
    claudeEnv.all_proxy = process.env.PROXY_URL;
  }

  return {
    ...process.env,
    ...claudeEnv,
    PATH: newPath,
  };
}

// Stop a session by ID (supports both internal and external IDs)
export function stopSession(sessionId: string): boolean {
  console.log('[Runner] Stopping session:', sessionId);
  console.log('[Runner] Active controllers:', Array.from(activeControllers.keys()));

  const controller = activeControllers.get(sessionId);
  if (controller) {
    console.log('[Runner] Found controller, aborting...');
    controller.abort();
    return true;
  }

  console.log('[Runner] No controller found for:', sessionId);
  return false;
}

// Run Claude query (supports both claude and openai providers via proxy)
export async function* runClaude(options: RunnerOptions): AsyncGenerator<ServerEvent> {
  const { prompt, session, resumeSessionId, model, provider, onSessionUpdate } = options;
  const abortController = new AbortController();

  // Track this controller - use externalId if available for cross-process stop
  const trackingId = session.externalId || session.id;
  activeControllers.set(trackingId, abortController);
  console.log('[Runner] Tracking session with ID:', trackingId);

  const DEFAULT_CWD = homedir();

  // Queue for permission requests that need to be yielded
  const permissionRequestQueue: ServerEvent[] = [];

  // Get CLI path and environment dynamically (env vars are set after module load)
  const claudeCodePath = getClaudeCodePath();
  const enhancedEnv = getEnhancedEnv(session.assistantId);
  // Per-assistant model override: if the assistant has an explicit model configured,
  // use it instead of the global ANTHROPIC_MODEL environment variable.
  if (model) {
    enhancedEnv.ANTHROPIC_MODEL = model;
  }

  // Inject smart memory context into prompt (scoped to assistant)
  let effectivePrompt = prompt;
  if (!resumeSessionId) {
    try {
      const memoryCtx = await buildSmartMemoryContext(prompt, session.assistantId, session.cwd);
      if (memoryCtx) {
        effectivePrompt = memoryCtx + '\n\n' + prompt;
        console.log('[Runner] Memory context injected, length:', memoryCtx.length);
      }
    } catch (err) {
      console.warn('[Runner] Failed to load memory context:', err);
    }
  }

  console.log('[Runner] Starting Claude query:', { prompt: effectivePrompt.slice(0, 50), cwd: session.cwd ?? DEFAULT_CWD, resume: resumeSessionId });
  console.log('[Runner] Claude Code path:', claudeCodePath);

  try {
    const q = await runAgent(effectivePrompt, {
      cwd: session.cwd ?? DEFAULT_CWD,
      resume: resumeSessionId,
      abortController,
      ...((!provider || provider === 'claude') && { env: enhancedEnv }),
      pathToClaudeCodeExecutable: claudeCodePath,
      provider: provider ?? 'claude',
      mcpServers: { 'vk-shared': createSharedMcpServer({ assistantId: session.assistantId, sessionCwd: session.cwd }) },
      canUseTool: async (toolName, input, { signal, toolUseID }) => {
        if (toolName === 'AskUserQuestion') {
          const toolUseId = toolUseID;
          console.log('[Runner] AskUserQuestion requested, toolUseId:', toolUseId);
          permissionRequestQueue.push({
            type: 'permission.request',
            payload: { sessionId: session.id, toolUseId, toolName, input },
          });
          return new Promise<PermissionResult>((resolve) => {
            addPendingPermission(session.id, {
              toolUseId,
              toolName,
              input,
              resolve: (result) => {
                console.log('[Runner] Permission resolved:', toolUseId, result.behavior);
                resolve(result as PermissionResult);
              },
            });
            signal.addEventListener('abort', () => {
              resolve({ behavior: 'deny', message: 'Session aborted' });
            });
          });
        }
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
      },
    });

    console.log('[Runner] Query created, waiting for messages...');

    // Process messages
    for await (const message of q) {
      // Check if aborted before processing each message
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected, stopping message processing');
        break;
      }

      console.log('[Runner] Received message:', message.type, 'subtype' in message ? (message as any).subtype : '');

      // Yield any queued permission requests first
      while (permissionRequestQueue.length > 0) {
        const permReq = permissionRequestQueue.shift();
        if (permReq) yield permReq;
      }

      // Check abort again after yielding permission requests
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected after permission queue, stopping');
        break;
      }

      // Extract session_id from system init message
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        const sdkSessionId = (message as any).session_id;
        if (sdkSessionId) {
          session.claudeSessionId = sdkSessionId;
          onSessionUpdate?.({ claudeSessionId: sdkSessionId });
        }
      }

      // Check abort before yielding message
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected before yielding message, stopping');
        break;
      }

      // Record message
      recordMessage(session.id, message);

      // Yield message event
      yield {
        type: 'stream.message',
        payload: { sessionId: session.id, message },
      };

      // Check abort after yielding
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected after yielding message, stopping');
        break;
      }

      // Check for result to update session status
      if (message.type === 'result') {
        const status = (message as any).subtype === 'success' ? 'completed' : 'error';
        updateSession(session.id, { status });
        yield {
          type: 'session.status',
          payload: { sessionId: session.id, status, title: session.title },
        };
      }
    }

    // Check if aborted before marking as completed
    if (abortController.signal.aborted) {
      console.log('[Runner] Session aborted during processing');
      updateSession(session.id, { status: 'idle' });
      yield {
        type: 'session.status',
        payload: { sessionId: session.id, status: 'idle', title: session.title },
      };
      return;
    }

    // Query completed normally
    if (session.status === 'running') {
      updateSession(session.id, { status: 'completed' });
      yield {
        type: 'session.status',
        payload: { sessionId: session.id, status: 'completed', title: session.title },
      };
    }
  } catch (error) {
    console.error('[Runner] Error:', error);

    if ((error as Error).name === 'AbortError' || abortController.signal.aborted) {
      console.log('[Runner] Session aborted');
      updateSession(session.id, { status: 'idle' });
      yield {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: 'idle',
          title: session.title,
        },
      };
      return;
    }

    updateSession(session.id, { status: 'error' });
    yield {
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'error',
        title: session.title,
        error: String(error),
      },
    };
  } finally {
    console.log('[Runner] Finished, cleaning up:', trackingId);

    // If aborted, ensure status is set to idle
    if (abortController.signal.aborted) {
      updateSession(session.id, { status: 'idle' });
    }

    // Clean up controller
    activeControllers.delete(trackingId);
  }
}


// Generate session title using Claude
export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  if (!userIntent) return 'New Session';

  // Get CLI path and environment dynamically
  const claudeCodePath = getClaudeCodePath();
  const enhancedEnv = getEnhancedEnv();

  try {
    const title = await promptOnce(
      `please analyze the following user input to generate a short but clear title to identify this conversation theme:
      ${userIntent}
      directly output the title, do not include any other content`,
      { env: enhancedEnv, pathToClaudeCodeExecutable: claudeCodePath },
    );
    if (title) return title;
  } catch (error) {
    console.error('Failed to generate session title:', error);
  }

  return 'New Session';
}

/**
 * Generate skill tags for an assistant using the Agent SDK.
 * Tries OpenAI (via proxy) first if configured, falls back to Claude.
 */
export async function generateSkillTags(
  persona: string,
  skillNames: string[],
  assistantName: string,
): Promise<string[]> {
  const { loadUserSettings } = await import('../../libs/user-settings.js');
  const settings = loadUserSettings();

  const hasOpenAI = !!settings.openaiTokens?.accessToken;
  const hasClaude =
    !!settings.anthropicAuthToken ||
    !!process.env.ANTHROPIC_AUTH_TOKEN;

  const skillsPart = skillNames.length > 0
    ? `\n已配置的技能: ${skillNames.join(', ')}`
    : '';

  const prompt = `请根据以下AI助理的配置，提取6-8个简短的技能标签（每个2-4个字），用于展示在聊天框下方的快捷按钮。

助理名称: ${assistantName}
人格设定: ${persona || '通用助理'}${skillsPart}

要求：
1. 标签应简短精练，每个2-4个中文字
2. 标签应准确反映该助理的核心能力
3. 直接输出JSON数组格式，例如: ["写作","数据分析","代码审查","调研报告"]
4. 不要输出其他任何内容，只输出JSON数组`;

  const attempts: Array<() => Promise<string[]>> = [];
  if (hasOpenAI) attempts.push(() => generateTagsViaClaude(prompt, 'openai'));
  if (hasClaude) attempts.push(() => generateTagsViaClaude(prompt, 'claude'));

  if (attempts.length === 0) {
    console.warn('[generateSkillTags] No Agent SDK configured');
    return [];
  }

  for (const attempt of attempts) {
    try {
      const tags = await attempt();
      if (tags.length > 0) return tags;
    } catch (error) {
      console.error('[generateSkillTags] SDK attempt failed:', error);
    }
  }

  return [];
}

async function generateTagsViaClaude(prompt: string, provider: AgentProvider = 'claude'): Promise<string[]> {
  const claudeCodePath = getClaudeCodePath();
  const enhancedEnv = getEnhancedEnv();

  const result = await promptOnce(prompt, {
    ...((!provider || provider === 'claude') && { env: enhancedEnv }),
    pathToClaudeCodeExecutable: claudeCodePath,
    provider,
  });
  if (result) {
    console.log('[generateSkillTags] raw output:', result);
    return parseTagsFromText(result);
  }
  return [];
}

function parseTagsFromText(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const tags = JSON.parse(match[0]) as string[];
      return tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
    } catch { /* ignore parse error */ }
  }
  return [];
}
