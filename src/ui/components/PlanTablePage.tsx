import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { StreamMessage } from "../types";
import { useAppStore, type SessionView } from "../store/useAppStore";

interface PlanTablePageProps {
  onClose: () => void;
  onBack?: () => void;
  onNavigateToSession?: (sessionId: string, assistantId: string) => void;
  titleBarHeight?: number;
  initialSopName?: string;
  initialSopId?: string;
  initialHistoryRunId?: string;
}

type PlanColumnConfig = {
  key: PlanItemStatus;
  label: string;
  icon: string;
  dotColor: string;
};

type StageColumnConfig = {
  key: WorkflowStageStatus;
  label: string;
  icon: string;
  dotColor: string;
};

type StageKanbanItem = {
  id: string;
  label: string;
  index: number;
  status: WorkflowStageStatus;
  assistantId?: string;
  goal: string;
  itemCount: number;
  inputPrompt?: string;
  output?: string;
  abstract: string;
  error?: string;
  sessionId?: string;
  duration?: number;
  startedAt?: string;
  completedAt?: string;
  definitionMissing?: boolean;
};

const PLAN_COLUMNS: PlanColumnConfig[] = [
  { key: "pending",       label: "待执行",  icon: "○", dotColor: "#9CA3AF" },
  { key: "in_progress",   label: "进行中",  icon: "●", dotColor: "#3B82F6" },
  { key: "human_review",  label: "待审核",  icon: "◎", dotColor: "#F59E0B" },
  { key: "completed",     label: "已完成",  icon: "✓", dotColor: "#16A34A" },
  { key: "failed",        label: "失败",    icon: "✗", dotColor: "#DC2626" },
];

const STAGE_COLUMNS: StageColumnConfig[] = [
  { key: "pending",       label: "待执行",  icon: "○", dotColor: "#9CA3AF" },
  { key: "in_progress",   label: "进行中",  icon: "●", dotColor: "#3B82F6" },
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

function formatDuration(duration?: number): string {
  if (!duration || duration <= 0) return "";
  const seconds = Math.floor(duration / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds > 0 ? `${minutes}分${restSeconds}秒` : `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}小时${restMinutes}分` : `${hours}小时`;
}

function formatSnapshotTimestamp(iso?: string): string {
  if (!iso) return "未知时间";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getWorkflowStatusMeta(status?: WorkflowStatus): { label: string; className: string; dotClassName: string } {
  if (status === "completed") {
    return {
      label: "已完成",
      className: "bg-emerald-50 text-emerald-700 border border-emerald-200/70",
      dotClassName: "bg-emerald-500",
    };
  }
  if (status === "failed") {
    return {
      label: "失败",
      className: "bg-red-50 text-red-600 border border-red-200/70",
      dotClassName: "bg-red-500",
    };
  }
  if (status === "running") {
    return {
      label: "进行中",
      className: "bg-blue-50 text-blue-600 border border-blue-200/70",
      dotClassName: "bg-blue-500",
    };
  }
  return {
    label: "未开始",
    className: "bg-ink-900/5 text-muted border border-ink-900/8",
    dotClassName: "bg-ink-300",
  };
}

function normalizeSopMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+hand$/, "");
}

function findMatchingSopDefinition(
  sops: HandSopResult[],
  selectedSopName: string | null,
  selectedSopId?: string | null,
): HandSopResult | null {
  if (selectedSopId) {
    const matchedById = sops.find((sop) => sop.id === selectedSopId);
    if (matchedById) return matchedById;
  }
  if (!selectedSopName) return null;
  const normalized = normalizeSopMatch(selectedSopName);
  return (
    sops.find((sop) => normalizeSopMatch(sop.name) === normalized || normalizeSopMatch(sop.id) === normalized) ??
    sops.find((sop) => {
      const name = normalizeSopMatch(sop.name);
      const id = normalizeSopMatch(sop.id);
      return name.includes(normalized) || normalized.includes(name) || id.includes(normalized);
    }) ??
    null
  );
}

function trimPreviewText(text: string, limit = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeStreamMessage(message: StreamMessage): { role: string; text: string } | null {
  const raw = message as any;
  if (raw.type === "user_prompt") {
    const text = trimPreviewText(String(raw.prompt ?? ""));
    return text ? { role: "用户", text } : null;
  }
  if (raw.type === "skill_loaded") return null;
  if (raw.type === "assistant") {
    const contents: any[] = raw.message?.content ?? [];
    const text = trimPreviewText(
      contents
        .filter((item) => item.type === "text")
        .map((item) => String(item.text ?? ""))
        .join("\n"),
    );
    if (text) return { role: "助手", text };
    const toolNames = contents
      .filter((item) => item.type === "tool_use")
      .map((item) => String(item.name ?? ""))
      .filter(Boolean);
    if (toolNames.length > 0) {
      return { role: "工具", text: trimPreviewText(`调用工具：${toolNames.join(" · ")}`) };
    }
    const thinking = trimPreviewText(
      contents
        .filter((item) => item.type === "thinking")
        .map((item) => String(item.thinking ?? ""))
        .join("\n"),
    );
    return thinking ? { role: "思考", text: thinking } : null;
  }
  if (raw.type === "user") {
    const contents = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const toolResult = trimPreviewText(
      contents
        .map((item: any) => (typeof item !== "string" && item.type === "tool_result" ? extractToolResultText(item.content) : ""))
        .filter(Boolean)
        .join("\n"),
    );
    return toolResult ? { role: "结果", text: toolResult } : null;
  }
  if (raw.type === "result" && raw.subtype === "error") {
    return { role: "错误", text: "会话执行失败" };
  }
  return null;
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
  config: PlanColumnConfig;
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

function StageCard({
  item,
  assistant,
  onExecute,
  onRetry,
  onOpenSessionPreview: _onOpenSessionPreview,
  readOnly = false,
}: {
  item: StageKanbanItem;
  assistant?: AssistantConfig;
  onExecute: (stageId: string) => void;
  onRetry: (stageId: string) => void;
  onOpenSessionPreview?: (stageId: string) => void;
  readOnly?: boolean;
}) {
  const statusMeta = STAGE_COLUMNS.find((col) => col.key === item.status) ?? STAGE_COLUMNS[0];
  const canOpenSessionPreview = !!item.sessionId && !!_onOpenSessionPreview;
  const timeLabel = item.completedAt
    ? formatTime(item.completedAt)
    : item.startedAt
    ? formatTime(item.startedAt)
    : "未开始";
  const assistantLabel = assistant?.name ?? item.assistantId ?? "未分配助理";

  return (
    <div
      className={`group rounded-xl border border-ink-900/8 bg-surface p-3 transition-all ${
        canOpenSessionPreview
          ? "cursor-pointer hover:border-accent/30 hover:shadow-md"
          : "hover:border-ink-900/15"
      }`}
      onClick={() => {
        if (canOpenSessionPreview) _onOpenSessionPreview?.(item.id);
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-ink-900/6 px-1.5 text-[10px] font-semibold text-ink-700">
              {item.index}
            </span>
            <span className="text-[12px] font-semibold text-ink-800 leading-snug">{item.label}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] font-medium"
              style={{ backgroundColor: `${statusMeta.dotColor}15`, color: statusMeta.dotColor }}
            >
              <span>{statusMeta.icon}</span>
              <span>{statusMeta.label}</span>
            </span>
            {item.definitionMissing && (
              <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-[2px] text-[10px] text-amber-700 border border-amber-200/70">
                历史阶段
              </span>
            )}
            {item.itemCount > 0 && (
              <span className="inline-flex items-center rounded-md bg-ink-900/5 px-1.5 py-[2px] text-[10px] text-muted">
                {item.itemCount} 步
              </span>
            )}
          </div>
        </div>
      </div>

      {item.abstract ? (
        <p className="text-[11px] text-ink-700 leading-snug line-clamp-3 mb-2">
          {item.abstract}
        </p>
      ) : item.goal ? (
        <p className="text-[11px] text-muted leading-snug line-clamp-2 mb-2">
          {item.goal}
        </p>
      ) : null}

      {item.error && (
        <p className="text-[10px] text-error leading-snug line-clamp-3 mb-2 pl-2 border-l-2 border-error/30">
          {item.error}
        </p>
      )}

      {item.definitionMissing && (
        <p className="text-[10px] text-amber-700 leading-snug mb-2 rounded-lg bg-amber-50 border border-amber-200/70 px-2 py-1.5">
          当前 SOP 定义中已找不到这个阶段，以下内容来自历史执行快照。
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
          <div className="min-w-0">
            <div className="text-[10px] font-medium text-ink-700 truncate" title={assistantLabel}>
              {assistantLabel}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-muted/70">{timeLabel}</div>
        </div>
      </div>

      {!readOnly && (
        <div
          className="flex items-center gap-1 mt-2 pt-2 border-t border-ink-900/5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {!readOnly && item.status === "pending" && (
            <button
              onClick={() => onExecute(item.id)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              执行此阶段
            </button>
          )}
          {!readOnly && item.status === "failed" && (
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
        </div>
      )}
    </div>
  );
}

function StageKanbanColumn({
  id,
  config,
  items,
  assistants,
  onExecute,
  onRetry,
  onOpenSessionPreview,
  readOnly = false,
}: {
  id?: string;
  config: StageColumnConfig;
  items: StageKanbanItem[];
  assistants: AssistantConfig[];
  onExecute: (stageId: string) => void;
  onRetry: (stageId: string) => void;
  onOpenSessionPreview?: (stageId: string) => void;
  readOnly?: boolean;
}) {
  const getAssistant = (id?: string) => (id ? assistants.find((a) => a.id === id) : undefined);

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
            <StageCard
              key={item.id}
              item={item}
              assistant={getAssistant(item.assistantId)}
              onExecute={onExecute}
              onRetry={onRetry}
              onOpenSessionPreview={onOpenSessionPreview}
              readOnly={readOnly}
            />
          ))
        ) : (
          <div className="flex items-center justify-center py-8 text-[11px] text-muted/50 italic">
            暂无阶段
          </div>
        )}
      </div>
    </div>
  );
}

function SessionPreviewPanel({
  stage,
  session,
  assistant,
  onClose,
  onOpenFullSession,
}: {
  stage: StageKanbanItem;
  session: SessionView | null;
  assistant?: AssistantConfig;
  onClose: () => void;
  onOpenFullSession: () => void;
}) {
  const [expandedSection, setExpandedSection] = useState<"input" | "output" | null>(null);
  const recentMessages = useMemo(
    () => (session?.messages ?? []).map(summarizeStreamMessage).filter(Boolean).slice(-6) as Array<{ role: string; text: string }>,
    [session?.messages],
  );
  const sessionStatusLabel = session?.status === "running"
    ? "进行中"
    : session?.status === "completed"
    ? "已完成"
    : session?.status === "error"
    ? "异常"
    : "待命";
  const sessionStatusColor = session?.status === "running"
    ? "text-info"
    : session?.status === "completed"
    ? "text-success"
    : session?.status === "error"
    ? "text-error"
    : "text-muted";

  return (
    <aside className="w-[360px] shrink-0 border-l border-ink-900/10 bg-surface shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-900/8 shrink-0">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink-800 truncate">当前会话</div>
          <div className="text-[10px] text-muted mt-0.5 truncate">
            {stage.index}. {stage.label}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-muted hover:text-ink-700 p-1 rounded-lg hover:bg-ink-900/5 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="px-4 py-3 border-b border-ink-900/5 shrink-0">
        <div className="text-[12px] font-medium text-ink-800 line-clamp-2">
          {session?.title || `${stage.label} 会话`}
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap text-[10px]">
          <span className={`font-medium ${sessionStatusColor}`}>{sessionStatusLabel}</span>
          <span className="text-muted">·</span>
          <span className="text-muted">{assistant?.name ?? session?.assistantId ?? stage.assistantId ?? "未识别助手"}</span>
          {stage.duration ? (
            <>
              <span className="text-muted">·</span>
              <span className="text-muted">{formatDuration(stage.duration)}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="px-4 py-3 border-b border-ink-900/5 shrink-0">
        <div className="flex items-center gap-2">
          {stage.inputPrompt && (
            <button
              onClick={() => setExpandedSection((prev) => (prev === "input" ? null : "input"))}
              className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                expandedSection === "input" ? "bg-accent/10 text-accent" : "text-muted hover:bg-ink-900/5"
              }`}
            >
              输入
            </button>
          )}
          {stage.output && (
            <button
              onClick={() => setExpandedSection((prev) => (prev === "output" ? null : "output"))}
              className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                expandedSection === "output" ? "bg-accent/10 text-accent" : "text-muted hover:bg-ink-900/5"
              }`}
            >
              输出
            </button>
          )}
        </div>
        {expandedSection && (
          <div className="mt-3 rounded-xl border border-ink-900/8 bg-surface-secondary overflow-hidden">
            <pre
              className="text-[10px] text-ink-700 leading-relaxed p-3 whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto"
              style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
            >
              {expandedSection === "input" ? stage.inputPrompt : stage.output}
            </pre>
          </div>
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
      >
        {(stage.abstract || stage.error) && (
          <div className="rounded-xl border border-ink-900/8 bg-surface-secondary p-3">
            <div className="text-[11px] font-medium text-ink-800 mb-2">阶段摘要</div>
            {stage.abstract && (
              <div className="text-[10px] text-ink-700 whitespace-pre-wrap leading-relaxed">
                {stage.abstract}
              </div>
            )}
            {stage.error && (
              <div className="text-[10px] text-error whitespace-pre-wrap leading-relaxed mt-2">
                {stage.error}
              </div>
            )}
          </div>
        )}

        <div className="rounded-xl border border-ink-900/8 bg-surface p-3">
          <div className="text-[11px] font-medium text-ink-800 mb-2">最近消息</div>
          {recentMessages.length > 0 ? (
            <div className="flex flex-col gap-2">
              {recentMessages.map((message, index) => (
                <div key={`${message.role}-${index}`} className="rounded-lg bg-surface-secondary px-2.5 py-2">
                  <div className="text-[9px] font-medium text-muted mb-1">{message.role}</div>
                  <div className="text-[10px] text-ink-700 leading-relaxed whitespace-pre-wrap break-words">
                    {message.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-muted">会话正在初始化，消息会在执行过程中实时出现。</div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-ink-900/6 shrink-0">
        <button
          onClick={onOpenFullSession}
          className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-accent/20 bg-accent/8 px-3 py-2 text-[11px] font-medium text-accent hover:bg-accent/15 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          打开完整会话
        </button>
      </div>
    </aside>
  );
}


// ═══ Main Component ═══

export function PlanTablePage({
  onClose,
  onBack,
  onNavigateToSession,
  titleBarHeight = 0,
  initialSopName,
  initialSopId,
  initialHistoryRunId,
}: PlanTablePageProps) {
  const sessions = useAppStore((state) => state.sessions);
  const historyRequested = useAppStore((state) => state.historyRequested);
  const markHistoryRequested = useAppStore((state) => state.markHistoryRequested);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [sopList, setSopList] = useState<HandSopResult[]>([]);
  const [sopListLoaded, setSopListLoaded] = useState(false);
  const [workflowRun, setWorkflowRun] = useState<WorkflowRun | null>(null);
  const [stageLoading, setStageLoading] = useState(false);
  const [selectedStagePreviewId, setSelectedStagePreviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [viewMode, setViewMode] = useState<ViewMode>(initialSopName ? "sop-detail" : "dashboard");
  const [categoryFilter, setCategoryFilter] = useState<WorkCategory | "all">("all");
  const [selectedSopName, setSelectedSopName] = useState<string | null>(initialSopName ?? null);
  const [selectedSopLookupId, setSelectedSopLookupId] = useState<string | null>(initialSopId ?? null);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<string | null>(initialHistoryRunId ?? null);
  const [detailTargetFilter, setDetailTargetFilter] = useState<string | null>(null);
  const pageLoading = loading || !sopListLoaded;

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
    window.electron.sopList().then((results) => setSopList(results)).catch(console.error).finally(() => setSopListLoaded(true));
  }, [fetchItems]);

  useEffect(() => {
    const unsub = window.electron.onPlanItemsChanged(() => { fetchItems(); });
    return unsub;
  }, [fetchItems]);

  const selectedSopDef = useMemo(
    () => findMatchingSopDefinition(sopList, selectedSopName, selectedSopLookupId),
    [selectedSopLookupId, selectedSopName, sopList],
  );

  useEffect(() => {
    if (!selectedSopDef) return;
    if (selectedSopName !== selectedSopDef.name) {
      setSelectedSopName(selectedSopDef.name);
    }
    if (selectedSopLookupId !== selectedSopDef.id) {
      setSelectedSopLookupId(selectedSopDef.id);
    }
  }, [selectedSopDef, selectedSopLookupId, selectedSopName]);

  useEffect(() => {
    const sopId = selectedSopDef?.id ?? selectedSopLookupId;
    if (viewMode !== "sop-detail" || !sopId) {
      setWorkflowRun(null);
      setStageLoading(false);
      return;
    }

    let cancelled = false;
    const loadRun = async () => {
      setStageLoading(true);
      try {
        const run = selectedHistoryRunId
          ? (await window.electron.workflowGetHistory(sopId)).find((item) => item.id === selectedHistoryRunId) ?? null
          : await window.electron.workflowGetRun(sopId);
        if (!cancelled) setWorkflowRun(run);
      } catch (err) {
        if (!cancelled) {
          console.error("[PlanTable] Failed to load workflow run:", err);
          setWorkflowRun(null);
        }
      } finally {
        if (!cancelled) setStageLoading(false);
      }
    };

    void loadRun();
    if (selectedHistoryRunId) {
      return () => {
        cancelled = true;
      };
    }
    const unsub = window.electron.onWorkflowRunChanged((changedSopId: string) => {
      if (changedSopId !== sopId) return;
      void loadRun();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [selectedHistoryRunId, selectedSopDef, selectedSopLookupId, viewMode]);

  // ═══ SOP Summaries ═══

  const existingSopItems = useMemo<PlanItem[]>(() => {
    if (!sopListLoaded) return [];
    return items.flatMap((item) => {
      const matchedSop = findMatchingSopDefinition(sopList, item.sopName);
      if (!matchedSop) return [];
      return [{
        ...item,
        sopName: matchedSop.name,
        category: matchedSop.category ?? item.category,
      }];
    });
  }, [items, sopList, sopListLoaded]);

  const sopSummaries = useMemo<SopSummary[]>(() => {
    const map = new Map<string, PlanItem[]>();
    for (const item of existingSopItems) {
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
  }, [existingSopItems]);

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
    const totalItems = existingSopItems.length;
    const failedItems = existingSopItems.filter((i) => i.status === "failed").length;
    const overdueItems = existingSopItems.filter(isOverdue).length;
    const attentionCount = failedItems + overdueItems;
    const completedItems = existingSopItems.filter((i) => i.status === "completed").length;
    return { totalSops, runningSops, totalItems, failedItems, overdueItems, attentionCount, completedItems };
  }, [existingSopItems, sopSummaries]);

  // ═══ Today items ═══

  const todayItems = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86400000);
    return existingSopItems.filter((item) => {
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
  }, [existingSopItems]);

  const todayByStatus = useMemo(() => {
    const map: Record<string, PlanItem[]> = {};
    for (const col of PLAN_COLUMNS) map[col.key] = [];
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
    () => {
      const targetName = selectedSopDef?.name ?? selectedSopName;
      if (!targetName) return null;
      const normalizedTarget = normalizeSopMatch(targetName);
      return sopSummaries.find((s) => normalizeSopMatch(s.sopName) === normalizedTarget) ?? null;
    },
    [selectedSopDef, selectedSopName, sopSummaries],
  );

  const isHistorySnapshot = viewMode === "sop-detail" && !!selectedHistoryRunId;
  const hasWorkflowSnapshot = !!workflowRun;
  const showStageDetail = viewMode === "sop-detail"
    && !!selectedSopName
    && (isHistorySnapshot || !!selectedSopDef?.stages?.length)
    && (stageLoading || hasWorkflowSnapshot);
  const detailLoading = viewMode === "sop-detail"
    && (!sopListLoaded || ((isHistorySnapshot || !!selectedSopDef?.stages?.length) && stageLoading));
  const historySnapshotUnavailable = isHistorySnapshot && !stageLoading && !workflowRun;
  const workflowSnapshotUnavailable = viewMode === "sop-detail"
    && !!selectedSopDef?.stages?.length
    && !isHistorySnapshot
    && !stageLoading
    && !workflowRun;

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
    for (const col of PLAN_COLUMNS) map[col.key] = [];
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

  const assistantBySessionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of selectedSopSummary?.items ?? []) {
      if (item.sessionId && item.assistantId && !map.has(item.sessionId)) {
        map.set(item.sessionId, item.assistantId);
      }
    }
    return map;
  }, [selectedSopSummary]);

  const sessionAssistantBySessionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session?.assistantId) {
        map.set(sessionId, session.assistantId);
      }
    }
    return map;
  }, [sessions]);

  const defaultSopAssistantId = useMemo(
    () => selectedSopSummary?.items.find((item) => item.assistantId)?.assistantId,
    [selectedSopSummary],
  );

  const mergedStages = useMemo<StageKanbanItem[]>(() => {
    if (isHistorySnapshot) {
      if (!workflowRun?.stages?.length) return [];
      const definitionByStageId = new Map((selectedSopDef?.stages ?? []).map((stage) => [stage.id, stage]));
      return workflowRun.stages.map((runStage, index) => {
        const definedStage = definitionByStageId.get(runStage.stageId);
        return {
          id: runStage.stageId,
          label: runStage.label || definedStage?.label || `阶段 ${index + 1}`,
          index: index + 1,
          status: runStage.status,
          assistantId: runStage.assistantId
            ?? (runStage.sessionId ? sessionAssistantBySessionId.get(runStage.sessionId) : undefined)
            ?? (runStage.sessionId ? assistantBySessionId.get(runStage.sessionId) : undefined)
            ?? defaultSopAssistantId,
          goal: definedStage?.goal ?? "",
          itemCount: definedStage?.items.length ?? 0,
          inputPrompt: runStage.inputPrompt,
          output: runStage.output,
          abstract: runStage.abstract ?? "",
          error: runStage.error,
          sessionId: runStage.sessionId,
          duration: runStage.duration,
          startedAt: runStage.startedAt,
          completedAt: runStage.completedAt,
          definitionMissing: !definedStage,
        };
      });
    }
    if (!selectedSopDef?.stages?.length) return [];
    return selectedSopDef.stages.map((stage, index) => {
      const runStage = workflowRun?.stages.find((item) => item.stageId === stage.id);
      return {
        id: stage.id,
        label: stage.label,
        index: index + 1,
        status: runStage?.status ?? "pending",
        assistantId: runStage?.assistantId
          ?? (runStage?.sessionId ? sessionAssistantBySessionId.get(runStage.sessionId) : undefined)
          ?? (runStage?.sessionId ? assistantBySessionId.get(runStage.sessionId) : undefined)
          ?? defaultSopAssistantId,
        goal: stage.goal,
        itemCount: stage.items.length,
        inputPrompt: runStage?.inputPrompt,
        output: runStage?.output,
        abstract: runStage?.abstract ?? "",
        error: runStage?.error,
        sessionId: runStage?.sessionId,
        duration: runStage?.duration,
        startedAt: runStage?.startedAt,
        completedAt: runStage?.completedAt,
        definitionMissing: false,
      };
    });
  }, [assistantBySessionId, defaultSopAssistantId, isHistorySnapshot, selectedSopDef, sessionAssistantBySessionId, workflowRun]);

  const selectedStagePreview = useMemo(
    () => (selectedStagePreviewId ? mergedStages.find((stage) => stage.id === selectedStagePreviewId) ?? null : null),
    [mergedStages, selectedStagePreviewId],
  );

  const selectedPreviewSession = selectedStagePreview?.sessionId ? sessions[selectedStagePreview.sessionId] ?? null : null;
  const selectedPreviewAssistantId = selectedStagePreview?.assistantId ?? selectedPreviewSession?.assistantId;
  const selectedPreviewAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === selectedPreviewAssistantId),
    [assistants, selectedPreviewAssistantId],
  );

  useEffect(() => {
    if (!selectedStagePreview?.sessionId) return;
    if (selectedPreviewSession?.hydrated || historyRequested.has(selectedStagePreview.sessionId)) return;
    markHistoryRequested(selectedStagePreview.sessionId);
    window.electron.sendClientEvent({ type: "session.history", payload: { sessionId: selectedStagePreview.sessionId } });
  }, [historyRequested, markHistoryRequested, selectedPreviewSession?.hydrated, selectedStagePreview?.sessionId]);

  useEffect(() => {
    if (viewMode !== "sop-detail") {
      setSelectedStagePreviewId(null);
      return;
    }
    if (selectedStagePreviewId && !mergedStages.some((stage) => stage.id === selectedStagePreviewId)) {
      setSelectedStagePreviewId(null);
    }
  }, [mergedStages, selectedStagePreviewId, viewMode]);

  const stagesByStatus = useMemo(() => {
    const map: Record<WorkflowStageStatus, StageKanbanItem[]> = {
      pending: [],
      in_progress: [],
      completed: [],
      failed: [],
    };
    for (const stage of mergedStages) {
      map[stage.status].push(stage);
    }
    return map;
  }, [mergedStages]);

  // ═══ Auto-scroll to first non-empty column ═══

  useEffect(() => {
    const scrollRef = viewMode === "sop-detail" ? sopKanbanScrollRef : viewMode === "today" ? todayKanbanScrollRef : null;
    if (!scrollRef?.current) return;
    let firstNonEmpty: string | null = null;
    if (viewMode === "sop-detail" && showStageDetail) {
      firstNonEmpty = STAGE_COLUMNS.find((col) => (stagesByStatus[col.key]?.length ?? 0) > 0)?.key ?? null;
    } else {
      firstNonEmpty = PLAN_COLUMNS.find((col) => {
        const itemsForColumn = viewMode === "sop-detail" ? sopKanbanByStatus[col.key] : todayByStatus[col.key];
        return (itemsForColumn?.length ?? 0) > 0;
      })?.key ?? null;
    }
    if (!firstNonEmpty) return;
    const target = scrollRef.current.querySelector<HTMLElement>(`#kanban-col-${firstNonEmpty}`);
    if (target) {
      // Small delay to ensure layout is complete before scrolling
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
      });
    }
  }, [showStageDetail, sopKanbanByStatus, stagesByStatus, todayByStatus, viewMode]);

  // ═══ Handlers ═══

  const handleRetry = async (id: string) => {
    try { await window.electron.retryPlanItem(id); } catch (err) { console.error("[PlanTable] Retry failed:", err); }
  };
  const handleRunNow = async (id: string) => {
    try { await window.electron.runPlanItemNow(id); } catch (err) { console.error("[PlanTable] RunNow failed:", err); }
  };
  const handleExecuteStage = async (stageId: string) => {
    if (!selectedSopDef || isHistorySnapshot) return;
    try {
      const run = await window.electron.workflowExecuteStage(selectedSopDef.id, stageId);
      setWorkflowRun(run);
    } catch (err) {
      console.error("[PlanTable] ExecuteStage failed:", err);
    }
  };
  const handleRetryStage = async (stageId: string) => {
    if (!selectedSopDef || isHistorySnapshot) return;
    try {
      const run = await window.electron.workflowRetryStage(selectedSopDef.id, stageId);
      setWorkflowRun(run);
    } catch (err) {
      console.error("[PlanTable] RetryStage failed:", err);
    }
  };
  const handleOpenStageSessionPreview = (stageId: string) => {
    setSelectedStagePreviewId(stageId);
  };
  const handleCloseStageSessionPreview = () => {
    setSelectedStagePreviewId(null);
  };
  const handleOpenFullSession = () => {
    if (!selectedStagePreview?.sessionId || !onNavigateToSession) return;
    onNavigateToSession(selectedStagePreview.sessionId, selectedPreviewAssistantId ?? "");
  };

  const openSopDetail = (name: string) => {
    setSelectedSopName(name);
    setSelectedSopLookupId(null);
    setSelectedHistoryRunId(null);
    setDetailTargetFilter(null);
    setViewMode("sop-detail");
  };

  const backToDashboard = () => {
    setViewMode("dashboard");
    setSelectedSopName(null);
    setSelectedSopLookupId(null);
    setSelectedHistoryRunId(null);
    setDetailTargetFilter(null);
  };

  // ═══ Header title logic ═══

  let headerTitle = "Dashboard";
  let headerBack = onBack ?? onClose;
  let headerBackLabel = "返回";
  let headerRight: React.ReactNode = null;

  if (viewMode === "sop-detail" && selectedSopName) {
    headerTitle = selectedSopDef?.name ?? selectedSopSummary?.sopName ?? selectedSopName;
    headerBack = backToDashboard;
    headerBackLabel = "返回";
    if (showStageDetail) {
      const completedCount = mergedStages.filter((stage) => stage.status === "completed").length;
      const failedCount = mergedStages.filter((stage) => stage.status === "failed").length;
      const runningCount = mergedStages.filter((stage) => stage.status === "in_progress").length;
      const snapshotMeta = getWorkflowStatusMeta(workflowRun?.status);
      headerRight = (
        <div className="flex items-center gap-2 text-[11px]">
          {isHistorySnapshot && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${snapshotMeta.className}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${snapshotMeta.dotClassName}`} />
              历史快照
            </span>
          )}
          <span className="text-muted">{completedCount}/{mergedStages.length} 阶段完成</span>
          {runningCount > 0 && <span className="text-info font-medium">{runningCount} 进行中</span>}
          {failedCount > 0 && <span className="text-error font-medium">{failedCount} 失败</span>}
        </div>
      );
    } else if (selectedSopSummary) {
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
    } else {
      headerRight = <span className="text-[11px] text-muted">暂无运行记录</span>;
    }
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
        <span className="text-[11px] text-muted">{existingSopItems.length} 项</span>
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
        {pageLoading ? (
          <div className="flex items-center justify-center w-full py-24">
            <svg className="h-5 w-5 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        ) : viewMode === "sop-detail" && selectedSopName ? (
          /* ═══ SOP Kanban View ═══ */
          <div className="flex h-full min-h-0">
            <div className="flex flex-col flex-1 min-w-0">
            {workflowSnapshotUnavailable && selectedSopSummary && (
              <div className="shrink-0 px-4 pt-3">
                <div className="flex items-center gap-2 flex-wrap rounded-2xl border border-amber-200/70 bg-amber-50 px-3 py-2.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-1 text-[10px] font-medium text-amber-700 border border-amber-200/70">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    无阶段快照
                  </span>
                  <span className="text-[12px] text-amber-800">
                    当前仅保留计划项结果，未找到对应的 workflow 运行记录，已自动切换为计划项看板。
                  </span>
                </div>
              </div>
            )}
            {isHistorySnapshot && workflowRun && (
              <div className="shrink-0 px-4 pt-3">
                <div className="flex items-center gap-2 flex-wrap rounded-2xl border border-amber-200/70 bg-amber-50 px-3 py-2.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-1 text-[10px] font-medium text-amber-700 border border-amber-200/70">
                    <span className={`h-1.5 w-1.5 rounded-full ${getWorkflowStatusMeta(workflowRun.status).dotClassName}`} />
                    历史快照
                  </span>
                  <span className="text-[12px] text-amber-800">
                    开始于 {formatSnapshotTimestamp(workflowRun.startedAt)}
                  </span>
                  {workflowRun.completedAt && (
                    <span className="text-[12px] text-amber-800">
                      结束于 {formatSnapshotTimestamp(workflowRun.completedAt)}
                    </span>
                  )}
                  <span className="text-[12px] text-amber-800">
                    当前页面仅供查看，不会实时更新。
                  </span>
                </div>
              </div>
            )}
            {/* Target filter bar */}
            {!showStageDetail && detailTargetNames.length >= 2 && (
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
              {detailLoading ? (
                <div className="flex items-center justify-center w-full py-24">
                  <svg className="h-5 w-5 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
              ) : historySnapshotUnavailable ? (
                <div className="flex flex-col items-center justify-center w-full py-24 gap-2">
                  <p className="text-sm text-muted">找不到这次历史快照</p>
                  <p className="text-xs text-muted/70">对应执行记录可能已被清理，或当前 SOP 已发生较大变更。</p>
                </div>
              ) : showStageDetail ? (
                STAGE_COLUMNS.map((col) => (
                  <StageKanbanColumn
                    key={col.key}
                    id={`kanban-col-${col.key}`}
                    config={col}
                    items={stagesByStatus[col.key] ?? []}
                    assistants={assistants}
                    onExecute={handleExecuteStage}
                    onRetry={handleRetryStage}
                    onOpenSessionPreview={handleOpenStageSessionPreview}
                    readOnly={isHistorySnapshot}
                  />
                ))
              ) : selectedSopSummary && Object.values(sopKanbanByStatus).some((arr) => arr.length > 0) ? (
                PLAN_COLUMNS.map((col) => (
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
              ) : selectedSopSummary ? (
                <div className="flex flex-col items-center justify-center w-full py-24 gap-2">
                  <p className="text-sm text-muted">无匹配的任务</p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center w-full py-24 gap-2">
                  <p className="text-sm text-muted">未找到该 SOP 的阶段定义或计划项</p>
                  <p className="text-xs text-muted/70">可能是 SOP 已改名、被删除，或暂未生成计划项</p>
                </div>
              )}
            </div>
            </div>
            {selectedStagePreview && selectedStagePreview.sessionId && (
              <SessionPreviewPanel
                stage={selectedStagePreview}
                session={selectedPreviewSession}
                assistant={selectedPreviewAssistant}
                onClose={handleCloseStageSessionPreview}
                onOpenFullSession={handleOpenFullSession}
              />
            )}
          </div>

        ) : existingSopItems.length === 0 ? (
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
              PLAN_COLUMNS.map((col) => (
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
