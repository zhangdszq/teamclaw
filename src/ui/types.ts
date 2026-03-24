import type { SDKMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type UserPromptMessage = {
  type: "user_prompt";
  prompt: string;
};

export type StreamMessage = SDKMessage | UserPromptMessage;

export type SessionStatus = "idle" | "running" | "completed" | "error";

export type SessionInfo = {
  id: string;
  title: string;
  status: SessionStatus;
  claudeSessionId?: string;
  resumeReady?: boolean;
  cwd?: string;
  provider?: AgentProvider;
  assistantId?: string;
  background?: boolean;
  createdAt: number;
  updatedAt: number;
};

// Pending permission request info
export type PendingPermissionInfo = {
  toolUseId: string;
  toolName: string;
  input: unknown;
};

// Server -> Client events
export type ServerEvent =
  | { type: "stream.message"; payload: { sessionId: string; message: StreamMessage } }
  | { type: "stream.user_prompt"; payload: { sessionId: string; prompt: string } }
  | { type: "session.status"; payload: { sessionId: string; status: SessionStatus; title?: string; cwd?: string; error?: string; provider?: AgentProvider; assistantId?: string; background?: boolean } }
  | { type: "session.list"; payload: { sessions: SessionInfo[] } }
  | { type: "session.history"; payload: { sessionId: string; status: SessionStatus; messages: StreamMessage[]; pendingPermissions?: PendingPermissionInfo[] } }
  | { type: "session.deleted"; payload: { sessionId: string } }
  | { type: "permission.request"; payload: { sessionId: string; toolUseId: string; toolName: string; input: unknown } }
  | { type: "runner.error"; payload: { sessionId?: string; message: string } }
  | {
      type: "heartbeat.report";
      payload: {
        assistantId: string;
        assistantName: string;
        text: string;
        ts: number;
        status?: "healthy" | "heartbeat_running" | "heartbeat_failed" | "heartbeat_unknown";
        noAction?: boolean;
        source?: "json" | "legacy" | "missing";
        notificationAttempts?: number;
        notificationSuccesses?: number;
      };
    };

export type AgentProvider = "claude" | "openai";

// Client -> Server events
export type ClientEvent =
  | { type: "session.start"; payload: { title: string; prompt: string; cwd?: string; allowedTools?: string; provider?: AgentProvider; model?: string; assistantId?: string; assistantSkillNames?: string[]; assistantDiscoverySkillNames?: string[]; assistantPersona?: string; background?: boolean; workflowSopId?: string; scheduledTaskId?: string; sourceType?: string; sourceChannel?: string } }
  | { type: "session.continue"; payload: { sessionId: string; prompt: string; assistantSkillNames?: string[]; assistantDiscoverySkillNames?: string[]; sourceType?: string; sourceChannel?: string } }
  | { type: "session.stop"; payload: { sessionId: string } }
  | { type: "session.delete"; payload: { sessionId: string } }
  | { type: "session.list" }
  | { type: "session.history"; payload: { sessionId: string } }
  | { type: "permission.response"; payload: { sessionId: string; toolUseId: string; result: PermissionResult } };
