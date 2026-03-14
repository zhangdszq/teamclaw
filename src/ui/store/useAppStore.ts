import { create } from 'zustand';
import type { ServerEvent, SessionStatus, StreamMessage, AgentProvider } from "../types";

export type PermissionRequest = {
  toolUseId: string;
  toolName: string;
  input: unknown;
};

export type HeartbeatReport = {
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

export type SessionView = {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  provider?: AgentProvider;
  assistantId?: string;
  background?: boolean;
  messages: StreamMessage[];
  permissionRequests: PermissionRequest[];
  lastPrompt?: string;
  createdAt?: number;
  updatedAt?: number;
  hydrated: boolean;
};

interface AppState {
  sessions: Record<string, SessionView>;
  activeSessionId: string | null;
  prompt: string;
  cwd: string;
  pendingStart: boolean;
  globalError: string | null;
  sessionsLoaded: boolean;
  showStartModal: boolean;
  historyRequested: Set<string>;
  showSystemInfo: boolean;  // Toggle for showing System Init and Session Result
  provider: AgentProvider;  // Current agent provider selection
  assistantModel: string;   // Per-assistant model override (works for both Claude and Codex)
  selectedAssistantId: string | null;
  selectedAssistantSkillNames: string[];
  selectedAssistantSkillTags: string[];
  selectedAssistantPersona: string;
  heartbeatReports: HeartbeatReport[];
  skills: SkillInfo[];

  setPrompt: (prompt: string) => void;
  setCwd: (cwd: string) => void;
  setPendingStart: (pending: boolean) => void;
  setGlobalError: (error: string | null) => void;
  setShowStartModal: (show: boolean) => void;
  setActiveSessionId: (id: string | null) => void;
  markHistoryRequested: (sessionId: string) => void;
  resolvePermissionRequest: (sessionId: string, toolUseId: string) => void;
  handleServerEvent: (event: ServerEvent) => void;
  addLocalMessage: (sessionId: string, message: StreamMessage) => void;
  revertSessionToBeforeLastPrompt: (sessionId: string) => void;
  setShowSystemInfo: (show: boolean) => void;
  setProvider: (provider: AgentProvider) => void;
  setAssistantModel: (model: string) => void;
  setSelectedAssistant: (assistantId: string, skillNames?: string[], provider?: AgentProvider, model?: string, persona?: string, skillTags?: string[]) => void;
  dismissHeartbeatReport: (ts: number) => void;
  refreshSkills: () => Promise<void>;
}

function createSession(id: string): SessionView {
  return { id, title: "", status: "idle", messages: [], permissionRequests: [], hydrated: false };
}

export const useAppStore = create<AppState>((set, get) => ({
  sessions: {},
  activeSessionId: null,
  prompt: "",
  cwd: "",
  pendingStart: false,
  globalError: null,
  sessionsLoaded: false,
  showStartModal: false,
  historyRequested: new Set(),
  showSystemInfo: false,  // Default to hidden
  provider: "claude",
  assistantModel: "",
  selectedAssistantId: null,
  selectedAssistantSkillNames: [],
  selectedAssistantSkillTags: [],
  selectedAssistantPersona: "",
  heartbeatReports: [],
  skills: [],

  setPrompt: (prompt) => set({ prompt }),
  setCwd: (cwd) => set({ cwd }),
  setPendingStart: (pendingStart) => set({ pendingStart }),
  setGlobalError: (globalError) => set({ globalError }),
  setShowStartModal: (showStartModal) => set({ showStartModal }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setShowSystemInfo: (showSystemInfo) => set({ showSystemInfo }),
  setProvider: (provider) => set({ provider }),
  setAssistantModel: (assistantModel) => set({ assistantModel }),
  setSelectedAssistant: (assistantId, skillNames = [], provider, model, persona, skillTags = []) => {
    try { localStorage.setItem("vk-cowork-selected-assistant", assistantId); } catch {}
    set((state) => ({
      selectedAssistantId: assistantId,
      selectedAssistantSkillNames: skillNames,
      selectedAssistantSkillTags: skillTags,
      selectedAssistantPersona: persona ?? "",
      provider: provider ?? state.provider,
      assistantModel: model ?? "",
    }));
  },

  dismissHeartbeatReport: (ts) =>
    set((state) => ({
      heartbeatReports: state.heartbeatReports.filter((r) => r.ts !== ts),
    })),

  refreshSkills: async () => {
    try {
      const config = await window.electron.getClaudeConfig();
      set({ skills: config.skills ?? [] });
    } catch {
      // best-effort
    }
  },

  markHistoryRequested: (sessionId) => {
    set((state) => {
      const next = new Set(state.historyRequested);
      next.add(sessionId);
      return { historyRequested: next };
    });
  },

  resolvePermissionRequest: (sessionId, toolUseId) => {
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            permissionRequests: existing.permissionRequests.filter(req => req.toolUseId !== toolUseId)
          }
        }
      };
    });
  },

  handleServerEvent: (event) => {
    const state = get();

    switch (event.type) {
      case "session.list": {
        const nextSessions: Record<string, SessionView> = {};
        for (const session of event.payload.sessions) {
          const existing = state.sessions[session.id] ?? createSession(session.id);
          nextSessions[session.id] = {
            ...existing,
            status: session.status,
            title: session.title,
            cwd: session.cwd,
            provider: session.provider,
            assistantId: session.assistantId,
            background: session.background,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
          };
        }
        set({ sessions: nextSessions, sessionsLoaded: true });

        const visibleSessions = event.payload.sessions.filter(s => !s.background);
        const hasSessions = visibleSessions.length > 0;
        set({ showStartModal: !hasSessions });

        if (!hasSessions) {
          get().setActiveSessionId(null);
        }

        if (!state.activeSessionId && visibleSessions.length > 0) {
          const sorted = [...visibleSessions].sort((a, b) => {
            const aTime = a.updatedAt ?? a.createdAt ?? 0;
            const bTime = b.updatedAt ?? b.createdAt ?? 0;
            return aTime - bTime;
          });
          const latestSession = sorted[sorted.length - 1];
          if (latestSession) {
            get().setActiveSessionId(latestSession.id);
          }
        } else if (state.activeSessionId) {
          const activeSession = event.payload.sessions.find(
            (session) => session.id === state.activeSessionId
          );
          if (!activeSession || activeSession.background) {
            const fallback = visibleSessions.sort((a, b) => {
              const aTime = a.updatedAt ?? a.createdAt ?? 0;
              const bTime = b.updatedAt ?? b.createdAt ?? 0;
              return bTime - aTime;
            })[0];
            get().setActiveSessionId(fallback?.id ?? null);
          }
        }
        break;
      }

      case "session.history": {
        const { sessionId, messages, status, pendingPermissions } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          // Restore pending permissions from backend
          const restoredPermissions: PermissionRequest[] = (pendingPermissions ?? []).map(p => ({
            toolUseId: p.toolUseId,
            toolName: p.toolName,
            input: p.input
          }));
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { 
                ...existing, 
                status, 
                messages, 
                hydrated: true,
                // Merge existing permissions with restored ones (avoid duplicates)
                permissionRequests: [
                  ...existing.permissionRequests.filter(
                    req => !restoredPermissions.some(r => r.toolUseId === req.toolUseId)
                  ),
                  ...restoredPermissions
                ]
              }
            }
          };
        });
        break;
      }

      case "session.status": {
        const { sessionId, status, title, cwd, provider: sessionProvider, assistantId, background } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                status,
                title: title ?? existing.title,
                cwd: cwd ?? existing.cwd,
                provider: sessionProvider ?? existing.provider,
                assistantId: assistantId ?? existing.assistantId,
                background: background ?? existing.background,
                updatedAt: Date.now()
              }
            }
          };
        });

        if (state.pendingStart && !background) {
          get().setActiveSessionId(sessionId);
          set({ pendingStart: false, showStartModal: false });
        }
        break;
      }

      case "session.deleted": {
        const { sessionId } = event.payload;
        const state = get();
        if (!state.sessions[sessionId]) break;
        const nextSessions = { ...state.sessions };
        delete nextSessions[sessionId];
        const visibleRemaining = Object.values(nextSessions).filter(s => !s.background);
        set({
          sessions: nextSessions,
          showStartModal: visibleRemaining.length === 0
        });
        if (state.activeSessionId === sessionId) {
          const sorted = visibleRemaining.sort(
            (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
          );
          get().setActiveSessionId(sorted[0]?.id ?? null);
        }
        break;
      }

      case "stream.message": {
        const { sessionId, message } = event.payload;
        if (!(message as any)._ts) (message as any)._ts = Date.now();
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...existing, messages: [...existing.messages, message] }
            }
          };
        });
        break;
      }

      case "stream.user_prompt": {
        const { sessionId, prompt } = event.payload;
        const msg: StreamMessage & { _ts: number } = { type: "user_prompt", prompt, _ts: Date.now() };
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                messages: [...existing.messages, msg]
              }
            }
          };
        });
        break;
      }

      case "permission.request": {
        const { sessionId, toolUseId, toolName, input } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                permissionRequests: [...existing.permissionRequests, { toolUseId, toolName, input }]
              }
            }
          };
        });
        break;
      }

      case "runner.error": {
        set({ globalError: event.payload.message });
        break;
      }

      case "heartbeat.report": {
        const report = event.payload;
        set((state) => ({
          heartbeatReports: [...state.heartbeatReports, report],
        }));
        break;
      }
    }
  },

  addLocalMessage: (sessionId, message) => {
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, messages: [...existing.messages, message] }
        }
      };
    });
  },

  revertSessionToBeforeLastPrompt: (sessionId) => {
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return {};
      const msgs = existing.messages;
      // Find the last user_prompt index
      let cutIndex = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if ((msgs[i] as any).type === "user_prompt") {
          cutIndex = i;
          break;
        }
      }
      if (cutIndex === -1) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...existing, messages: msgs.slice(0, cutIndex) }
        }
      };
    });
  }
}));
