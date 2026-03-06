import { useState, useEffect, useCallback, useMemo, useRef } from "react";

interface PlanTablePageProps {
  onClose: () => void;
  onBack?: () => void;
  onNavigateToSession?: (sessionId: string, assistantId: string) => void;
  titleBarHeight?: number;
  initialSopName?: string;
}

type ColumnConfig = {
  key: PlanItemStatus;
  label: string;
  icon: string;
  dotColor: string;
};

const COLUMNS: ColumnConfig[] = [
  { key: "pending",       label: "待执行",  icon: "○", dotColor: "#9CA3AF" },
  { key: "in_progress",   label: "进行中",  icon: "●", dotColor: "#3B82F6" },
  { key: "human_review",  label: "待审核",  icon: "◎", dotColor: "#F59E0B" },
  { key: "completed",     label: "已完成",  icon: "✓", dotColor: "#16A34A" },
  { key: "failed",        label: "失败",    icon: "✗", dotColor: "#DC2626" },
];

const SOP_COLORS = [
  "#6366F1", "#3B82F6", "#0D9488", "#D97706", "#E11D48",
  "#7C3AED", "#059669", "#CA8A04", "#DC2626", "#2563EB",
];

const CATEGORY_OPTIONS: Exclude<WorkCategory, "">[] = ["客户服务", "情报监控", "内部运营", "增长销售"];

function sopColor(sopName: string): string {
  let hash = 0;
  for (let i = 0; i < sopName.length; i++) hash = ((hash << 5) - hash + sopName.charCodeAt(i)) | 0;
  return SOP_COLORS[Math.abs(hash) % SOP_COLORS.length];
}

function isOverdue(item: PlanItem): boolean {
  if (item.status !== "pending") return false;
  return new Date(item.scheduledTime).getTime() < Date.now();
}

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
    if (diffMs < 0) return formatTime(iso);
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

function formatAbsoluteTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

// ═══ Types ═══

type ViewMode = "dashboard" | "sop-detail" | "today";
type SopSummary = {
  sopName: string;
  category: WorkCategory;
  items: PlanItem[];
  total: number;
  failed: number;
  overdue: number;
  completed: number;
  inProgress: number;
  pending: number;
  lastActivity: string | null;
  nextScheduled: string | null;
  status: "failed" | "overdue" | "normal" | "pending";
};

// ═══ Reusable segment control ═══

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`rounded-lg px-3 py-1 text-[11px] font-medium transition-all ${
            value === opt.key
              ? "bg-accent/10 text-accent border border-accent/15"
              : "text-muted hover:text-ink-700 border border-transparent"
          }`}
        >
          {opt.label}
          {opt.count !== undefined && opt.count > 0 && (
            <span className="ml-1 text-[10px] opacity-70">{opt.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ═══ Status icon for detail view ═══

// ═══ Kanban components ═══

function PlanCard({
  item,
  assistant,
  showTarget,
  onRetry,
  onRunNow,
  onNavigate,
}: {
  item: PlanItem;
  assistant?: AssistantConfig;
  showTarget?: boolean;
  onRetry: (id: string) => void;
  onRunNow: (id: string) => void;
  onNavigate?: (sessionId: string, assistantId: string) => void;
}) {
  const clickable = !!item.sessionId && !!onNavigate;
  const color = sopColor(item.sopName || "未分类");
  const overdue = isOverdue(item);

  return (
    <div
      className={`group rounded-xl border bg-surface p-3 transition-all ${
        overdue
          ? "border-amber-400/60 bg-amber-50/30"
          : clickable
          ? "border-ink-900/8 cursor-pointer hover:border-accent/30 hover:shadow-md"
          : "border-ink-900/8 hover:border-ink-900/15"
      }`}
      onClick={() => {
        if (clickable) onNavigate!(item.sessionId!, item.assistantId);
      }}
    >
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        {item.sopName && (
          <span
            className="inline-block rounded-md px-1.5 py-[2px] text-[10px] font-medium"
            style={{ backgroundColor: `${color}15`, color }}
          >
            {item.sopName}
          </span>
        )}
        {showTarget && item.targetName && (
          <span className="inline-block rounded-md px-1.5 py-[2px] text-[10px] font-medium bg-accent/8 text-accent">
            {item.targetName}
          </span>
        )}
        {overdue && (
          <span className="inline-block rounded-md px-1.5 py-[2px] text-[10px] font-medium bg-amber-100 text-amber-700">
            逾期
          </span>
        )}
        {item.scheduledTaskId && (
          <span
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-[2px] text-[10px] font-medium bg-violet-100/70 text-violet-600"
            title="由定时任务触发"
          >
            <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 shrink-0" fill="currentColor">
              <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-3.5a.75.75 0 0 1 .75.75v3.19l1.53 1.53a.75.75 0 0 1-1.06 1.06l-1.75-1.75A.75.75 0 0 1 7.25 9V5.25A.75.75 0 0 1 8 4.5Z"/>
            </svg>
            定时
          </span>
        )}
      </div>

      <p className="text-[12px] font-medium text-ink-800 leading-snug line-clamp-2 mb-2">
        {item.content}
      </p>

      {item.result && (
        <p className="text-[10px] text-muted leading-snug line-clamp-2 mb-2 pl-2 border-l-2 border-ink-900/8">
          {item.result}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 mt-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {assistant?.avatar ? (
            <img src={assistant.avatar} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover border border-ink-900/10" />
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ink-900/10 bg-surface-tertiary text-[8px] font-semibold text-ink-600">
              {assistant?.name?.slice(0, 1).toUpperCase() ?? "?"}
            </span>
          )}
          <span className="text-[10px] text-muted truncate">{assistant?.name ?? item.assistantId}</span>
        </div>
        <span
          className={`text-[10px] shrink-0 ${overdue ? "text-amber-600 font-medium" : "text-muted/70"}`}
          title={item.scheduledTime}
        >
          {item.status === "pending" ? formatScheduledTime(item.scheduledTime) : formatTime(item.updatedAt)}
        </span>
      </div>

      <div
        className="flex items-center gap-1 mt-2 pt-2 border-t border-ink-900/5 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {item.status === "pending" && (
          <button
            onClick={() => onRunNow(item.id)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            立即执行
          </button>
        )}
        {item.status === "failed" && (
          <button
            onClick={() => onRetry(item.id)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-amber-600 hover:bg-amber-500/10 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 4v6h6" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            重试
          </button>
        )}
        {clickable && (
          <button
            onClick={() => onNavigate!(item.sessionId!, item.assistantId)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-ink-900/5 hover:text-ink-700 transition-colors ml-auto"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            会话
          </button>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({
  id,
  config,
  items,
  assistants,
  showTarget,
  onRetry,
  onRunNow,
  onNavigate,
}: {
  id?: string;
  config: ColumnConfig;
  items: PlanItem[];
  assistants: AssistantConfig[];
  showTarget?: boolean;
  onRetry: (id: string) => void;
  onRunNow: (id: string) => void;
  onNavigate?: (sessionId: string, assistantId: string) => void;
}) {
  const getAssistant = (id: string) => assistants.find((a) => a.id === id);

  return (
    <div id={id} className="flex flex-col min-w-[260px] max-w-[320px] flex-1 rounded-2xl border border-ink-900/8 bg-surface-cream/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-900/5 shrink-0">
        <span className="text-[12px] font-bold" style={{ color: config.dotColor }}>
          {config.icon}
        </span>
        <span className="text-[13px] font-semibold text-ink-800">{config.label}</span>
        <span className="rounded-full bg-ink-900/6 px-2 py-0.5 text-[11px] font-medium text-muted ml-1">
          {items.length}
        </span>
      </div>

      <div
        className="flex-1 overflow-y-auto p-2 flex flex-col gap-2"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
      >
        {items.length > 0 ? (
          items.map((item) => (
            <PlanCard
              key={item.id}
              item={item}
              assistant={getAssistant(item.assistantId)}
              showTarget={showTarget}
              onRetry={onRetry}
              onRunNow={onRunNow}
              onNavigate={onNavigate}
            />
          ))
        ) : (
          <div className="flex items-center justify-center py-8 text-[11px] text-muted/50 italic">
            暂无项目
          </div>
        )}
      </div>
    </div>
  );
}


// ═══ Main Component ═══

export function PlanTablePage({ onClose, onBack, onNavigateToSession, titleBarHeight = 0, initialSopName }: PlanTablePageProps) {
  const [items, setItems] = useState<PlanItem[]>([]);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const [viewMode, setViewMode] = useState<ViewMode>(initialSopName ? "sop-detail" : "dashboard");
  const [categoryFilter, setCategoryFilter] = useState<WorkCategory | "all">("all");
  const [selectedSopName, setSelectedSopName] = useState<string | null>(initialSopName ?? null);
  const [detailTargetFilter, setDetailTargetFilter] = useState<string | null>(null);

  // Scroll container refs for kanban views — used to auto-scroll to first non-empty column
  const sopKanbanScrollRef = useRef<HTMLDivElement>(null);
  const todayKanbanScrollRef = useRef<HTMLDivElement>(null);

  // ═══ Data fetching ═══

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
    const unsub = window.electron.onPlanItemsChanged(() => { fetchItems(); });
    return unsub;
  }, [fetchItems]);

  // ═══ SOP Summaries ═══

  const sopSummaries = useMemo<SopSummary[]>(() => {
    const map = new Map<string, PlanItem[]>();
    for (const item of items) {
      const name = item.sopName || "未分类";
      if (!map.has(name)) map.set(name, []);
      map.get(name)!.push(item);
    }
    const result: SopSummary[] = [];
    for (const [name, sopItems] of map) {
      const failed = sopItems.filter((i) => i.status === "failed").length;
      const overdueCount = sopItems.filter(isOverdue).length;
      const completed = sopItems.filter((i) => i.status === "completed").length;
      const inProgress = sopItems.filter((i) => i.status === "in_progress").length;
      const pending = sopItems.filter((i) => i.status === "pending").length;
      const category = (sopItems.find((i) => i.category)?.category || "") as WorkCategory;

      const activityItems = sopItems.filter((i) => i.status !== "pending");
      const lastActivity = activityItems.length > 0
        ? activityItems.reduce((latest, i) => {
            const t = new Date(i.updatedAt).getTime();
            return t > new Date(latest).getTime() ? i.updatedAt : latest;
          }, activityItems[0].updatedAt)
        : null;

      const pendingItems = sopItems
        .filter((i) => i.status === "pending")
        .sort((a, b) => new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime());
      const nextScheduled = pendingItems[0]?.scheduledTime ?? null;

      let status: SopSummary["status"] = "normal";
      if (failed > 0) status = "failed";
      else if (overdueCount > 0) status = "overdue";
      else if (completed === 0 && inProgress === 0) status = "pending";

      result.push({
        sopName: name, category, items: sopItems,
        total: sopItems.length, failed, overdue: overdueCount, completed, inProgress, pending,
        lastActivity, nextScheduled, status,
      });
    }

    result.sort((a, b) => {
      const statusOrder = { failed: 0, overdue: 1, normal: 2, pending: 3 };
      if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
    return result;
  }, [items]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sopSummaries) {
      const cat = s.category || "";
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return counts;
  }, [sopSummaries]);

  const filteredSopSummaries = useMemo(() => {
    if (categoryFilter === "all") return sopSummaries;
    return sopSummaries.filter((s) => s.category === categoryFilter);
  }, [sopSummaries, categoryFilter]);

  const dashboardStats = useMemo(() => {
    const totalSops = sopSummaries.length;
    const runningSops = sopSummaries.filter((s) => s.inProgress > 0).length;
    const totalItems = items.length;
    const failedItems = items.filter((i) => i.status === "failed").length;
    const overdueItems = items.filter(isOverdue).length;
    const attentionCount = failedItems + overdueItems;
    const completedItems = items.filter((i) => i.status === "completed").length;
    return { totalSops, runningSops, totalItems, failedItems, overdueItems, attentionCount, completedItems };
  }, [items, sopSummaries]);

  // ═══ Today items ═══

  const todayItems = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86400000);
    return items.filter((item) => {
      if (item.status === "completed" || item.status === "failed") {
        const updated = new Date(item.updatedAt);
        return updated >= todayStart && updated < todayEnd;
      }
      if (item.status === "pending") {
        const scheduled = new Date(item.scheduledTime);
        return scheduled < todayEnd;
      }
      return item.status === "in_progress" || item.status === "human_review";
    });
  }, [items]);

  const todayByStatus = useMemo(() => {
    const map: Record<string, PlanItem[]> = {};
    for (const col of COLUMNS) map[col.key] = [];
    for (const item of todayItems) {
      (map[item.status] ??= []).push(item);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const ao = isOverdue(a) ? 0 : 1;
        const bo = isOverdue(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    }
    return map;
  }, [todayItems]);

  // ═══ SOP Detail data ═══

  const selectedSopSummary = useMemo(
    () => sopSummaries.find((s) => s.sopName === selectedSopName) ?? null,
    [sopSummaries, selectedSopName],
  );

  const detailTargetNames = useMemo(() => {
    if (!selectedSopSummary) return [];
    const names = new Set<string>();
    for (const item of selectedSopSummary.items) {
      const name = item.targetName;
      if (name) names.add(name);
    }
    return Array.from(names).sort();
  }, [selectedSopSummary]);

  const sopKanbanByStatus = useMemo(() => {
    if (!selectedSopSummary) return {} as Record<string, PlanItem[]>;
    let source = [...selectedSopSummary.items];
    if (detailTargetFilter) {
      source = source.filter((i) => i.targetName === detailTargetFilter);
    }
    const map: Record<string, PlanItem[]> = {};
    for (const col of COLUMNS) map[col.key] = [];
    for (const item of source) {
      (map[item.status] ??= []).push(item);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const ao = isOverdue(a) ? 0 : 1;
        const bo = isOverdue(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    }
    return map;
  }, [selectedSopSummary, detailTargetFilter]);

  // ═══ Auto-scroll to first non-empty column ═══

  useEffect(() => {
    const scrollRef = viewMode === "sop-detail" ? sopKanbanScrollRef : viewMode === "today" ? todayKanbanScrollRef : null;
    if (!scrollRef?.current) return;
    const byStatus = viewMode === "sop-detail" ? sopKanbanByStatus : todayByStatus;
    const firstNonEmpty = COLUMNS.find((col) => (byStatus[col.key]?.length ?? 0) > 0);
    if (!firstNonEmpty) return;
    const target = scrollRef.current.querySelector<HTMLElement>(`#kanban-col-${firstNonEmpty.key}`);
    if (target) {
      // Small delay to ensure layout is complete before scrolling
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
      });
    }
  }, [viewMode, sopKanbanByStatus, todayByStatus]);

  // ═══ Handlers ═══

  const handleRetry = async (id: string) => {
    try { await window.electron.retryPlanItem(id); } catch (err) { console.error("[PlanTable] Retry failed:", err); }
  };
  const handleRunNow = async (id: string) => {
    try { await window.electron.runPlanItemNow(id); } catch (err) { console.error("[PlanTable] RunNow failed:", err); }
  };

  const openSopDetail = (name: string) => {
    setSelectedSopName(name);
    setDetailTargetFilter(null);
    setViewMode("sop-detail");
  };

  const backToDashboard = () => {
    setViewMode("dashboard");
    setSelectedSopName(null);
    setDetailTargetFilter(null);
  };

  // ═══ Header title logic ═══

  let headerTitle = "Dashboard";
  let headerBack = onBack ?? onClose;
  let headerBackLabel = "返回";
  let headerRight: React.ReactNode = null;

  if (viewMode === "sop-detail" && selectedSopSummary) {
    headerTitle = selectedSopSummary.sopName;
    headerBack = backToDashboard;
    headerBackLabel = "返回";
    const failedCount = selectedSopSummary.failed;
    const overdueCount = selectedSopSummary.overdue;
    const shownTotal = detailTargetFilter
      ? selectedSopSummary.items.filter((i) => i.targetName === detailTargetFilter).length
      : selectedSopSummary.total;
    headerRight = (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted">{shownTotal} 项</span>
        {failedCount > 0 && <span className="text-error font-medium">{failedCount} 失败</span>}
        {overdueCount > 0 && !failedCount && <span className="text-amber-600 font-medium">{overdueCount} 逾期</span>}
      </div>
    );
  } else if (viewMode === "today") {
    headerTitle = "今日";
    headerBack = backToDashboard;
    headerBackLabel = "返回";
    headerRight = <span className="text-[11px] text-muted">{todayItems.length} 项</span>;
  } else {
    headerRight = (
      <div className="flex items-center gap-2">
        {todayItems.length > 0 && (
          <button
            onClick={() => setViewMode("today")}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-muted hover:text-ink-700 hover:bg-surface-secondary transition-all"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            今日
            <span className={`rounded-full px-1.5 py-px text-[9px] font-semibold ${
              todayItems.some(isOverdue) ? "bg-amber-100 text-amber-700" : "bg-ink-900/6 text-muted"
            }`}>
              {todayItems.length}
            </span>
          </button>
        )}
        <span className="text-[11px] text-muted">{items.length} 项</span>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-surface-cream"
      style={{ top: `${titleBarHeight}px` }}
    >
      {/* ═══ Header ═══ */}
      <header
        className="flex items-center h-12 border-b border-ink-900/10 bg-surface-cream shrink-0 select-none"
        style={{
          paddingLeft: titleBarHeight === 0 ? "80px" : "24px",
          paddingRight: "24px",
          ...(titleBarHeight === 0 && { WebkitAppRegion: "drag" } as React.CSSProperties),
        }}
      >
        <div
          className="flex-1 flex items-center"
          style={titleBarHeight === 0 ? { WebkitAppRegion: "no-drag" } as React.CSSProperties : undefined}
        >
          <button
            onClick={headerBack}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-ink-700 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            {headerBackLabel}
          </button>
        </div>

        <span className="text-sm font-semibold text-ink-800 tracking-tight">{headerTitle}</span>

        <div
          className="flex-1 flex items-center justify-end"
          style={titleBarHeight === 0 ? { WebkitAppRegion: "no-drag" } as React.CSSProperties : undefined}
        >
          {headerRight}
        </div>
      </header>

      {/* ═══ Content ═══ */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center w-full py-24">
            <svg className="h-5 w-5 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center w-full py-24 gap-4">
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

        ) : viewMode === "dashboard" ? (
          /* ═══ Dashboard View ═══ */
          <div className="p-6 max-w-2xl mx-auto">
            {/* Category segment control */}
            <div className="mb-4">
              <SegmentControl
                options={[
                  { key: "all" as const, label: "全部", count: sopSummaries.length },
                  ...CATEGORY_OPTIONS.map((c) => ({
                    key: c,
                    label: c,
                    count: categoryCounts.get(c) ?? 0,
                  })),
                ]}
                value={categoryFilter}
                onChange={setCategoryFilter}
              />
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-2xl border border-ink-900/8 bg-surface shadow-soft p-3.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-2xl font-bold text-ink-800">{dashboardStats.totalSops}</span>
                  <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-muted/40" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="7" height="7" rx="1.5" />
                    <rect x="14" y="3" width="7" height="7" rx="1.5" />
                    <rect x="3" y="14" width="7" height="7" rx="1.5" />
                    <rect x="14" y="14" width="7" height="7" rx="1.5" />
                  </svg>
                </div>
                <div className="text-[11px] text-muted">SOP 流程</div>
                {dashboardStats.runningSops > 0 && (
                  <div className="text-[10px] text-info mt-0.5">{dashboardStats.runningSops} 个执行中</div>
                )}
              </div>

              <div className="rounded-2xl border border-ink-900/8 bg-surface shadow-soft p-3.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-2xl font-bold text-ink-800">{todayItems.length}</span>
                  <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-muted/40" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </div>
                <div className="text-[11px] text-muted">今日任务</div>
                <div className="text-[10px] text-muted/70 mt-0.5">
                  共 {dashboardStats.totalItems} 项，{dashboardStats.completedItems} 已完成
                </div>
              </div>

              <div className={`rounded-2xl border shadow-soft p-3.5 ${
                dashboardStats.attentionCount > 0
                  ? "border-error/20 bg-red-50/30"
                  : "border-ink-900/8 bg-surface"
              }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-2xl font-bold ${dashboardStats.attentionCount > 0 ? "text-error" : "text-ink-800"}`}>
                    {dashboardStats.attentionCount}
                  </span>
                  <svg viewBox="0 0 24 24" className={`h-4.5 w-4.5 ${dashboardStats.attentionCount > 0 ? "text-error/40" : "text-muted/40"}`} fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div className="text-[11px] text-muted">需关注</div>
                {dashboardStats.attentionCount > 0 && (
                  <div className="text-[10px] mt-0.5">
                    {dashboardStats.failedItems > 0 && <span className="text-error">{dashboardStats.failedItems} 失败</span>}
                    {dashboardStats.failedItems > 0 && dashboardStats.overdueItems > 0 && <span className="text-muted mx-1">·</span>}
                    {dashboardStats.overdueItems > 0 && <span className="text-amber-600">{dashboardStats.overdueItems} 逾期</span>}
                  </div>
                )}
              </div>
            </div>

            {/* SOP cards grid */}
            <div className="grid grid-cols-2 gap-3">
              {filteredSopSummaries.map((sop) => {
                const color = sopColor(sop.sopName);
                let statusBadge: React.ReactNode;
                if (sop.status === "failed") {
                  statusBadge = <span className="rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-error/10 text-error">{sop.failed} 失败</span>;
                } else if (sop.status === "overdue") {
                  statusBadge = <span className="rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-600">{sop.overdue} 逾期</span>;
                } else if (sop.status === "pending") {
                  statusBadge = <span className="rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-ink-900/5 text-muted">待执行</span>;
                } else {
                  statusBadge = <span className="rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-success/10 text-success">正常</span>;
                }

                const timeLabel = sop.lastActivity
                  ? `最近 ${formatAbsoluteTime(sop.lastActivity)}`
                  : sop.nextScheduled
                  ? `下次 ${formatAbsoluteTime(sop.nextScheduled)}`
                  : "";

                return (
                  <button
                    key={sop.sopName}
                    onClick={() => openSopDetail(sop.sopName)}
                    className={`rounded-2xl border p-4 text-left transition-all hover:border-accent/30 hover:shadow-md cursor-pointer shadow-soft ${
                      sop.status === "failed"
                        ? "border-error/20 bg-red-50/20"
                        : sop.status === "overdue"
                        ? "border-amber-400/20 bg-amber-50/20"
                        : "border-ink-900/8 bg-surface"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="text-[13px] font-semibold text-ink-800 truncate">{sop.sopName}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      {statusBadge}
                      <span className="text-[11px] text-muted">{sop.total} 项</span>
                    </div>
                    {timeLabel && (
                      <div className="text-[11px] text-muted/70">{timeLabel}</div>
                    )}
                  </button>
                );
              })}
            </div>

            {filteredSopSummaries.length === 0 && categoryFilter !== "all" && (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <p className="text-sm text-muted">该分类下暂无 SOP</p>
              </div>
            )}
          </div>

        ) : viewMode === "sop-detail" && selectedSopSummary ? (
          /* ═══ SOP Kanban View ═══ */
          <div className="flex flex-col h-full">
            {/* Target filter bar */}
            {detailTargetNames.length >= 2 && (
              <div className="shrink-0 px-4 pt-3 pb-2 border-b border-ink-900/6">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setDetailTargetFilter(null)}
                    className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition-all ${
                      detailTargetFilter === null
                        ? "bg-ink-900/8 text-ink-800"
                        : "text-muted hover:text-ink-700 hover:bg-ink-900/5"
                    }`}
                  >
                    全部目标
                  </button>
                  {detailTargetNames.map((name) => (
                    <button
                      key={name}
                      onClick={() => setDetailTargetFilter(name === detailTargetFilter ? null : name)}
                      className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition-all truncate max-w-[160px] ${
                        detailTargetFilter === name
                          ? "bg-accent/10 text-accent"
                          : "text-muted hover:text-ink-700 hover:bg-ink-900/5"
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Kanban columns */}
            <div ref={sopKanbanScrollRef} className="flex gap-3 p-4 flex-1 min-h-0 overflow-x-auto">
              {Object.values(sopKanbanByStatus).every((arr) => arr.length === 0) ? (
                <div className="flex flex-col items-center justify-center w-full py-24 gap-2">
                  <p className="text-sm text-muted">无匹配的任务</p>
                </div>
              ) : (
                COLUMNS.map((col) => (
                  <KanbanColumn
                    key={col.key}
                    id={`kanban-col-${col.key}`}
                    config={col}
                    items={sopKanbanByStatus[col.key] ?? []}
                    assistants={assistants}
                    showTarget={detailTargetNames.length >= 2 && !detailTargetFilter}
                    onRetry={handleRetry}
                    onRunNow={handleRunNow}
                    onNavigate={onNavigateToSession}
                  />
                ))
              )}
            </div>
          </div>

        ) : viewMode === "today" ? (
          /* ═══ Today View ═══ */
          <div ref={todayKanbanScrollRef} className="flex gap-3 p-4 min-h-full overflow-x-auto">
            {todayItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center w-full py-24 gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                  <svg viewBox="0 0 24 24" className="h-5 w-5 text-success" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-ink-700">今日无待办</p>
                <p className="text-xs text-muted">所有计划项已就绪</p>
              </div>
            ) : (
              COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.key}
                  id={`kanban-col-${col.key}`}
                  config={col}
                  items={todayByStatus[col.key] ?? []}
                  assistants={assistants}
                  showTarget
                  onRetry={handleRetry}
                  onRunNow={handleRunNow}
                  onNavigate={onNavigateToSession}
                />
              ))
            )}
          </div>

        ) : null}
      </div>
    </div>
  );
}
