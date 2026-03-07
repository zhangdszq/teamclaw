/**
 * Types for the embedded API server
 */

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export type PendingPermission = {
  toolUseId: string;
  toolName: string;
  input: unknown;
  resolve: (result: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }) => void;
};

export type AgentProvider = 'claude' | 'openai';

export type Session = {
  id: string;
  externalId?: string;
  title: string;
  claudeSessionId?: string;
  status: SessionStatus;
  cwd?: string;
  allowedTools?: string;
  lastPrompt?: string;
  provider?: AgentProvider;
  model?: string;
  assistantId?: string;
  assistantSkillNames?: string[];
  background?: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  abortController?: AbortController;
  createdAt: number;
  updatedAt: number;
};

export type StoredSession = {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  allowedTools?: string;
  lastPrompt?: string;
  claudeSessionId?: string;
  assistantId?: string;
  assistantSkillNames?: string[];
  background?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StreamMessage = {
  type: string;
  [key: string]: unknown;
};

export type SessionHistory = {
  session: StoredSession;
  messages: StreamMessage[];
};
