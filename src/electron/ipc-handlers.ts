/**
 * IPC handlers for communication between renderer and main process.
 * Uses API sidecar when available, falls back to direct SDK when not.
 */
import { BrowserWindow } from 'electron';
import type { ClientEvent, ServerEvent } from './types.js';
import { SessionStore, type Session } from './libs/session-store.js';
import { runClaude, type RunnerHandle } from './libs/runner.js';
import { isEmbeddedApiRunning } from './api/server.js';
import {
  startSession as apiStartSession,
  continueSession as apiContinueSession,
  stopSession as apiStopSession,
  sendPermissionResponse as apiSendPermissionResponse,
} from './libs/api-client.js';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { loadScheduledTasks, runHookTasks } from './libs/scheduler/index.js';
import { loadAssistantsConfig } from './libs/assistants-config.js';
import { onHeartbeatResult, onCompactionResult } from './libs/heartbeat.js';
import {
  createKnowledgeCandidate,
  findKnowledgeCandidateBySession,
  updateKnowledgeCandidate,
} from './libs/knowledge-store.js';
import { buildConversationDigest, extractExperienceViaAI } from './libs/experience-extractor.js';
import { appendDailyMemory, ScopedMemory } from './libs/memory-store.js';
import {
  applyAssistantContextToPrompt,
  loadSkillContent,
  normalizeSkillNames,
  resolveSkillCommand,
} from './libs/skill-context.js';
import {
  buildContinuePrompt,
  buildResumeFallbackPrompt,
  isResumeReadyMessage,
  shouldFallbackFromContinueError,
} from './libs/session-resume.js';

// Local session store for persistence (SQLite)
const DB_PATH = join(app.getPath('userData'), 'sessions.db');
const sessions = new SessionStore(DB_PATH);

function areSkillNamesEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeSkillNames(a);
  const right = normalizeSkillNames(b);
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

/**
 * Ensure AGENTS.md exists in the working directory.
 * Created once; never overwrites an existing file.
 */
function ensureAgentsMd(cwd: string | undefined): void {
  if (!cwd) return;
  const agentsPath = join(cwd, 'AGENTS.md');
  if (existsSync(agentsPath)) return;

  const home = homedir();
  const skillsDir = join(home, '.claude', 'skills');
  const memoryDir = join(home, '.vk-cowork', 'memory');

  const content = `# AGENTS.md

## 基本规则
- 始终使用中文回复
- 代码注释使用英文
- 遵循项目现有的代码风格和目录结构

## 技能目录
技能文件位于 \`${skillsDir}/\`，可在对话中通过 \`/技能名\` 调用。

## 记忆系统
持久记忆存储在 \`${memoryDir}/\`：
- \`MEMORY.md\` — 长期记忆（用户偏好、项目决策、重要事实）
- \`daily/YYYY-MM-DD.md\` — 每日记忆（临时笔记、当日上下文）

当用户提到需要记住的偏好或重要决策时，请主动写入对应的记忆文件。

## 工具使用
- 优先使用项目已有的工具和依赖
- 修改文件前先阅读相关代码
- 执行命令前确认工作目录正确
`;

  try {
    writeFileSync(agentsPath, content, 'utf8');
    console.log('[IPC] Created AGENTS.md at:', agentsPath);
  } catch (err) {
    console.warn('[IPC] Failed to create AGENTS.md:', err);
  }
}

// Track runner handles for direct mode
const runnerHandles = new Map<string, RunnerHandle>();

// Track active sessions
const activeSessions = new Set<string>();

function parseHeartbeatResult(text: string): { noAction: boolean; source: "json" | "legacy" } {
  const marker = "HEARTBEAT_RESULT:";
  const idx = text.lastIndexOf(marker);
  if (idx >= 0) {
    const jsonText = text.slice(idx + marker.length).trim();
    try {
      const parsed = JSON.parse(jsonText) as { noAction?: unknown };
      if (typeof parsed.noAction === "boolean") {
        return { noAction: parsed.noAction, source: "json" };
      }
    } catch {
      // fall through to legacy marker
    }
  }
  return { noAction: text.includes("<no-action>"), source: "legacy" };
}

function broadcast(event: ServerEvent) {
  const payload = JSON.stringify(event);
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('server-event', payload);
    }
  }
}

function emit(event: ServerEvent) {
  // Persist relevant events to local store
  if (event.type === 'session.status' && 'payload' in event) {
    const { sessionId, status } = event.payload as { sessionId: string; status: string };
    // Use type guard instead of 'as any' for type safety
    const validStatus = sessions.validateAndNormalizeStatus(status);
    if (validStatus) {
      sessions.updateSession(sessionId, { status: validStatus });
    }

    // When a session finishes, flush queued messages to DB before reading history
    if (status === 'idle' || status === 'error') {
      sessions.flushQueuedMessages();
      const session = sessions.getSession(sessionId);

      // ── Compaction completion: persist key only on success (BUG 1 fix) ──
      if (session?.title?.startsWith('[记忆压缩]')) {
        onCompactionResult(status !== 'error');
      }

      // ── Heartbeat suppression ──────────────────────────────
      // If this is a heartbeat session, check if the response was trivial
      if (session?.title?.startsWith('[心跳]') && (session as any).suppressIfShort !== false) {
        try {
          const history = sessions.getSessionHistory(sessionId);
          const assistantMessages = (history?.messages ?? []).filter(
            (m: any) => m.type === 'assistant'
          );
          const lastAssistant = assistantMessages[assistantMessages.length - 1] as any;
          const text: string = lastAssistant?.message?.content
            ?.filter((c: any) => c.type === 'text')
            ?.map((c: any) => String(c.text))
            ?.join('') ?? '';

          const parsed = parseHeartbeatResult(text);
          const isNoAction = parsed.noAction;
          // Update adaptive interval streak counter
          if (session?.assistantId) {
            onHeartbeatResult(session.assistantId, isNoAction, status === "error" ? "error" : "completed");
          }

          if (status !== "error" && isNoAction) {
            sessions.updateSession(sessionId, { hidden: true });
            // Notify frontend to remove this session from its list
            broadcast({ type: 'session.deleted', payload: { sessionId } });
            return; // Skip the normal broadcast of session.status
          }
          if (parsed.source === "legacy") {
            console.warn(`[IPC] Heartbeat result fell back to legacy <no-action> parser: ${sessionId}`);
          }
        } catch (e) {
          console.warn('[IPC] Heartbeat suppression check failed:', e);
        }
      }

      // ── session.complete hook triggers ────────────────────
      setImmediate(() => {
        try {
          runHookTasks('session.complete', {
            assistantId: session?.assistantId,
            status,
          });
        } catch (e) {
          console.warn('[IPC] session.complete hook error:', e);
        }
      });
    }

    // Auto-extract knowledge candidate from completed/idle sessions.
    if (status === 'completed' || status === 'idle') {
      const session = sessions.getSession(sessionId);
      const shouldSkip =
        !session ||
        session.background ||
        session.title?.startsWith('[心跳]') ||
        session.title?.startsWith('[经验候选]') ||
        session.title?.startsWith('[记忆压缩]');
      if (!shouldSkip) {
        setImmediate(async () => {
          try {
            if (findKnowledgeCandidateBySession(sessionId)) return;

            const history = sessions.getSessionHistory(sessionId);
            const allMessages = history?.messages ?? [];
            const assistantMessages = allMessages.filter((m: any) => m.type === 'assistant');

            if (status === 'idle' && assistantMessages.length < 2) return;

            const lastAssistant = assistantMessages[assistantMessages.length - 1] as any;
            const lastText: string = lastAssistant?.message?.content
              ?.filter((c: any) => c.type === 'text')
              ?.map((c: any) => String(c.text))
              ?.join('\n')
              ?.trim() ?? '';

            if (!lastText || lastText.length < 80) return;

            // Regex fallback: create candidate immediately with basic extraction
            const lines = lastText.split('\n').map((l) => l.trim()).filter(Boolean);
            const regexSteps = lines.filter((line) => /^(\d+[\).、]|[-*])/.test(line)).slice(0, 12).join('\n');

            const candidate = createKnowledgeCandidate({
              title: `${(session.title || '普通会话').slice(0, 100)} · 经验候选`,
              scenario: (session.title || '普通会话').slice(0, 120),
              steps: regexSteps || '（自动抽取未识别到明确步骤，建议人工补充）',
              result: lastText.slice(0, 1200),
              risk: '待人工审核',
              sourceSessionId: sessionId,
              assistantId: session.assistantId,
            });

            // AI upgrade: asynchronously generate structured summary
            try {
              const conversationText = buildConversationDigest(allMessages);
              if (conversationText.length >= 100) {
                const aiResult = await extractExperienceViaAI(conversationText, session.title || '');
                if (aiResult) {
                  updateKnowledgeCandidate(candidate.id, aiResult);
                  console.log('[IPC] Knowledge candidate upgraded via AI:', candidate.id);
                }
              }
            } catch (aiErr) {
              console.warn('[IPC] AI extraction failed, keeping regex fallback:', aiErr);
            }
          } catch (err) {
            console.warn('[IPC] Knowledge candidate extraction failed:', err);
          }
        });

        // Auto-record in-app session to daily memory (BUG 4 fix).
        // Bot sessions use recordConversation(); this covers UI/app sessions.
        setImmediate(async () => {
          try {
            const session = sessions.getSession(sessionId);
            if (!session) return;

            const history = sessions.getSessionHistory(sessionId);
            const allMessages = history?.messages ?? [];
            if (allMessages.length < 2) return;

            const digest = buildConversationDigest(allMessages);
            if (digest.length < 100) return;

            const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const assistantLabel = session.assistantId ? `app/${session.assistantId}` : 'app';
            const title = (session.title || '普通会话').slice(0, 80);

            // One-line summary → shared daily (heartbeat and compaction can see it)
            const firstLine = digest.split('\n').find((l) => l.trim()) ?? '';
            const summary = firstLine.replace(/^\[[AU]\]\s*/, '').slice(0, 100);
            appendDailyMemory(`- ${time} [${assistantLabel}] ${title} — ${summary}`);

            // Detailed digest → assistant private daily (full context for heartbeat)
            if (session.assistantId) {
              const scoped = new ScopedMemory(session.assistantId);
              const block = `## ${time}\n**会话**: ${title}\n\n${digest.slice(0, 3000)}`;
              scoped.appendDaily(block);
            }
          } catch (err) {
            console.warn('[IPC] Daily memory recording failed:', err);
          }
        });
      }
    }
  }
  // Broadcast to renderer FIRST, then persist asynchronously to avoid blocking
  broadcast(event);

  if (event.type === 'stream.message' && 'payload' in event) {
    const { sessionId, message } = event.payload as { sessionId: string; message: any };
    sessions.queueMessage(sessionId, message);
    syncResumeStateFromMessage(sessionId, message);
  }
  if (event.type === 'stream.user_prompt' && 'payload' in event) {
    const { sessionId, prompt } = event.payload as { sessionId: string; prompt: string };
    sessions.queueMessage(sessionId, {
      type: 'user_prompt',
      prompt,
    });
  }
}

// Check if we should use embedded API or direct SDK
function useEmbeddedApi(): boolean {
  return isEmbeddedApiRunning();
}

function syncResumeStateFromMessage(sessionId: string, message: unknown): void {
  const session = sessions.getSession(sessionId);
  if (!session || !message || typeof message !== 'object') return;

  const payload = message as Record<string, unknown>;
  if (payload.type === 'system' && payload.subtype === 'init' && typeof payload.session_id === 'string') {
    console.log('[IPC] Captured claudeSessionId:', payload.session_id);
    sessions.updateSession(sessionId, { claudeSessionId: payload.session_id, resumeReady: false });
    return;
  }

  if (session.claudeSessionId && !session.resumeReady && isResumeReadyMessage(message)) {
    console.log('[IPC] Session resumeReady:', sessionId);
    sessions.updateSession(sessionId, { resumeReady: true });
  }
}

function toRunnerProvider(provider?: Session['provider']): 'claude' | 'openai' {
  if (provider === 'openai') return provider;
  return 'claude';
}

async function continueWithLocalHistoryFallback(
  session: Session,
  prompt: string,
  activatedSkillContent?: string,
): Promise<void> {
  const history = sessions.getSessionHistory(session.id);
  const fallbackPrompt = buildResumeFallbackPrompt(
    history?.messages ?? [],
    prompt,
    session.assistantSkillNames,
  );
  const effectiveFallbackPrompt = applyAssistantContextToPrompt(fallbackPrompt, {
    skillNames: session.assistantSkillNames,
    assistantId: session.assistantId,
    activatedSkillContent,
  });
  const sessionProvider = session.provider ?? 'claude';

  console.log('[IPC] Falling back to local-history continue:', session.id);
  sessions.updateSession(session.id, {
    claudeSessionId: undefined,
    resumeReady: false,
    lastPrompt: prompt,
  });

  if (useEmbeddedApi()) {
    activeSessions.add(session.id);
    try {
      await apiStartSession(
        {
          cwd: session.cwd,
          title: session.title,
          allowedTools: session.allowedTools,
          prompt: effectiveFallbackPrompt,
          externalSessionId: session.id,
          provider: sessionProvider,
          model: session.model,
          assistantId: session.assistantId,
          assistantSkillNames: session.assistantSkillNames,
          assistantActivatedSkillContent: activatedSkillContent,
        },
        (apiEvent) => {
          if ('payload' in apiEvent && 'sessionId' in (apiEvent.payload as any)) {
            (apiEvent.payload as any).sessionId = session.id;
          }
          if (apiEvent.type === 'stream.user_prompt') return;
          emit(apiEvent);
        }
      );
    } catch (error) {
      sessions.updateSession(session.id, { status: 'error' });
      emit({
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: 'error',
          title: session.title,
          cwd: session.cwd,
          error: String(error),
          assistantId: session.assistantId,
        },
      });
    } finally {
      activeSessions.delete(session.id);
      const finalStatus = sessions.getSession(session.id)?.status;
      if (finalStatus === 'running') {
        sessions.updateSession(session.id, { status: 'idle' });
        emit({
          type: 'session.status',
          payload: { sessionId: session.id, status: 'idle', title: session.title, cwd: session.cwd, assistantId: session.assistantId },
        });
      }
    }
    return;
  }

  runClaude({
      prompt: effectiveFallbackPrompt,
      session,
      provider: toRunnerProvider(sessionProvider),
      onEvent: emit,
      onSessionUpdate: (updates) => {
        sessions.updateSession(session.id, updates);
      },
    })
      .then((handle) => {
        runnerHandles.set(session.id, handle);
      })
      .catch((error) => {
        sessions.updateSession(session.id, { status: 'error' });
        emit({
          type: 'session.status',
          payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
        });
      });
}

export async function handleClientEvent(event: ClientEvent) {
  if (event.type === 'session.list') {
    emit({
      type: 'session.list',
      payload: { sessions: sessions.listSessions() },
    });
    return;
  }

  if (event.type === 'session.history') {
    // Ensure newly queued messages (e.g. stream.user_prompt) are persisted
    // before reading history to avoid race-based empty history overwrite.
    sessions.flushQueuedMessages();
    const history = sessions.getSessionHistory(event.payload.sessionId);
    if (!history) {
      emit({
        type: 'runner.error',
        payload: { message: 'Unknown session' },
      });
      return;
    }

    // Get pending permissions from the session
    const session = sessions.getSession(event.payload.sessionId);
    const pendingPermissions = session ? 
      Array.from(session.pendingPermissions.values()).map(p => ({
        toolUseId: p.toolUseId,
        toolName: p.toolName,
        input: p.input
      })) : [];
    emit({
      type: 'session.history',
      payload: {
        sessionId: history.session.id,
        status: history.session.status,
        messages: history.messages,
        pendingPermissions,
      },
    });
    return;
  }

  if (event.type === 'session.start') {
    // Ensure AGENTS.md exists in working directory
    ensureAgentsMd(event.payload.cwd);

    // Always derive provider from the assistant's saved config so that
    // switching assistants in the UI can never bleed the previous assistant's
    // provider into a new session (e.g. openai → claude when switching back).
    const assistantProvider = event.payload.assistantId
      ? loadAssistantsConfig().assistants.find((a) => a.id === event.payload.assistantId)?.provider
      : undefined;
    const provider = assistantProvider ?? event.payload.provider ?? 'claude';
    if (event.payload.assistantSkillNames?.length) {
      console.log('[IPC] session.start with skills:', event.payload.assistantSkillNames);
    }
    const startSkillContext = resolveSkillCommand(event.payload.prompt, event.payload.assistantSkillNames);
    let activatedSkillContent = startSkillContext?.skillContent;
    if (!activatedSkillContent && event.payload.assistantSkillNames?.length) {
      const firstSkill = event.payload.assistantSkillNames[0];
      activatedSkillContent = loadSkillContent(firstSkill) ?? undefined;
    }
    const resolvedStartPrompt = startSkillContext?.userText ?? event.payload.prompt;
    const effectivePrompt = applyAssistantContextToPrompt(resolvedStartPrompt, {
      skillNames: event.payload.assistantSkillNames,
      persona: event.payload.assistantPersona,
      assistantId: event.payload.assistantId,
      activatedSkillContent,
    });
    const session = sessions.createSession({
      cwd: event.payload.cwd,
      title: event.payload.title,
      allowedTools: event.payload.allowedTools,
      prompt: event.payload.prompt,
      provider,
      model: event.payload.model,
      assistantId: event.payload.assistantId,
      assistantSkillNames: event.payload.assistantSkillNames,
      background: event.payload.background,
      workflowSopId: event.payload.workflowSopId,
      scheduledTaskId: event.payload.scheduledTaskId,
    });

    sessions.updateSession(session.id, {
      lastPrompt: event.payload.prompt,
    });

    emit({
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'running',
        title: session.title,
        cwd: session.cwd,
        provider,
        assistantId: session.assistantId,
        background: session.background,
      },
    });

    if (useEmbeddedApi()) {
      // Use sidecar API for both Claude and Codex — supports multi-instance
      activeSessions.add(session.id);
      try {
        await apiStartSession(
          {
            cwd: event.payload.cwd,
            title: event.payload.title,
            allowedTools: event.payload.allowedTools,
            prompt: resolvedStartPrompt,
            externalSessionId: session.id,
            provider,
            model: event.payload.model,
            assistantId: session.assistantId,
            assistantSkillNames: session.assistantSkillNames,
            assistantPersona: event.payload.assistantPersona,
            assistantActivatedSkillContent: activatedSkillContent,
          },
          (apiEvent) => {
            // Map API session ID to local session ID
            if ('payload' in apiEvent && 'sessionId' in (apiEvent.payload as any)) {
              (apiEvent.payload as any).sessionId = session.id;
            }
            emit(apiEvent);
          }
        );
      } catch (error) {
        sessions.updateSession(session.id, { status: 'error' });
        emit({
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status: 'error',
            title: session.title,
            cwd: session.cwd,
            error: String(error),
            assistantId: session.assistantId,
          },
        });
      } finally {
        activeSessions.delete(session.id);
        // Ensure session is never left stuck in "running" state if the SSE stream
        // ended without the runner emitting a terminal status event.
        const finalStatus = sessions.getSession(session.id)?.status;
        if (finalStatus === 'running') {
          sessions.updateSession(session.id, { status: 'idle' });
          emit({
            type: 'session.status',
            payload: { sessionId: session.id, status: 'idle', title: session.title, cwd: session.cwd, assistantId: session.assistantId },
          });
        }
      }
    } else {
      // Fallback: direct SDK when sidecar is unavailable
      emit({
        type: 'stream.user_prompt',
        payload: { sessionId: session.id, prompt: event.payload.prompt },
      });
      runClaude({
          prompt: effectivePrompt,
          session,
          resumeSessionId: session.claudeSessionId,
          provider: toRunnerProvider(provider),
          onEvent: emit,
          onSessionUpdate: (updates) => {
            sessions.updateSession(session.id, updates);
          },
        })
          .then((handle) => {
            runnerHandles.set(session.id, handle);
            sessions.setAbortController(session.id, undefined);
          })
          .catch((error) => {
            sessions.updateSession(session.id, { status: 'error' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
            });
          });
    }

    return;
  }

  if (event.type === 'session.continue') {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) {
      emit({
        type: 'runner.error',
        payload: { message: 'Unknown session' },
      });
      return;
    }

    const nextSkillNames = normalizeSkillNames(event.payload.assistantSkillNames);
    const shouldSwitchSkills = nextSkillNames.length > 0 && !areSkillNamesEqual(session.assistantSkillNames, nextSkillNames);
    if (shouldSwitchSkills) {
      sessions.updateSession(session.id, {
        assistantSkillNames: nextSkillNames,
        // Force local-history fallback so the refreshed skill context is injected.
        resumeReady: false,
      });
      session.assistantSkillNames = nextSkillNames;
      session.resumeReady = false;
    }

    sessions.updateSession(session.id, {
      lastPrompt: event.payload.prompt,
    });

    emit({
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'running',
        title: session.title,
        cwd: session.cwd,
        assistantId: session.assistantId,
      },
    });

    emit({
      type: 'stream.user_prompt',
      payload: { sessionId: session.id, prompt: event.payload.prompt },
    });

    const sessionProvider = session.provider ?? 'claude';
    const continueSkillContext = resolveSkillCommand(event.payload.prompt, session.assistantSkillNames);
    let continueActivatedContent = continueSkillContext?.skillContent;
    if (!continueActivatedContent && session.assistantSkillNames?.length) {
      const firstSkill = session.assistantSkillNames[0];
      continueActivatedContent = loadSkillContent(firstSkill) ?? undefined;
    }
    const resolvedContinuePrompt = continueSkillContext?.userText ?? event.payload.prompt;
    const continuedPrompt = buildContinuePrompt(resolvedContinuePrompt, session.assistantSkillNames);
    const effectiveContinuedPrompt = applyAssistantContextToPrompt(continuedPrompt, {
      skillNames: session.assistantSkillNames,
      assistantId: session.assistantId,
      activatedSkillContent: continueActivatedContent,
    });
    const canResumeRemotely = Boolean(session.claudeSessionId && session.resumeReady);

    if (!canResumeRemotely || shouldSwitchSkills) {
      await continueWithLocalHistoryFallback(
        session,
        resolvedContinuePrompt,
        continueSkillContext?.skillContent,
      );
      return;
    }

    if (useEmbeddedApi()) {
      // Use sidecar API for both Claude and Codex — supports multi-instance
      activeSessions.add(session.id);
      let shouldFallback = false;
      let usedFallback = false;
      try {
        await apiContinueSession(
          session.claudeSessionId!,
          continuedPrompt,
          (apiEvent) => {
            if ('payload' in apiEvent && 'sessionId' in (apiEvent.payload as any)) {
              (apiEvent.payload as any).sessionId = session.id;
            }
            if (apiEvent.type === 'stream.user_prompt') return;
            if (apiEvent.type === 'stream.message') {
              const msg = (apiEvent.payload as any).message;
              if (shouldFallbackFromContinueError(msg)) {
                shouldFallback = true;
                return;
              }
            }
            if (shouldFallback && apiEvent.type === 'session.status' && (apiEvent.payload as any).status === 'error') {
              return;
            }
            emit(apiEvent);
          },
          {
            cwd: session.cwd,
            title: session.title,
            externalSessionId: session.id,
            provider: sessionProvider,
            model: session.model,
            assistantId: session.assistantId,
            assistantSkillNames: session.assistantSkillNames,
            assistantActivatedSkillContent: continueSkillContext?.skillContent,
          }
        );
        if (shouldFallback) {
          usedFallback = true;
          await continueWithLocalHistoryFallback(
            session,
            resolvedContinuePrompt,
            continueSkillContext?.skillContent,
          );
        }
      } catch (error) {
        if (shouldFallbackFromContinueError(error)) {
          usedFallback = true;
          await continueWithLocalHistoryFallback(
            session,
            resolvedContinuePrompt,
            continueSkillContext?.skillContent,
          );
          return;
        }
        sessions.updateSession(session.id, { status: 'error' });
        emit({
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status: 'error',
            title: session.title,
            cwd: session.cwd,
            error: String(error),
            assistantId: session.assistantId,
          },
        });
      } finally {
        if (!usedFallback) {
          activeSessions.delete(session.id);
          // Ensure session is never left stuck in "running" state if the SSE stream
          // ended without the runner emitting a terminal status event.
          const continueStatus = sessions.getSession(session.id)?.status;
          if (continueStatus === 'running') {
            sessions.updateSession(session.id, { status: 'idle' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'idle', title: session.title, cwd: session.cwd, assistantId: session.assistantId },
            });
          }
        }
      }
    } else {
      // Fallback: direct SDK when sidecar is unavailable
      let usedFallback = false;
      runClaude({
          prompt: effectiveContinuedPrompt,
          session,
          resumeSessionId: session.claudeSessionId,
          provider: toRunnerProvider(sessionProvider),
          onEvent: emit,
          onSessionUpdate: (updates) => {
            sessions.updateSession(session.id, updates);
          },
          onContinueMissingConversation: async () => {
            if (usedFallback) return;
            usedFallback = true;
            runnerHandles.delete(session.id);
            await continueWithLocalHistoryFallback(
              session,
              resolvedContinuePrompt,
              continueSkillContext?.skillContent,
            );
          },
        })
          .then((handle) => {
            runnerHandles.set(session.id, handle);
          })
          .catch((error) => {
            sessions.updateSession(session.id, { status: 'error' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
            });
          });
    }

    return;
  }

  if (event.type === 'session.stop') {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) return;

    if (useEmbeddedApi()) {
      try {
        await apiStopSession(session.id);
      } catch (error) {
        console.error('Failed to stop session via API:', error);
      }
      activeSessions.delete(session.id);
    } else {
      const handle = runnerHandles.get(session.id);
      if (handle) {
        handle.abort();
        runnerHandles.delete(session.id);
      }
    }

    sessions.updateSession(session.id, { status: 'idle' });
    emit({
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'idle',
        title: session.title,
        cwd: session.cwd,
        assistantId: session.assistantId,
      },
    });
    return;
  }

  if (event.type === 'session.delete') {
    const sessionId = event.payload.sessionId;

    if (useEmbeddedApi()) {
      if (activeSessions.has(sessionId)) {
        try {
          await apiStopSession(sessionId);
        } catch (error) {
          console.error('Failed to stop session via API:', error);
        }
        activeSessions.delete(sessionId);
      }
    } else {
      const handle = runnerHandles.get(sessionId);
      if (handle) {
        handle.abort();
        runnerHandles.delete(sessionId);
      }
    }

    sessions.deleteSession(sessionId);
    emit({
      type: 'session.deleted',
      payload: { sessionId },
    });
    return;
  }

  if (event.type === 'permission.response') {
    if (useEmbeddedApi()) {
      try {
        await apiSendPermissionResponse(
          event.payload.sessionId,
          event.payload.toolUseId,
          event.payload.result
        );
      } catch (error) {
        console.error('Failed to send permission response:', error);
      }
    } else {
      // Direct mode - resolve the pending permission
      const session = sessions.getSession(event.payload.sessionId);
      if (session) {
        const pending = session.pendingPermissions.get(event.payload.toolUseId);
        if (pending) {
          pending.resolve(event.payload.result);
        }
      }
    }
    return;
  }
}

export { sessions };
