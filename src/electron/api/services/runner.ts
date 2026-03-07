import { query, type SDKMessage, type PermissionResult, unstable_v2_prompt, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSharedMcpServer } from '../../libs/shared-mcp.js';
import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type CodexOptions,
  type ThreadOptions,
} from '@openai/codex-sdk';
import type { Session } from '../types.js';
import { recordMessage, updateSession, addPendingPermission } from './session.js';
import { buildSmartMemoryContext } from '../../libs/memory-store.js';
import { getSettingSources } from '../../libs/claude-settings.js';
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

// Run Claude query
export async function* runClaude(options: RunnerOptions): AsyncGenerator<ServerEvent> {
  const { prompt, session, resumeSessionId, model, onSessionUpdate } = options;
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
    const q = query({
      prompt: effectivePrompt,
      options: {
        cwd: session.cwd ?? DEFAULT_CWD,
        resume: resumeSessionId,
        abortController,
        env: enhancedEnv,
        pathToClaudeCodeExecutable: claudeCodePath,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        allowDangerouslySkipPermissions: true,
        maxTurns: 300,
        settingSources: getSettingSources(),
        mcpServers: { 'vk-shared': createSharedMcpServer({ assistantId: session.assistantId, sessionCwd: session.cwd }) },
        canUseTool: async (toolName, input, { signal, toolUseID }) => {
          // For AskUserQuestion, we need to wait for user response
          if (toolName === 'AskUserQuestion') {
            const toolUseId = toolUseID;

            console.log('[Runner] AskUserQuestion requested, toolUseId:', toolUseId);

            // Queue permission request to be yielded
            permissionRequestQueue.push({
              type: 'permission.request',
              payload: { sessionId: session.id, toolUseId, toolName, input },
            });

            // Create a promise that will be resolved when user responds
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

              // Handle abort
              signal.addEventListener('abort', () => {
                resolve({ behavior: 'deny', message: 'Session aborted' });
              });
            });
          }

          // Auto-approve other tools
          return { behavior: 'allow', updatedInput: input };
        },
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

// ─── Codex SDK helpers ───────────────────────────────────────

// Get Codex binary path for packaged app
function getCodexBinaryPath(): string | undefined {
  const bundledPath = process.env.CODEX_CLI_PATH;
  if (bundledPath && existsSync(bundledPath)) {
    return bundledPath;
  }

  // Check for asar-unpacked vendor binary
  const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const candidates = [
    // When running in packaged Electron
    join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@openai', 'codex-sdk', 'vendor', `${arch}-${platform}`, 'codex', 'codex'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

// Synthetic UUID counter for Codex events
let codexCounter = 0;
function codexUuid(): string {
  return `codex-${Date.now()}-${++codexCounter}`;
}

// SDKMessage-compatible object builders for Codex events
function codexSystemInit(sessionId: string, model: string, cwd: string, threadId?: string): Record<string, unknown> {
  return { type: 'system', subtype: 'init', session_id: threadId ?? sessionId, model, cwd, permissionMode: 'dangerFullAccess', uuid: codexUuid() };
}

function codexAssistantText(text: string): Record<string, unknown> {
  return { type: 'assistant', uuid: codexUuid(), message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function codexAssistantThinking(thinking: string): Record<string, unknown> {
  return { type: 'assistant', uuid: codexUuid(), message: { role: 'assistant', content: [{ type: 'thinking', thinking }] } };
}

function codexToolUse(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: 'assistant', uuid: codexUuid(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function codexToolResult(toolUseId: string, content: string, isError = false): Record<string, unknown> {
  return { type: 'user', uuid: codexUuid(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } };
}

function codexResult(success: boolean, usage?: { input_tokens: number; output_tokens: number }): Record<string, unknown> {
  return { type: 'result', subtype: success ? 'success' : 'error', uuid: codexUuid(), duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0, usage: usage ?? { input_tokens: 0, output_tokens: 0 } };
}

function mapCodexItem(item: ThreadItem, phase: 'started' | 'updated' | 'completed'): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];

  switch (item.type) {
    case 'agent_message':
      if (item.text) msgs.push(codexAssistantText(item.text));
      break;
    case 'reasoning':
      if (item.text) msgs.push(codexAssistantThinking(item.text));
      break;
    case 'command_execution':
      if (phase === 'started') {
        msgs.push(codexToolUse(item.id, 'Bash', { command: item.command }));
      }
      if (phase === 'completed' || phase === 'updated') {
        const exitInfo = item.exit_code !== undefined ? `[exit ${item.exit_code}] ` : '';
        msgs.push(codexToolResult(item.id, `${exitInfo}${item.aggregated_output ?? ''}`, item.status === 'failed'));
      }
      break;
    case 'file_change':
      if (phase === 'started') {
        const summary = item.changes.map(c => `${c.kind}: ${c.path}`).join('\n');
        msgs.push(codexToolUse(item.id, 'Edit', { description: summary, changes: item.changes }));
      }
      if (phase === 'completed') {
        const summary = item.changes.map(c => `${c.kind}: ${c.path}`).join('\n');
        msgs.push(codexToolResult(item.id, summary, item.status === 'failed'));
      }
      break;
    case 'mcp_tool_call':
      if (phase === 'started') {
        msgs.push(codexToolUse(item.id, `MCP:${item.server}/${item.tool}`, item.arguments));
      }
      if (phase === 'completed') {
        const content = item.error ? item.error.message : JSON.stringify(item.result ?? {});
        msgs.push(codexToolResult(item.id, content, item.status === 'failed'));
      }
      break;
    case 'web_search':
      if (phase === 'started') msgs.push(codexToolUse(item.id, 'WebSearch', { query: item.query }));
      if (phase === 'completed') msgs.push(codexToolResult(item.id, `Search: ${item.query}`));
      break;
    case 'todo_list': {
      const text = item.items.map(t => `${t.completed ? '✓' : '○'} ${t.text}`).join('\n');
      msgs.push(codexAssistantText(`**Todo List**\n${text}`));
      break;
    }
    case 'error':
      msgs.push(codexAssistantText(`**Error:** ${item.message}`));
      break;
  }
  return msgs;
}

// Run Codex query — async generator matching the same pattern as runClaude
export async function* runCodex(options: RunnerOptions): AsyncGenerator<ServerEvent> {
  const { prompt, session, model, onSessionUpdate } = options;
  const abortController = new AbortController();

  const trackingId = session.externalId || session.id;
  activeControllers.set(trackingId, abortController);
  console.log('[CodexRunner] Tracking session with ID:', trackingId);

  const DEFAULT_CWD = homedir();

  // Inject smart memory context into prompt (scoped to assistant)
  let effectivePrompt = prompt;
  if (!session.claudeSessionId) {
    try {
      const memoryCtx = await buildSmartMemoryContext(prompt, session.assistantId, session.cwd);
      if (memoryCtx) {
        effectivePrompt = memoryCtx + '\n\n' + prompt;
        console.log('[CodexRunner] Memory context injected, length:', memoryCtx.length);
      }
    } catch (err) {
      console.warn('[CodexRunner] Failed to load memory context:', err);
    }
  }

  try {
    const codexPath = getCodexBinaryPath();
    const codexOpts: CodexOptions = {};
    if (codexPath) {
      codexOpts.codexPathOverride = codexPath;
    }

    const codex = new Codex(codexOpts);

    const threadOpts: ThreadOptions = {
      model: model ?? 'gpt-5.3-codex',
      workingDirectory: session.cwd ?? DEFAULT_CWD,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    };

    const thread = session.claudeSessionId
      ? codex.resumeThread(session.claudeSessionId, threadOpts)
      : codex.startThread(threadOpts);

    const { events } = await thread.runStreamed(effectivePrompt, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      if (abortController.signal.aborted) break;

      const serverEvents = handleCodexEvent(event, session, onSessionUpdate);
      for (const se of serverEvents) {
        // Record messages that are stream.message
        if (se.type === 'stream.message') {
          recordMessage(session.id, (se.payload as any).message);
        }
        yield se;
      }
    }

    // Completed normally
    if (!abortController.signal.aborted && session.status === 'running') {
      updateSession(session.id, { status: 'completed' });
      yield { type: 'session.status', payload: { sessionId: session.id, status: 'completed', title: session.title } };
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError' || abortController.signal.aborted) {
      console.log('[CodexRunner] Session aborted');
      updateSession(session.id, { status: 'idle' });
      yield { type: 'session.status', payload: { sessionId: session.id, status: 'idle', title: session.title } };
      return;
    }

    console.error('[CodexRunner] Error:', error);
    updateSession(session.id, { status: 'error' });
    yield { type: 'session.status', payload: { sessionId: session.id, status: 'error', title: session.title, error: String(error) } };
  } finally {
    if (abortController.signal.aborted) {
      updateSession(session.id, { status: 'idle' });
    }
    activeControllers.delete(trackingId);
    console.log('[CodexRunner] Finished, cleaning up:', trackingId);
  }
}

function handleCodexEvent(
  event: ThreadEvent,
  session: Session,
  onSessionUpdate?: (updates: Partial<Session>) => void
): ServerEvent[] {
  const results: ServerEvent[] = [];
  const DEFAULT_CWD = homedir();

  const pushMsg = (msg: Record<string, unknown>) => {
    results.push({ type: 'stream.message', payload: { sessionId: session.id, message: msg as any } });
  };

  switch (event.type) {
    case 'thread.started':
      session.claudeSessionId = event.thread_id;
      onSessionUpdate?.({ claudeSessionId: event.thread_id });
      pushMsg(codexSystemInit(session.id, session.model ?? 'codex', session.cwd ?? DEFAULT_CWD, event.thread_id));
      break;
    case 'turn.started':
      break;
    case 'turn.completed':
      pushMsg(codexResult(true, { input_tokens: event.usage.input_tokens, output_tokens: event.usage.output_tokens }));
      break;
    case 'turn.failed':
      pushMsg(codexAssistantText(`**Error:** ${event.error.message}`));
      pushMsg(codexResult(false));
      break;
    case 'item.started':
      mapCodexItem(event.item, 'started').forEach(pushMsg);
      break;
    case 'item.updated':
      mapCodexItem(event.item, 'updated').forEach(pushMsg);
      break;
    case 'item.completed':
      mapCodexItem(event.item, 'completed').forEach(pushMsg);
      break;
    case 'error':
      pushMsg(codexAssistantText(`**Stream Error:** ${event.message}`));
      break;
  }

  return results;
}

// Generate session title using Claude
export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  if (!userIntent) return 'New Session';

  // Get CLI path and environment dynamically
  const claudeCodePath = getClaudeCodePath();
  const enhancedEnv = getEnhancedEnv();

  try {
    const result: SDKResultMessage = await unstable_v2_prompt(
      `please analyze the following user input to generate a short but clear title to identify this conversation theme:
      ${userIntent}
      directly output the title, do not include any other content`,
      {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        env: enhancedEnv,
        pathToClaudeCodeExecutable: claudeCodePath,
      }
    );

    if (result.subtype === 'success') {
      return result.result;
    }
  } catch (error) {
    console.error('Failed to generate session title:', error);
  }

  return 'New Session';
}

/**
 * Generate skill tags for an assistant using the Agent SDK.
 * Detects which SDK is configured and uses it; if both are configured,
 * prefers Codex. The other serves as fallback.
 */
export async function generateSkillTags(
  persona: string,
  skillNames: string[],
  assistantName: string,
): Promise<string[]> {
  const { loadUserSettings } = await import('../../libs/user-settings.js');
  const settings = loadUserSettings();

  const hasCodex =
    !!settings.openaiTokens?.accessToken ||
    existsSync(join(homedir(), '.codex', 'auth.json'));
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

  // Build ordered list: configured SDKs, Codex first when both available
  const attempts: Array<() => Promise<string[]>> = [];
  if (hasCodex) attempts.push(() => generateTagsViaCodex(prompt));
  if (hasClaude) attempts.push(() => generateTagsViaClaude(prompt));

  if (attempts.length === 0) {
    console.warn('[generateSkillTags] No Agent SDK configured (neither Codex nor Claude)');
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

async function generateTagsViaCodex(prompt: string): Promise<string[]> {
  const codexPath = getCodexBinaryPath();
  const codexOpts: CodexOptions = {};
  if (codexPath) {
    codexOpts.codexPathOverride = codexPath;
  }

  const codex = new Codex(codexOpts);
  const thread = codex.startThread({
    model: 'gpt-5.3-codex',
    workingDirectory: homedir(),
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30000);

  let collectedText = '';
  try {
    const { events } = await thread.runStreamed(prompt, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      if (event.type === 'item.completed' || event.type === 'item.updated') {
        if (event.item.type === 'agent_message' && event.item.text) {
          collectedText += event.item.text;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  console.log('[generateSkillTags] Codex raw output:', collectedText);
  return parseTagsFromText(collectedText);
}

async function generateTagsViaClaude(prompt: string): Promise<string[]> {
  const claudeCodePath = getClaudeCodePath();
  const enhancedEnv = getEnhancedEnv();

  const result: SDKResultMessage = await unstable_v2_prompt(prompt, {
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    env: enhancedEnv,
    pathToClaudeCodeExecutable: claudeCodePath,
  });

  if (result.subtype === 'success') {
    console.log('[generateSkillTags] Claude raw output:', result.result);
    return parseTagsFromText(result.result);
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
