/**
 * Session service for the embedded API server.
 * Uses in-memory storage.
 */

import type {
  Session,
  StoredSession,
  StreamMessage,
  SessionHistory,
  PendingPermission,
} from '../types.js';

// Module-level state (in-memory)
const sessions = new Map<string, Session>();
const messages = new Map<string, StreamMessage[]>();

export async function initSessionStore(_dataDir: string): Promise<void> {
  console.log('[API] Session store initialized (in-memory mode)');
}

export async function shutdownSessionStore(): Promise<void> {
  sessions.clear();
  messages.clear();
}

export function createSession(options: {
  cwd?: string;
  allowedTools?: string;
  prompt?: string;
  title: string;
  externalId?: string;
  assistantId?: string;
  assistantSkillNames?: string[];
  background?: boolean;
}): Session {
  const id = crypto.randomUUID();
  const now = Date.now();
  const session: Session = {
    id,
    externalId: options.externalId,
    title: options.title,
    status: 'idle',
    resumeReady: false,
    cwd: options.cwd,
    allowedTools: options.allowedTools,
    lastPrompt: options.prompt,
    assistantId: options.assistantId,
    assistantSkillNames: options.assistantSkillNames ?? [],
    background: options.background,
    pendingPermissions: new Map(),
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(id, session);
  messages.set(id, []);

  // Also index by externalId if provided
  if (options.externalId) {
    sessions.set(options.externalId, session);
  }

  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): StoredSession[] {
  return Array.from(sessions.values())
    .map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      cwd: s.cwd,
      allowedTools: s.allowedTools,
      lastPrompt: s.lastPrompt,
      claudeSessionId: s.claudeSessionId,
      resumeReady: s.resumeReady,
      assistantId: s.assistantId,
      assistantSkillNames: s.assistantSkillNames,
      background: s.background,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listRecentCwds(limit = 8): string[] {
  const cwdMap = new Map<string, number>();

  for (const session of sessions.values()) {
    if (session.cwd && session.cwd.trim()) {
      const existing = cwdMap.get(session.cwd) || 0;
      if (session.updatedAt > existing) {
        cwdMap.set(session.cwd, session.updatedAt);
      }
    }
  }

  return Array.from(cwdMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cwd]) => cwd);
}

export function getSessionHistory(id: string): SessionHistory | null {
  const session = sessions.get(id);
  if (!session) return null;

  const sessionMessages = messages.get(id) || [];

  return {
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      cwd: session.cwd,
      allowedTools: session.allowedTools,
      lastPrompt: session.lastPrompt,
      claudeSessionId: session.claudeSessionId,
      resumeReady: session.resumeReady,
      assistantId: session.assistantId,
      assistantSkillNames: session.assistantSkillNames,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messages: sessionMessages,
  };
}

export function updateSession(id: string, updates: Partial<Session>): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;

  Object.assign(session, updates, { updatedAt: Date.now() });

  return session;
}

export function setAbortController(id: string, controller: AbortController | undefined): void {
  const session = sessions.get(id);
  if (!session) return;
  session.abortController = controller;
}

export function recordMessage(sessionId: string, message: StreamMessage): void {
  const sessionMessages = messages.get(sessionId);
  if (sessionMessages) {
    sessionMessages.push(message);
  }
}

export function deleteSession(id: string): boolean {
  const existing = sessions.get(id);
  if (!existing) return false;

  sessions.delete(id);
  messages.delete(id);

  return true;
}

export function addPendingPermission(
  sessionId: string,
  permission: PendingPermission
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pendingPermissions.set(permission.toolUseId, permission);
}

export function getPendingPermission(
  sessionId: string,
  toolUseId: string
): PendingPermission | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return session.pendingPermissions.get(toolUseId);
}

export function resolvePendingPermission(
  sessionId: string,
  toolUseId: string,
  result: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  const pending = session.pendingPermissions.get(toolUseId);
  if (!pending) return false;

  pending.resolve(result);
  session.pendingPermissions.delete(toolUseId);
  return true;
}
