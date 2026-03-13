import Database from "better-sqlite3";
import type { SessionStatus, StreamMessage, AgentProvider } from "../types.js";

export type PendingPermission = {
  toolUseId: string;
  toolName: string;
  input: unknown;
  resolve: (result: { behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }) => void;
};

export type Session = {
  id: string;
  title: string;
  claudeSessionId?: string;
  resumeReady?: boolean;
  status: SessionStatus;
  cwd?: string;
  allowedTools?: string;
  lastPrompt?: string;
  provider?: AgentProvider;
  model?: string;
  assistantId?: string;
  assistantSkillNames?: string[];
  activatedSkillName?: string;
  activatedSkillContent?: string;
  background?: boolean;
  hidden?: boolean;
  workflowSopId?: string;    // in-memory: set when session is part of a SOP workflow
  scheduledTaskId?: string;  // in-memory: set when session was triggered by a scheduled task
  pendingPermissions: Map<string, PendingPermission>;
  abortController?: AbortController;
};

export type StoredSession = {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  allowedTools?: string;
  lastPrompt?: string;
  claudeSessionId?: string;
  resumeReady?: boolean;
  provider?: AgentProvider;
  model?: string;
  assistantId?: string;
  assistantSkillNames?: string[];
  background?: boolean;
  hidden?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SessionHistory = {
  session: StoredSession;
  messages: StreamMessage[];
};

function parseSkillNames(raw: unknown): string[] {
  if (!raw) return [];
  try {
    // Handle string input
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    }
    // Handle array input
    if (Array.isArray(raw)) {
      return raw.filter((item): item is string => typeof item === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

// Type guard for SessionStatus
function isValidSessionStatus(status: unknown): status is SessionStatus {
  return typeof status === 'string' && ['idle', 'running', 'completed', 'error'].includes(status);
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private db: Database.Database;
  // Lock map for session updates to prevent race conditions
  private updateLocks = new Map<string, Promise<void>>();
  // Global lock for creating new sessions
  private createSessionLock = false;

  // ── Batched message write queue ──
  private messageQueue: Array<{ id: string; sessionId: string; data: string; createdAt: number }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 200;
  private static readonly FLUSH_BATCH_SIZE = 50;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
    this.loadSessions();
  }

  createSession(options: { cwd?: string; allowedTools?: string; prompt?: string; title: string; provider?: AgentProvider; model?: string; assistantId?: string; assistantSkillNames?: string[]; background?: boolean; workflowSopId?: string; scheduledTaskId?: string }): Session {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      title: options.title,
      status: "idle",
      resumeReady: false,
      cwd: options.cwd,
      allowedTools: options.allowedTools,
      lastPrompt: options.prompt,
      provider: options.provider ?? "claude",
      model: options.model,
      assistantId: options.assistantId,
      assistantSkillNames: options.assistantSkillNames ?? [],
      background: options.background,
      workflowSopId: options.workflowSopId,
      scheduledTaskId: options.scheduledTaskId,
      pendingPermissions: new Map()
    };
    this.sessions.set(id, session);
    this.db
      .prepare(
        `insert into sessions
          (id, title, claude_session_id, resume_ready, status, cwd, allowed_tools, last_prompt, provider, model, assistant_id, assistant_skill_names, background, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        session.title,
        session.claudeSessionId ?? null,
        session.resumeReady ? 1 : 0,
        session.status,
        session.cwd ?? null,
        session.allowedTools ?? null,
        session.lastPrompt ?? null,
        session.provider ?? "claude",
        session.model ?? null,
        session.assistantId ?? null,
        JSON.stringify(session.assistantSkillNames ?? []),
        session.background ? 1 : 0,
        now,
        now
      );
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): StoredSession[] {
    const rows = this.db
      .prepare(
        `select id, title, claude_session_id, status, cwd, allowed_tools, last_prompt, provider, model, assistant_id, assistant_skill_names, background, hidden, created_at, updated_at
         , resume_ready
         from sessions
         where hidden is null or hidden = 0
         order by updated_at desc`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      status: row.status as SessionStatus,
      cwd: row.cwd ? String(row.cwd) : undefined,
      allowedTools: row.allowed_tools ? String(row.allowed_tools) : undefined,
      lastPrompt: row.last_prompt ? String(row.last_prompt) : undefined,
      claudeSessionId: row.claude_session_id ? String(row.claude_session_id) : undefined,
      resumeReady: Boolean(row.resume_ready),
      provider: (row.provider as AgentProvider) ?? "claude",
      model: row.model ? String(row.model) : undefined,
      assistantId: row.assistant_id ? String(row.assistant_id) : undefined,
      assistantSkillNames: parseSkillNames(row.assistant_skill_names),
      background: Boolean(row.background),
      hidden: Boolean(row.hidden),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }));
  }

  listRecentCwds(limit = 8): string[] {
    const rows = this.db
      .prepare(
        `select cwd, max(updated_at) as latest
         from sessions
         where cwd is not null and trim(cwd) != ''
         group by cwd
         order by latest desc
         limit ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.cwd));
  }

  getSessionHistory(id: string): SessionHistory | null {
    const sessionRow = this.db
      .prepare(
        `select id, title, claude_session_id, status, cwd, allowed_tools, last_prompt, provider, model, assistant_id, assistant_skill_names, created_at, updated_at
         , resume_ready
         from sessions
         where id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!sessionRow) return null;

    const messages = (this.db
      .prepare(
        `select data, created_at from messages where session_id = ? order by created_at asc`
      )
      .all(id) as Array<Record<string, unknown>>)
      .map((row) => {
        const msg = JSON.parse(String(row.data)) as StreamMessage;
        (msg as any)._ts = Number(row.created_at);
        return msg;
      });

    return {
      session: {
        id: String(sessionRow.id),
        title: String(sessionRow.title),
        status: sessionRow.status as SessionStatus,
        cwd: sessionRow.cwd ? String(sessionRow.cwd) : undefined,
        allowedTools: sessionRow.allowed_tools ? String(sessionRow.allowed_tools) : undefined,
        lastPrompt: sessionRow.last_prompt ? String(sessionRow.last_prompt) : undefined,
        claudeSessionId: sessionRow.claude_session_id ? String(sessionRow.claude_session_id) : undefined,
        resumeReady: Boolean(sessionRow.resume_ready),
        provider: (sessionRow.provider as AgentProvider) ?? "claude",
        model: sessionRow.model ? String(sessionRow.model) : undefined,
        assistantId: sessionRow.assistant_id ? String(sessionRow.assistant_id) : undefined,
        assistantSkillNames: parseSkillNames(sessionRow.assistant_skill_names),
        createdAt: Number(sessionRow.created_at),
        updatedAt: Number(sessionRow.updated_at)
      },
      messages
    };
  }

  updateSession(id: string, updates: Partial<Session>): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return;
    // Keep in-memory + DB updates in the same call path.
    Object.assign(session, updates);
    this.persistSession(id, updates);
  }

  // Type-safe status validation
  validateAndNormalizeStatus(status: unknown): SessionStatus | undefined {
    if (isValidSessionStatus(status)) {
      return status;
    }
    return undefined;
  }

  setAbortController(id: string, controller: AbortController | undefined): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.abortController = controller;
  }

  recordMessage(sessionId: string, message: StreamMessage): void {
    if (!this.sessions.has(sessionId)) {
      console.warn(`[SessionStore] Skip recordMessage: unknown session ${sessionId}`);
      return;
    }
    const id = ('uuid' in message && message.uuid) ? String(message.uuid) : crypto.randomUUID();
    this.db
      .prepare(
        `insert or ignore into messages (id, session_id, data, created_at) values (?, ?, ?, ?)`
      )
      .run(id, sessionId, JSON.stringify(message), Date.now());
  }

  queueMessage(sessionId: string, message: StreamMessage): void {
    if (!this.sessions.has(sessionId)) {
      console.warn(`[SessionStore] Skip queueMessage: unknown session ${sessionId}`);
      return;
    }
    const id = ('uuid' in message && message.uuid) ? String(message.uuid) : crypto.randomUUID();
    this.messageQueue.push({ id, sessionId, data: JSON.stringify(message), createdAt: Date.now() });

    if (this.messageQueue.length >= SessionStore.FLUSH_BATCH_SIZE) {
      this.flushQueuedMessages();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushQueuedMessages(), SessionStore.FLUSH_INTERVAL_MS);
    }
  }

  flushQueuedMessages(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.messageQueue.splice(0);
    if (batch.length === 0) return;

    const insert = this.db.prepare(
      `insert or ignore into messages (id, session_id, data, created_at) values (?, ?, ?, ?)`
    );
    const runBatch = this.db.transaction((rows: typeof batch) => {
      for (const row of rows) {
        if (!this.sessions.has(row.sessionId)) {
          continue;
        }
        insert.run(row.id, row.sessionId, row.data, row.createdAt);
      }
    });
    runBatch(batch);
  }

  deleteSession(id: string): boolean {
    const existing = this.sessions.get(id);
    if (existing) {
      this.sessions.delete(id);
    }
    this.db.prepare(`delete from messages where session_id = ?`).run(id);
    const result = this.db.prepare(`delete from sessions where id = ?`).run(id);
    const removedFromDb = result.changes > 0;
    return removedFromDb || Boolean(existing);
  }

  private persistSession(id: string, updates: Partial<Session>): void {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const updatable = {
      claudeSessionId: "claude_session_id",
      resumeReady: "resume_ready",
      status: "status",
      cwd: "cwd",
      allowedTools: "allowed_tools",
      lastPrompt: "last_prompt",
      provider: "provider",
      model: "model",
      assistantId: "assistant_id",
      assistantSkillNames: "assistant_skill_names",
      background: "background",
      hidden: "hidden",
    } as const;

    for (const key of Object.keys(updates) as Array<keyof typeof updatable>) {
      const column = updatable[key];
      if (!column) continue;
      fields.push(`${column} = ?`);
      const value = updates[key];
      if (key === "assistantSkillNames") {
        values.push(value === undefined ? null : JSON.stringify(value));
      } else if (key === "hidden" || key === "background" || key === "resumeReady") {
        values.push(value === undefined ? null : (value ? 1 : 0));
      } else {
        values.push(value === undefined ? null : (value as string));
      }
    }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    this.db
      .prepare(`update sessions set ${fields.join(", ")} where id = ?`)
      .run(...values);
  }

  private initialize(): void {
    this.db.exec(`pragma journal_mode = WAL;`);
    this.db.exec(
      `create table if not exists sessions (
        id text primary key,
        title text,
        claude_session_id text,
        resume_ready integer default 0,
        status text not null,
        cwd text,
        allowed_tools text,
        last_prompt text,
        provider text default 'claude',
        model text,
        assistant_id text,
        assistant_skill_names text,
        created_at integer not null,
        updated_at integer not null
      )`
    );
    // Migration: add provider and model columns if they don't exist
    try { this.db.exec(`alter table sessions add column provider text default 'claude'`); } catch { /* already exists */ }
    try { this.db.exec(`alter table sessions add column model text`); } catch { /* already exists */ }
    try { this.db.exec(`alter table sessions add column assistant_id text`); } catch { /* already exists */ }
    try { this.db.exec(`alter table sessions add column assistant_skill_names text`); } catch { /* already exists */ }
    try { this.db.exec(`alter table sessions add column background integer default 0`); } catch { /* already exists */ }
    try { this.db.exec(`alter table sessions add column hidden integer default 0`); } catch { /* already exists */ }
    try { this.db.exec(`alter table sessions add column resume_ready integer default 0`); } catch { /* already exists */ }
    this.db.exec(
      `create table if not exists messages (
        id text primary key,
        session_id text not null,
        data text not null,
        created_at integer not null,
        foreign key (session_id) references sessions(id)
      )`
    );
    this.db.exec(`create index if not exists messages_session_id on messages(session_id)`);
  }

  private loadSessions(): void {
    const rows = this.db
      .prepare(
        `select id, title, claude_session_id, resume_ready, status, cwd, allowed_tools, last_prompt, provider, model, assistant_id, assistant_skill_names, background, hidden
         from sessions`
      )
      .all();
    for (const row of rows as Array<Record<string, unknown>>) {
      const session: Session = {
        id: String(row.id),
        title: String(row.title),
        claudeSessionId: row.claude_session_id ? String(row.claude_session_id) : undefined,
        resumeReady: Boolean(row.resume_ready),
        status: row.status as SessionStatus,
        cwd: row.cwd ? String(row.cwd) : undefined,
        allowedTools: row.allowed_tools ? String(row.allowed_tools) : undefined,
        lastPrompt: row.last_prompt ? String(row.last_prompt) : undefined,
        provider: (row.provider as AgentProvider) ?? "claude",
        model: row.model ? String(row.model) : undefined,
        assistantId: row.assistant_id ? String(row.assistant_id) : undefined,
        assistantSkillNames: parseSkillNames(row.assistant_skill_names),
        background: Boolean(row.background),
        hidden: Boolean(row.hidden),
        pendingPermissions: new Map()
      };
      this.sessions.set(session.id, session);
    }
  }
}
