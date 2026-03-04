import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAppStore } from "../store/useAppStore";
import { SettingsModal } from "./SettingsModal";
import { AssistantManagerModal } from "./AssistantManagerModal";
import { SchedulerModal } from "./SchedulerModal";

const ASSISTANT_CWDS_KEY = "vk-cowork-assistant-cwds";
export const ASSISTANT_PANEL_WIDTH = 168;

function loadAssistantCwdLocal(assistantId: string | null): string {
  if (!assistantId) return "";
  try {
    const map = JSON.parse(localStorage.getItem(ASSISTANT_CWDS_KEY) || "{}");
    return map[assistantId] ?? "";
  } catch { return ""; }
}

interface SidebarProps {
  connected: boolean;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  width: number;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onOpenSkill?: () => void;
  onOpenMcp?: () => void;
  onNoWorkspace?: () => void;
  taskPanelVisible: boolean;
  onToggleTaskPanel: () => void;
  onShowSplash?: () => void;
  onOpenSop?: () => void;
  onOpenKnowledge?: () => void;
  titleBarHeight?: number;
}

export function Sidebar({
  onDeleteSession,
  width,
  onResizeStart,
  onOpenSkill,
  onOpenMcp,
  onNoWorkspace,
  taskPanelVisible,
  onToggleTaskPanel,
  onShowSplash,
  onOpenSop,
  onOpenKnowledge,
  titleBarHeight = 0,
}: SidebarProps) {
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setActiveSessionId = useAppStore((state) => state.setActiveSessionId);
  const selectedAssistantId = useAppStore((state) => state.selectedAssistantId);
  const setSelectedAssistant = useAppStore((state) => state.setSelectedAssistant);
  const setCwd = useAppStore((state) => state.setCwd);

  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAssistantManager, setShowAssistantManager] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);

  const effectiveWidth = taskPanelVisible ? width : ASSISTANT_PANEL_WIDTH;


  const formatCwd = (cwd?: string) => {
    if (!cwd) return "Working dir unavailable";
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return `/${tail || cwd}`;
  };

  const sessionList = useMemo(() => {
    const list = Object.values(sessions);
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return list;
  }, [sessions]);

  const loadAssistants = useCallback(() => {
    window.electron.getAssistantsConfig().then((config) => {
      const list = config.assistants ?? [];
      setAssistants(list);
      if (!list.length) return;
      const currentId = useAppStore.getState().selectedAssistantId;
      const fallbackId = config.defaultAssistantId ?? list[0]?.id;
      const targetId = list.some((item) => item.id === currentId) ? currentId : fallbackId;
      const target = list.find((item) => item.id === targetId) ?? list[0];
      if (target) {
        setSelectedAssistant(target.id, target.skillNames ?? [], target.provider, target.model, target.persona, target.skillTags ?? []);
        // 从 localStorage 恢复该助理的工作区（仅当 cwd 为空时）
        if (!useAppStore.getState().cwd) {
          const savedCwd = loadAssistantCwdLocal(target.id);
          if (savedCwd) setCwd(savedCwd);
        }
      }
    }).catch(console.error);
  }, [setSelectedAssistant, setCwd]);

  useEffect(() => {
    loadAssistants();
  }, [loadAssistants]);

  useEffect(() => {
    return window.electron.onAssistantsConfigChanged(() => {
      loadAssistants();
    });
  }, [loadAssistants]);

  const currentAssistant = useMemo(() => {
    if (!assistants.length) return undefined;
    if (!selectedAssistantId) return assistants[0];
    return assistants.find((item) => item.id === selectedAssistantId) ?? assistants[0];
  }, [assistants, selectedAssistantId]);

  const filteredSessions = useMemo(() => {
    if (!currentAssistant) {
      return sessionList.filter((session) => !session.assistantId && !session.background);
    }
    return sessionList.filter((session) => session.assistantId === currentAssistant.id && !session.background);
  }, [sessionList, currentAssistant]);


  const handleSelectAssistant = (assistant?: AssistantConfig) => {
    if (!assistant) return;
    setSelectedAssistant(assistant.id, assistant.skillNames ?? [], assistant.provider, assistant.model, assistant.persona, assistant.skillTags ?? []);
    // 切换助理时从 localStorage 恢复该助理的工作区（没有则清空）
    const savedCwd = loadAssistantCwdLocal(assistant.id);
    setCwd(savedCwd);
    // 自动定位到该助理最新的一个非后台会话（sessionList 已按 updatedAt 降序排列）
    const latestSession = sessionList.find((s) => s.assistantId === assistant.id && !s.background);
    setActiveSessionId(latestSession?.id ?? null);
    // 切换助理时自动折叠历史任务面板
    if (taskPanelVisible) {
      onToggleTaskPanel();
    }
    // 若该助理没有保存工作区，提示用户先选择工作区
    if (!savedCwd) {
      onNoWorkspace?.();
    }
  };

  const getAssistantInitial = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return "?";
    return trimmed.slice(0, 1).toUpperCase();
  };

  return (
    <aside
      className={`fixed left-0 bottom-0 flex flex-col border-r border-ink-900/5 bg-[#FAF9F6] pb-4 overflow-hidden ${titleBarHeight > 0 ? "pt-2" : "pt-12"}`}
      style={{ top: `${titleBarHeight}px`, width: `${effectiveWidth}px`, transition: "width 0.2s ease, top 0.15s ease" }}
    >
      {titleBarHeight === 0 && (
        <div
          className="absolute top-0 left-0 right-0 h-12"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className="flex shrink-0 flex-col border-r border-ink-900/5 pb-3 overflow-hidden"
          style={{ width: `${ASSISTANT_PANEL_WIDTH}px` }}
        >
          {/* Assistant list */}
          <div className="flex flex-col gap-1 px-2">
            {assistants.length === 0 && (
              <div className="mt-3 text-[10px] text-muted text-center">No AI</div>
            )}
            {assistants.map((assistant) => {
              const selected = currentAssistant?.id === assistant.id;
              return (
                <div
                  key={assistant.id}
                  className={`group relative flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-all ${
                    selected
                      ? "bg-accent/10 text-accent cursor-default"
                      : "text-ink-700 hover:bg-ink-900/5 cursor-pointer"
                  }`}
                  onClick={() => handleSelectAssistant(assistant)}
                >
                  {assistant.avatar ? (
                    <img
                      src={assistant.avatar}
                      alt={assistant.name}
                      className={`h-8 w-8 shrink-0 rounded-full object-cover border ${
                        selected ? "border-accent/30" : "border-ink-900/10"
                      }`}
                    />
                  ) : (
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
                      selected
                        ? "border-accent/30 bg-accent/15 text-accent"
                        : "border-ink-900/10 bg-surface text-ink-600"
                    }`}>
                      {getAssistantInitial(assistant.name)}
                    </span>
                  )}
                  <span className="truncate text-[12px] font-medium leading-snug flex-1 min-w-0">
                    {assistant.name}
                  </span>
                  {selected && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTaskPanel();
                      }}
                      className={`shrink-0 rounded-md p-1 cursor-pointer transition-opacity ${
                        taskPanelVisible
                          ? "text-accent opacity-100"
                          : "opacity-0 group-hover:opacity-100 text-muted hover:text-ink-700"
                      }`}
                      title="历史任务"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 3" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-auto border-t border-ink-900/5 pt-2 grid gap-1 px-2">
            <button
              onClick={() => setShowAssistantManager(true)}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span className="text-[11px] font-medium">团队管理</span>
            </button>
            <button
              onClick={() => onOpenKnowledge?.()}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <path d="M12 11v6M9 14h6" />
              </svg>
              <span className="text-[11px] font-medium">经验</span>
            </button>
            <button
              onClick={() => onOpenSop?.()}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 17H7A5 5 0 017 7h2" />
                <path d="M15 7h2a5 5 0 010 10h-2" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              <span className="text-[11px] font-medium">SOP</span>
            </button>
            <button
              onClick={() => setShowScheduler(true)}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
              <span className="text-[11px] font-medium">日历</span>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-muted transition-colors hover:bg-surface-tertiary hover:text-ink-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span className="text-[11px] font-medium">设置</span>
            </button>
          </div>
        </div>

        {taskPanelVisible && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2.5 min-w-[200px]">
          <div className="pb-2 pt-0.5">
            <div className="truncate px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-light">
              历史任务
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 gap-0.5 pt-1 pr-1">
            {filteredSessions.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-900/5">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                    <path d="M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </div>
                <p className="text-xs text-muted">暂无任务</p>
              </div>
            )}

            {filteredSessions.map((session) => {
              const isActive = activeSessionId === session.id;
              const isRunning = session.status === "running";
              const isError = session.status === "error";
              const isCompleted = session.status === "completed";
              return (
              <div
                key={session.id}
                className={`group relative cursor-pointer rounded-xl px-3 py-2.5 text-left transition-all ${
                  isActive
                    ? "bg-accent/8 shadow-[inset_0_0_0_1px_rgba(44,95,47,0.12)]"
                    : "hover:bg-ink-900/4"
                }`}
                onClick={() => setActiveSessionId(session.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveSessionId(session.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="flex items-start gap-2">
                  {/* 状态指示点 */}
                  <div className="mt-1 flex-shrink-0">
                    {isRunning ? (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-info" />
                      </span>
                    ) : (
                      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${
                        isActive ? "bg-accent" : isCompleted ? "bg-success/60" : isError ? "bg-error/60" : "bg-ink-900/15"
                      }`} />
                    )}
                  </div>

                  {/* 内容 */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-[12.5px] font-medium leading-snug ${
                      isRunning ? "text-info" : isError ? "text-error" : isActive ? "text-ink-900" : "text-ink-700"
                    }`}>
                      {session.title || "未命名任务"}
                    </span>
                    {session.cwd && (
                      <span className="mt-0.5 truncate text-[10.5px] text-muted-light">
                        {formatCwd(session.cwd)}
                      </span>
                    )}
                  </div>

                  {/* 菜单按钮：默认隐藏，hover/active 时显示 */}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        className={`flex-shrink-0 rounded-lg p-1 transition-all ${
                          isActive
                            ? "text-ink-400 hover:bg-ink-900/8 hover:text-ink-600"
                            : "text-transparent group-hover:text-ink-400 hover:bg-ink-900/8 hover:text-ink-600"
                        }`}
                        aria-label="Open session menu"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                          <circle cx="5" cy="12" r="1.6" />
                          <circle cx="12" cy="12" r="1.6" />
                          <circle cx="19" cy="12" r="1.6" />
                        </svg>
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="z-50 min-w-[200px] rounded-xl border border-ink-900/8 bg-white p-1 shadow-elevated" align="end" sideOffset={4}>
                        <DropdownMenu.Item className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-700 outline-none hover:bg-ink-900/5" onSelect={() => onDeleteSession(session.id)}>
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-error/70" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M7 7l1 12a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9l1-12" />
                          </svg>
                          删除任务
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            );})}

          </div>
        </div>
        )}
      </div>

      <SettingsModal open={showSettings} onOpenChange={setShowSettings} onShowSplash={onShowSplash} />

      <AssistantManagerModal
        open={showAssistantManager}
        onOpenChange={setShowAssistantManager}
        onAssistantsChanged={loadAssistants}
        onOpenSkill={onOpenSkill}
        onOpenMcp={onOpenMcp}
      />

      <SchedulerModal open={showScheduler} onOpenChange={setShowScheduler} />

      {taskPanelVisible && (
        <div
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-accent/20"
          onMouseDown={onResizeStart}
        />
      )}
    </aside>
  );
}
