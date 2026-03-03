import { useState, useEffect, useCallback, useMemo } from "react";

interface PlanTablePageProps {
  onClose: () => void;
  onBack?: () => void;
  onNavigateToSession?: (sessionId: string, assistantId: string) => void;
  titleBarHeight?: number;
}

type FilterStatus = "all" | PlanItemStatus;

const STATUS_CONFIG: Record<PlanItemStatus, { label: string; bg: string; text: string; icon: string }> = {
  pending: { label: "待执行", bg: "bg-ink-900/8", text: "text-ink-500", icon: "⏳" },
  in_progress: { label: "进行中", bg: "bg-info/10", text: "text-info", icon: "🔄" },
  completed: { label: "已完成", bg: "bg-success/10", text: "text-success", icon: "✅" },
  failed: { label: "失败", bg: "bg-error/10", text: "text-error", icon: "❌" },
};

const FILTER_TABS: { key: FilterStatus; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待执行" },
  { key: "in_progress", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
];

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}小时前`;
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return iso;
  }
}

function formatScheduledTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs < 0) {
      return formatTime(iso);
    }
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}分钟后`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}小时后`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}天后`;
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return iso;
  }
}

type SopGroup = {
  sopName: string;
  items: PlanItem[];
  completedCount: number;
};

export function PlanTablePage({ onClose, onBack, onNavigateToSession, titleBarHeight = 0 }: PlanTablePageProps) {
  const [items, setItems] = useState<PlanItem[]>([]);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    try {
      const data = await window.electron.getPlanItems();
      setItems(data);
    } catch (err) {
      console.error("[PlanTable] Failed to fetch:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
    window.electron.getAssistantsConfig().then((c) => setAssistants(c.assistants ?? [])).catch(console.error);
  }, [fetchItems]);

  useEffect(() => {
    const unsub = window.electron.onPlanItemsChanged(() => {
      fetchItems();
    });
    return unsub;
  }, [fetchItems]);

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => i.status === filter);
  }, [items, filter]);

  const groups = useMemo<SopGroup[]>(() => {
    const map = new Map<string, PlanItem[]>();
    for (const item of filteredItems) {
      const key = item.sopName || "未分类";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const result: SopGroup[] = [];
    for (const [sopName, groupItems] of map) {
      groupItems.sort((a, b) => new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime());
      result.push({
        sopName,
        items: groupItems,
        completedCount: groupItems.filter((i) => i.status === "completed").length,
      });
    }
    result.sort((a, b) => {
      const aLatest = a.items[a.items.length - 1]?.updatedAt ?? "";
      const bLatest = b.items[b.items.length - 1]?.updatedAt ?? "";
      return bLatest.localeCompare(aLatest);
    });
    return result;
  }, [filteredItems]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const item of items) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const toggleGroup = (sopName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sopName)) next.delete(sopName);
      else next.add(sopName);
      return next;
    });
  };

  const getAssistant = useCallback(
    (id: string) => assistants.find((a) => a.id === id),
    [assistants],
  );

  const handleRetry = async (id: string) => {
    try {
      await window.electron.retryPlanItem(id);
    } catch (err) {
      console.error("[PlanTable] Retry failed:", err);
    }
  };

  const handleRunNow = async (id: string) => {
    try {
      await window.electron.runPlanItemNow(id);
    } catch (err) {
      console.error("[PlanTable] RunNow failed:", err);
    }
  };

  const handleRowClick = (item: PlanItem) => {
    if (item.sessionId && onNavigateToSession) {
      onNavigateToSession(item.sessionId, item.assistantId);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-surface-cream"
      style={{ top: `${titleBarHeight}px` }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between h-12 border-b border-ink-900/10 bg-surface-cream shrink-0 select-none"
        style={{
          paddingLeft: titleBarHeight === 0 ? '80px' : '24px',
          paddingRight: '24px',
          ...(titleBarHeight === 0 && { WebkitAppRegion: 'drag' } as React.CSSProperties),
        }}
      >
        <div
          className="flex items-center gap-4"
          style={titleBarHeight === 0 ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          <button
            onClick={onBack ?? onClose}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-ink-700 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
          <div className="h-5 w-px bg-ink-900/10" />
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 3v18" />
            </svg>
            <span className="text-sm font-semibold text-ink-800 tracking-tight">计划表</span>
            <span className="text-xs text-muted">Plan Table</span>
          </div>
        </div>

        {/* Filter tabs */}
        <div
          className="flex items-center gap-1 rounded-xl bg-surface p-1 border border-ink-900/8"
          style={titleBarHeight === 0 ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          {FILTER_TABS.map((tab) => {
            const count = statusCounts[tab.key] ?? 0;
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  active
                    ? "bg-accent/10 text-accent shadow-sm"
                    : "text-muted hover:text-ink-700 hover:bg-surface-secondary"
                }`}
              >
                {tab.label}
                {count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                    active ? "bg-accent/15 text-accent" : "bg-ink-900/5 text-muted-light"
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="w-24" />
      </header>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <svg className="h-5 w-5 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-900/5">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 3v18" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-ink-700">暂无计划</p>
                <p className="text-xs text-muted mt-1">AI 在执行 SOP 时会自动创建计划项</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => {
                const collapsed = collapsedGroups.has(group.sopName);
                return (
                  <div
                    key={group.sopName}
                    className="rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden"
                  >
                    {/* Group header */}
                    <button
                      onClick={() => toggleGroup(group.sopName)}
                      className="flex w-full items-center gap-3 px-5 py-3.5 text-left hover:bg-surface-secondary/50 transition-colors"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className={`h-3.5 w-3.5 text-muted transition-transform ${collapsed ? "" : "rotate-90"}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                      <span className="text-sm font-semibold text-ink-800">{group.sopName}</span>
                      <span className="rounded-full bg-ink-900/5 px-2.5 py-0.5 text-[11px] text-muted">
                        {group.completedCount}/{group.items.length} 已完成
                      </span>
                      {/* Mini progress bar */}
                      <div className="flex-1 max-w-[120px] h-1.5 rounded-full bg-ink-900/5 overflow-hidden ml-2">
                        <div
                          className="h-full rounded-full bg-success/60 transition-all"
                          style={{ width: `${group.items.length > 0 ? (group.completedCount / group.items.length) * 100 : 0}%` }}
                        />
                      </div>
                    </button>

                    {/* Table */}
                    {!collapsed && (
                      <div className="border-t border-ink-900/5">
                        {/* Table header */}
                        <div className="grid grid-cols-[1fr_140px_2fr_120px_100px_80px] gap-2 px-5 py-2.5 border-b border-ink-900/5 bg-surface-cream/50">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">执行助理</span>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">计划时间</span>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">执行内容</span>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">结果</span>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">状态</span>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">操作</span>
                        </div>

                        {/* Table rows */}
                        {group.items.map((item) => {
                          const assistant = getAssistant(item.assistantId);
                          const st = STATUS_CONFIG[item.status];
                          const clickable = !!item.sessionId && !!onNavigateToSession;
                          return (
                            <div
                              key={item.id}
                              className={`group grid grid-cols-[1fr_140px_2fr_120px_100px_80px] gap-2 px-5 py-3 border-b border-ink-900/5 last:border-0 transition-colors ${
                                clickable ? "cursor-pointer hover:bg-accent/4" : "hover:bg-surface-secondary/30"
                              }`}
                              onClick={() => handleRowClick(item)}
                            >
                              {/* Assistant */}
                              <div className="flex items-center gap-2 min-w-0">
                                {assistant?.avatar ? (
                                  <img src={assistant.avatar} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover border border-ink-900/10" />
                                ) : (
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink-900/10 bg-surface-tertiary text-[10px] font-semibold text-ink-600">
                                    {assistant?.name?.slice(0, 1).toUpperCase() ?? "?"}
                                  </span>
                                )}
                                <span className="truncate text-xs text-ink-700">{assistant?.name ?? item.assistantId}</span>
                              </div>

                              {/* Scheduled time */}
                              <div className="flex items-center">
                                <span className="text-xs text-muted" title={item.scheduledTime}>
                                  {item.status === "pending" ? formatScheduledTime(item.scheduledTime) : formatTime(item.scheduledTime)}
                                </span>
                              </div>

                              {/* Content */}
                              <div className="flex items-center min-w-0">
                                <span className="truncate text-xs text-ink-800">{item.content}</span>
                              </div>

                              {/* Result */}
                              <div className="flex items-center min-w-0">
                                <span className="truncate text-[11px] text-muted" title={item.result || undefined}>
                                  {item.result || "—"}
                                </span>
                              </div>

                              {/* Status */}
                              <div className="flex items-center">
                                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${st.bg} ${st.text}`}>
                                  {item.status === "in_progress" && (
                                    <span className="relative flex h-1.5 w-1.5">
                                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75" />
                                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-info" />
                                    </span>
                                  )}
                                  {st.label}
                                </span>
                              </div>

                              {/* Actions */}
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                                {item.status === "pending" && (
                                  <button
                                    onClick={() => handleRunNow(item.id)}
                                    className="rounded-md px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
                                    title="立即执行"
                                  >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                      <polygon points="5 3 19 12 5 21 5 3" />
                                    </svg>
                                  </button>
                                )}
                                {item.status === "failed" && (
                                  <button
                                    onClick={() => handleRetry(item.id)}
                                    className="rounded-md px-2 py-1 text-[10px] font-medium text-amber-600 hover:bg-amber-500/10 transition-colors"
                                    title="重试"
                                  >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M1 4v6h6" />
                                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                    </svg>
                                  </button>
                                )}
                                {clickable && (
                                  <button
                                    onClick={() => handleRowClick(item)}
                                    className="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-ink-900/5 hover:text-ink-700 transition-colors"
                                    title="查看会话"
                                  >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                      <polyline points="15 3 21 3 21 9" />
                                      <line x1="10" y1="14" x2="21" y2="3" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
