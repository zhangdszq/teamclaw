import { useState, useMemo, useCallback, useEffect, useRef, type CSSProperties } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  type Node,
  type Edge,
  type EdgeMarker,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { emitToast } from "../render/markdown";

interface SopPageProps {
  onClose: () => void;
  onOpenPlanTable?: (target?: { sopName?: string; sopId?: string; historyRunId?: string }) => void;
  onNavigateToSession?: (sessionId: string) => void;
  titleBarHeight?: number;
}

type WorkflowTab = "lesson_cycle" | "monthly_settlement";

interface SopItem {
  id: string;
  name: string;
  description: string;
  category: WorkCategory;
  status: "active" | "draft" | "paused";
  workflowCount: number;
  icon: string;
  stages?: HandStage[];
  createdAt?: string;
}

type WorkflowHistoryModalState = {
  sopId: string;
  sopName: string;
  runs: WorkflowRun[];
};

type SopDisplayStatus = "running" | "normal" | "failed" | "overdue" | "pending" | "draft" | "paused";

type SopPlanSummary = {
  total: number;
  failed: number;
  inProgress: number;
  overdue: number;
};

const CATEGORY_ORDER: WorkCategory[] = ["客户服务", "情报监控", "内部运营", "增长销售", ""];

const CATEGORY_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  "客户服务": { label: "客户服务", color: "#2563EB", bg: "#EFF6FF" },
  "情报监控": { label: "情报监控", color: "#7C3AED", bg: "#F5F3FF" },
  "内部运营": { label: "内部运营", color: "#0D9488", bg: "#F0FDFA" },
  "增长销售": { label: "增长销售", color: "#D97706", bg: "#FFFBEB" },
  "":         { label: "其他",     color: "#6B7280", bg: "#F3F4F6" },
};

function formatWorkflowHistoryTimestamp(iso?: string): string {
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

function getWorkflowRunDurationMs(run: WorkflowRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const duration = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function formatWorkflowRunDuration(run: WorkflowRun): string {
  const durationMs = getWorkflowRunDurationMs(run);
  if (!durationMs) return "";
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function getWorkflowRunStatusMeta(status: WorkflowStatus): { label: string; className: string; dotClassName: string } {
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

function getWorkflowRunPreview(run: WorkflowRun): string {
  const failedStage = [...run.stages].reverse().find((stage) => stage.error?.trim());
  if (failedStage?.error) return failedStage.error.trim();
  const abstractStage = [...run.stages].reverse().find((stage) => stage.abstract?.trim());
  if (abstractStage?.abstract) return abstractStage.abstract.trim();
  if (run.status === "completed") return "本次执行已完成，可查看阶段快照。";
  if (run.status === "failed") return "本次执行失败，可查看失败阶段与上下文。";
  if (run.status === "running") return "本次执行仍在进行中。";
  return "暂无阶段摘要。";
}

function isPlanItemOverdue(item: PlanItem): boolean {
  if (item.status !== "pending") return false;
  return new Date(item.scheduledTime).getTime() < Date.now();
}

function normalizeSopSyncKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+hand$/, "");
}

// Fallback list shown before HAND.toml files are loaded
const FALLBACK_SOP_LIST: SopItem[] = [
  {
    id: "vvip-educare",
    name: "VVIP EduCare",
    description: "课程周期 & 月度结算自动化",
    category: "客户服务",
    status: "active",
    workflowCount: 2,
    icon: "🎓",
  },
];

interface ToolOption { value: string; group: string; desc: string }

// Mirrors SHARED_TOOL_CATALOG in shared-mcp.ts — keep in sync when adding new tools.
// Only lists tools that are actually implemented. No aliases, no placeholders.
const TOOL_OPTIONS: ToolOption[] = [
  // 调度
  { value: "create_scheduled_task",  group: "调度",  desc: "创建一次性或周期性定时任务，到期自动启动 AI 会话执行" },
  { value: "list_scheduled_tasks",   group: "调度",  desc: "列出当前所有定时任务及其状态" },
  { value: "delete_scheduled_task",  group: "调度",  desc: "删除指定定时任务" },
  // 网络
  { value: "web_search",             group: "网络",  desc: "通过 DuckDuckGo 搜索网络，返回 top 结果" },
  { value: "web_fetch",              group: "网络",  desc: "抓取指定 URL 内容并以纯文本返回" },
  // 文件
  { value: "read_document",          group: "文件",  desc: "读取本地文件（PDF/Word/Excel/文本/CSV）内容" },
  // 记忆
  { value: "save_memory",            group: "记忆",  desc: "保存长期记忆条目（private 专属 / shared 团队共享）" },
  { value: "save_working_memory",    group: "记忆",  desc: "保存当前任务上下文的工作记忆检查点" },
  { value: "read_working_memory",    group: "记忆",  desc: "读取最近保存的工作记忆检查点" },
  { value: "query_team_memory",      group: "记忆",  desc: "跨助理只读搜索记忆，获取其他助理的历史上下文" },
  { value: "distill_memory",         group: "记忆",  desc: "任务完成后触发结构化记忆蒸馏，提取值得长期保留的信息" },
  { value: "save_experience",        group: "记忆",  desc: "沉淀操作经验到知识库候选，便于后续审核和复用" },
  // SOP
  { value: "list_sops",              group: "SOP",   desc: "列出当前所有工作流 SOP" },
  { value: "generate_sop",           group: "SOP",   desc: "根据自然语言描述异步生成一个新的工作流 SOP" },
  { value: "execute_sop",            group: "SOP",   desc: "执行指定的工作流 SOP" },
  { value: "query_sop_run_status",   group: "SOP",   desc: "查询指定工作流 SOP 最近一次运行状态" },
  { value: "query_sop_generate_status", group: "SOP", desc: "查询异步生成 SOP 任务的当前进度" },
  // 脚本
  { value: "run_script",             group: "脚本",  desc: "执行 Python / PowerShell / Node.js 脚本，支持超时控制" },
  // 桌面
  { value: "desktop_control",        group: "桌面",  desc: "发送键盘输入或控制鼠标，实现桌面自动化" },
  { value: "take_screenshot",        group: "桌面",  desc: "截取当前桌面屏幕截图" },
  { value: "screen_analyze",         group: "桌面",  desc: "截取屏幕并返回路径和活动窗口信息" },
  // 系统
  { value: "process_control",        group: "系统",  desc: "列出、启动或终止系统进程" },
  { value: "clipboard",              group: "系统",  desc: "读取或写入系统剪贴板内容" },
  { value: "system_info",            group: "系统",  desc: "获取 OS / CPU / 内存 / 磁盘 / 网络等系统环境信息" },
  // 计划
  { value: "upsert_plan_item",       group: "计划",  desc: "创建或更新计划表中的一条任务项" },
  { value: "complete_plan_item",     group: "计划",  desc: "将计划任务项标记为已完成" },
  { value: "fail_plan_item",         group: "计划",  desc: "将计划任务项标记为失败并记录原因" },
  { value: "list_plan_items",        group: "计划",  desc: "列出计划表中的所有任务项" },
  // 通知
  { value: "send_notification",      group: "通知",  desc: "向用户发送主动通知（Telegram > 飞书 > 钉钉 优先级）" },
  // 资讯
  { value: "news_latest",            group: "资讯",  desc: "获取最新加密货币/财经资讯（含 AI 评分和交易信号）" },
  { value: "news_search",            group: "资讯",  desc: "按关键词搜索加密货币/财经资讯" },
  // 社交
  { value: "twitter_user_tweets",    group: "社交",  desc: "获取指定 Twitter/X 用户的最近推文" },
  { value: "twitter_search",         group: "社交",  desc: "搜索 Twitter/X 推文（支持关键词/话题/用户过滤）" },
];

const MCP_OPTIONS: ToolOption[] = [
  // 钉钉
  { value: "dingtalk-ai-table",   group: "钉钉",   desc: "多维表格 — 读写结构化业务数据、课时核算" },
  { value: "dingtalk-contacts",   group: "钉钉",   desc: "通讯录 — 查询成员、部门和员工信息" },
  { value: "dingtalk-message",    group: "钉钉",   desc: "消息 — 向群或个人发送钉钉消息" },
  // 飞书
  { value: "feishu-doc",          group: "飞书",   desc: "文档 — 创建/读写飞书知识库文档" },
  { value: "feishu-sheet",        group: "飞书",   desc: "表格 — 操作飞书多维表格和电子表格" },
  { value: "feishu-message",      group: "飞书",   desc: "消息 — 向飞书群或用户发送富文本消息" },
  { value: "feishu-calendar",     group: "飞书",   desc: "日历 — 创建、查询和更新飞书日程" },
  // 搜索
  { value: "exa",                 group: "搜索",   desc: "Exa 深度语义搜索，适合学术/技术资料" },
  { value: "user-opennews",       group: "搜索",   desc: "OpenNews — 实时新闻聚合与主题订阅" },
  { value: "user-opentwitter",    group: "搜索",   desc: "OpenTwitter — 推文检索与用户时间线" },
  // 协作
  { value: "github",              group: "协作",   desc: "GitHub — 读写代码仓库、Issue 和 PR" },
  { value: "slack",               group: "协作",   desc: "Slack — 消息、频道和工作区管理" },
  { value: "notion",              group: "协作",   desc: "Notion — 文档、数据库和页面操作" },
  // 数据库
  { value: "airtable",            group: "数据库", desc: "Airtable — 低代码关系数据库读写" },
  // Google
  { value: "google-calendar",     group: "Google", desc: "Google 日历 — 事件创建和查询" },
  { value: "google-sheets",       group: "Google", desc: "Google Sheets — 电子表格读写" },
  { value: "google-docs",         group: "Google", desc: "Google Docs — 文档内容操作" },
  // 项目管理
  { value: "jira",                group: "项目管理", desc: "Jira — Issue 创建和冲刺管理" },
  { value: "linear",              group: "项目管理", desc: "Linear — 现代研发任务跟踪" },
  { value: "asana",               group: "项目管理", desc: "Asana — 项目和任务协作管理" },
  // 通信
  { value: "sendgrid",            group: "通信",   desc: "SendGrid — 事务邮件发送" },
  { value: "twilio",              group: "通信",   desc: "Twilio — SMS 短信和语音通话" },
  { value: "stripe",              group: "通信",   desc: "Stripe — 支付和订阅管理" },
];

// ═══ Custom Node Components ═══

const STAGE_STATUS_BADGE: Record<string, { icon: string; color: string; pulse?: boolean }> = {
  pending: { icon: "", color: "" },
  in_progress: { icon: "●", color: "#3B82F6", pulse: true },
  completed: { icon: "✓", color: "#16A34A" },
  failed: { icon: "✗", color: "#DC2626" },
};

function StepNode({ data, selected }: { data: { label: string; items: string[]; tools: string[]; mcp: string[]; color: string; bgColor: string; stageStatus?: string; stageId?: string; onPlayStage?: (stageId: string) => void; onScheduleStage?: (stageId: string) => void; stageHasSchedule?: boolean }; selected?: boolean }) {
  const hasSkills = data.tools.length > 0;
  const hasMcp = data.mcp.length > 0;
  const hasBadges = hasSkills || hasMcp;
  const badge = data.stageStatus ? STAGE_STATUS_BADGE[data.stageStatus] : null;
  const showBadge = badge && data.stageStatus !== "pending";

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.stageId && data.onPlayStage) data.onPlayStage(data.stageId);
  };

  const handleSchedule = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.stageId && data.onScheduleStage) data.onScheduleStage(data.stageId);
  };

  return (
    <div
      className="group rounded-xl px-4 py-3 min-w-[170px] max-w-[210px] cursor-pointer transition-shadow relative"
      style={{
        border: selected ? `2px solid ${data.color}` : `1.5px solid ${data.color}30`,
        backgroundColor: data.bgColor,
        boxShadow: selected
          ? `0 0 0 3px ${data.color}22, 0 4px 12px ${data.color}20`
          : `0 2px 8px ${data.color}12`,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-3 !h-3" style={{ left: -6 }} />

      {/* Status badge (top-left) */}
      {showBadge && (
        <span
          className={`absolute -top-1.5 -left-1.5 flex items-center justify-center h-4 w-4 rounded-full text-[9px] font-bold text-white ${badge.pulse ? "animate-pulse" : ""}`}
          style={{ backgroundColor: badge.color }}
        >
          {badge.icon}
        </span>
      )}

      {/* Single-stage play button (top-right) */}
      {data.stageId && data.onPlayStage && (
        <button
          onClick={handlePlay}
          className="absolute -top-1.5 -right-1.5 flex items-center justify-center h-5 w-5 rounded-full bg-surface border border-ink-900/15 text-muted opacity-0 hover:opacity-100 hover:text-accent hover:border-accent/40 shadow-sm transition-all group-hover:opacity-60"
          style={{ zIndex: 10 }}
          title="单独执行此阶段"
        >
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="currentColor">
            <path d="M3 1.5v9l7.5-4.5L3 1.5z" />
          </svg>
        </button>
      )}

      {/* Single-stage schedule button (bottom-right) */}
      {data.stageId && data.onScheduleStage && (
        <button
          onClick={handleSchedule}
          className={`absolute -bottom-1.5 -right-1.5 flex items-center justify-center h-5 w-5 rounded-full bg-surface border shadow-sm transition-all ${
            data.stageHasSchedule
              ? "text-violet-500 border-violet-400/60 opacity-100"
              : "border-ink-900/15 text-muted opacity-0 hover:opacity-100 hover:text-violet-500 hover:border-violet-400/40 group-hover:opacity-60"
          }`}
          style={{ zIndex: 10 }}
          title={data.stageHasSchedule ? "修改此阶段定时" : "设置此阶段定时"}
        >
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6" cy="6.5" r="4" />
            <path d="M6 4.5v2l1.5 1" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 1.5h4" strokeLinecap="round" />
          </svg>
        </button>
      )}

      <div className="flex items-center gap-2 mb-2.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: data.color }} />
        <span className="text-[12px] font-semibold" style={{ color: data.color }}>{data.label}</span>
      </div>
      <div className="flex flex-col gap-1.5" style={{ marginBottom: hasBadges ? "10px" : 0 }}>
        {data.items.map((item: string) => (
          <div key={item} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4A4A45" }}>
            <span className="inline-block h-[3px] w-[3px] rounded-full flex-shrink-0" style={{ backgroundColor: `${data.color}80` }} />
            {item}
          </div>
        ))}
      </div>
      {hasBadges && (
        <div className="flex flex-col gap-1.5 pt-2" style={{ borderTop: `1px solid ${data.color}18` }}>
          {hasSkills && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: data.color }}>
                  <path d="M9.5 2.5a2 2 0 0 0-3 1.7v.3L3 8a1 1 0 1 0 1.4 1.4L8 5.5h.3a2 2 0 0 0 1.7-3l-1.2 1.2-.8-.8 1.5-1.4z" />
                </svg>
                <span className="text-[8px] font-semibold tracking-wider uppercase" style={{ color: `${data.color}AA` }}>Skills</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {data.tools.map((tool: string) => (
                  <span
                    key={tool}
                    className="rounded-md px-1.5 py-[2px] text-[9px] font-mono"
                    style={{ backgroundColor: `${data.color}15`, color: data.color }}
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasMcp && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 flex-shrink-0 text-teal-600" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="6" cy="6" r="2" />
                  <path d="M6 1v2M6 9v2M1 6h2M9 6h2" />
                  <path d="M2.9 2.9l1.4 1.4M7.7 7.7l1.4 1.4M7.7 4.3 9.1 2.9M2.9 9.1l1.4-1.4" />
                </svg>
                <span className="text-[8px] font-semibold tracking-wider uppercase text-teal-600">MCP</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {data.mcp.map((m: string) => (
                  <span
                    key={m}
                    className="rounded-md px-1.5 py-[2px] text-[9px] font-mono"
                    style={{ backgroundColor: "#CCFBF180", color: "#0F766E" }}
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0 !w-3 !h-3" style={{ right: -6 }} />
    </div>
  );
}

function DecisionNode({ data }: { data: { label: string } }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 140, height: 90 }}>
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-3 !h-3" style={{ left: -2 }} />
      <svg viewBox="0 0 140 90" className="absolute inset-0" style={{ filter: "drop-shadow(0 2px 6px rgba(217,119,6,0.15))" }}>
        <polygon
          points="70,5 135,45 70,85 5,45"
          fill="#FFFBEB"
          stroke="#D97706"
          strokeWidth="1.5"
        />
      </svg>
      <span className="relative text-[11px] font-medium text-amber-700 text-center leading-snug px-6">
        {data.label}
      </span>
      <Handle id="yes" type="source" position={Position.Right} className="!bg-transparent !border-0 !w-3 !h-3" style={{ right: -2, top: "35%" }} />
      <Handle id="no" type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-3 !h-3" style={{ bottom: -2 }} />
    </div>
  );
}

function EventNode({ data }: { data: { label: string; tool: string } }) {
  return (
    <div
      className="rounded-xl px-4 py-3 min-w-[130px]"
      style={{
        border: "1.5px solid #D9770630",
        backgroundColor: "#FFFBEB",
        boxShadow: "0 2px 8px rgba(217,119,6,0.1)",
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-3 !h-3" style={{ left: -6 }} />
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
        <span className="text-[12px] font-semibold text-amber-700">{data.label}</span>
      </div>
      <span className="rounded-md px-1.5 py-[2px] text-[9px] font-mono text-amber-600 bg-amber-100">
        {data.tool}
      </span>
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0 !w-3 !h-3" style={{ right: -6 }} />
    </div>
  );
}

function EndNode({ data }: { data: { label: string } }) {
  return (
    <div
      className="rounded-full px-4 py-2.5 flex items-center gap-2"
      style={{
        border: "1.5px dashed #9B9B96",
        backgroundColor: "var(--color-surface-cream)",
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-3 !h-3" style={{ left: -6 }} />
      <span className="text-[11px] text-[#6B6B66]">{data.label}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  step: StepNode,
  decision: DecisionNode,
  event: EventNode,
  end: EndNode,
};

const EDGE_STYLE: CSSProperties = { strokeWidth: 1.5 };
const EDGE_MARKER: EdgeMarker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#9B9B96" };

const STAGE_COLORS = [
  { color: "#6366F1", bgColor: "#EEF2FF" },
  { color: "#3B82F6", bgColor: "#EFF6FF" },
  { color: "#0D9488", bgColor: "#F0FDFA" },
  { color: "#2C5F2F", bgColor: "#F0FDF4" },
  { color: "#D97706", bgColor: "#FFFBEB" },
];

function buildHandWorkflow(stages: HandStage[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = stages.map((stage, i) => {
    const { color, bgColor } = STAGE_COLORS[i % STAGE_COLORS.length];
    const items = stage.goal ? [stage.goal, ...stage.items] : stage.items;
    return {
      id: stage.id,
      type: "step",
      position: { x: 270 * i, y: 80 },
      data: { label: stage.label, items: items.slice(0, 4), tools: stage.tools ?? [], mcp: stage.mcp ?? [], color, bgColor },
    };
  });
  const edges: Edge[] = stages.slice(1).map((stage, i) => ({
    id: `hand-e${i}`,
    source: stages[i].id,
    target: stage.id,
    style: EDGE_STYLE,
    markerEnd: EDGE_MARKER,
  }));
  return { nodes, edges };
}

// ═══ Flow Data Builders ═══

function buildLessonCycleData(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    {
      id: "t-1", type: "step", position: { x: 0, y: 80 },
      data: { label: "T-1 课前准备", items: ["发送课前资料", "飞书归档"], tools: ["web_fetch", "file_write"], mcp: ["feishu-doc"], color: "#6366F1", bgColor: "#EEF2FF" },
    },
    {
      id: "t-0", type: "step", position: { x: 280, y: 80 },
      data: { label: "T-0 上课提醒", items: ["群内提醒", "Zoom确认"], tools: ["schedule_create"], mcp: [], color: "#3B82F6", bgColor: "#EFF6FF" },
    },
    {
      id: "t+0", type: "step", position: { x: 560, y: 80 },
      data: { label: "T+0 课后触发", items: ["回放下载", "催收反馈"], tools: ["shell_exec"], mcp: [], color: "#0D9488", bgColor: "#F0FDFA" },
    },
    {
      id: "decision", type: "decision", position: { x: 840, y: 82 },
      data: { label: "外教24h\n未反馈?" },
    },
    {
      id: "auto-collect", type: "event", position: { x: 1060, y: 50 },
      data: { label: "自动催收", tool: "event_publish" },
    },
    {
      id: "t+1", type: "step", position: { x: 1060, y: 240 },
      data: { label: "T+1 反馈循环", items: ["反馈梳理发送", "视频双备份", "AI补位检查"], tools: ["memory_store", "web_search"], mcp: ["exa"], color: "#2C5F2F", bgColor: "#F0F7F0" },
    },
    {
      id: "end-skip", type: "end", position: { x: 1310, y: 62 },
      data: { label: "等待下次课" },
    },
  ];

  const edges: Edge[] = [
    { id: "e1", source: "t-1", target: "t-0", style: EDGE_STYLE, markerEnd: EDGE_MARKER, animated: false },
    { id: "e2", source: "t-0", target: "t+0", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    { id: "e3", source: "t+0", target: "decision", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    {
      id: "e4-yes", source: "decision", sourceHandle: "yes", target: "auto-collect",
      style: { ...EDGE_STYLE, stroke: "#2C5F2F" }, markerEnd: { ...EDGE_MARKER, color: "#2C5F2F" },
      label: "Yes", labelStyle: { fill: "#2C5F2F", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#F0F7F0", stroke: "#2C5F2F30" }, labelBgPadding: [4, 6] as [number, number],
    },
    {
      id: "e4-no", source: "decision", sourceHandle: "no", target: "t+1",
      type: "smoothstep",
      style: { ...EDGE_STYLE, stroke: "#DC2626", strokeDasharray: "5 3" },
      markerEnd: { ...EDGE_MARKER, color: "#DC2626" },
      label: "No", labelStyle: { fill: "#DC2626", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#FEE2E2", stroke: "#DC262630" }, labelBgPadding: [4, 6] as [number, number],
    },
    { id: "e5", source: "auto-collect", target: "end-skip", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    {
      id: "e6", source: "t+1", target: "t-1",
      type: "smoothstep",
      style: { ...EDGE_STYLE, stroke: "#2C5F2F", strokeDasharray: "6 3" },
      markerEnd: { ...EDGE_MARKER, color: "#2C5F2F" },
      label: "下一周期", labelStyle: { fill: "#2C5F2F", fontSize: 10 },
      labelBgStyle: { fill: "#F0F7F0", stroke: "#2C5F2F30" }, labelBgPadding: [4, 6] as [number, number],
    },
  ];

  return { nodes, edges };
}

function buildMonthlySettlementData(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    {
      id: "stat", type: "step", position: { x: 0, y: 80 },
      data: { label: "课时统计", items: ["查询当月授课记录", "统计外教/中教课时"], tools: ["knowledge_query"], mcp: [], color: "#6366F1", bgColor: "#EEF2FF" },
    },
    {
      id: "calc", type: "step", position: { x: 280, y: 80 },
      data: { label: "费用核算", items: ["生成课时统计表", "写入钉钉多维表"], tools: [], mcp: ["dingtalk-ai-table"], color: "#3B82F6", bgColor: "#EFF6FF" },
    },
    {
      id: "report", type: "step", position: { x: 560, y: 80 },
      data: { label: "月度报告", items: ["汇总反馈记录", "生成学习报告", "归档飞书文档"], tools: ["memory_recall", "file_write"], mcp: ["feishu-doc"], color: "#2C5F2F", bgColor: "#F0F7F0" },
    },
    {
      id: "notify", type: "step", position: { x: 860, y: 80 },
      data: { label: "通知发送", items: ["通知教师管理团队", "发送家校报告"], tools: ["event_publish"], mcp: ["dingtalk-contacts"], color: "#D97706", bgColor: "#FFFBEB" },
    },
  ];

  const edges: Edge[] = [
    { id: "m1", source: "stat", target: "calc", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    { id: "m2", source: "calc", target: "report", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    { id: "m3", source: "report", target: "notify", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
  ];

  return { nodes, edges };
}


const STATUS_CONFIG: Record<SopDisplayStatus, { label: string; color: string; bg: string; dot: string }> = {
  running: { label: "执行中", color: "text-info", bg: "bg-info/10", dot: "bg-info" },
  normal: { label: "正常", color: "text-success", bg: "bg-success/10", dot: "bg-success" },
  failed: { label: "失败", color: "text-error", bg: "bg-error/10", dot: "bg-error" },
  overdue: { label: "逾期", color: "text-amber-600", bg: "bg-amber-50", dot: "bg-amber-400" },
  pending: { label: "待执行", color: "text-muted", bg: "bg-ink-900/5", dot: "bg-ink-400" },
  draft: { label: "草稿", color: "text-muted", bg: "bg-ink-900/5", dot: "bg-ink-400" },
  paused: { label: "已暂停", color: "text-amber-600", bg: "bg-amber-50", dot: "bg-amber-400" },
};

// ═══ SopSchedulePopover ═══

type SchedulePopoverMode = "disabled" | "daily" | "interval";

function SopSchedulePopover({
  anchorRef,
  sopId,
  stageId,
  existingTask,
  onClose,
  onChanged,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  sopId: string;
  stageId?: string;
  existingTask: ScheduledTask | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<SchedulePopoverMode>(
    existingTask
      ? existingTask.scheduleType === "daily"
        ? "daily"
        : "interval"
      : "disabled",
  );
  const [dailyTime, setDailyTime] = useState(existingTask?.dailyTime ?? "09:00");
  const [dailyDays, setDailyDays] = useState<number[]>(existingTask?.dailyDays ?? []);
  const [intVal, setIntVal] = useState(existingTask?.intervalValue ?? 1);
  const [intUnit, setIntUnit] = useState<"minutes" | "hours" | "days" | "weeks">(
    existingTask?.intervalUnit ?? "hours",
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (mode === "disabled") {
      if (existingTask) {
        setSaving(true);
        await window.electron.sopRemoveSopSchedule(existingTask.id);
        onChanged();
        onClose();
      } else {
        onClose();
      }
      return;
    }
    setSaving(true);
    try {
      const label = stageId ? `SOP节点定时` : `SOP整体定时`;
      await window.electron.sopSetSopSchedule({
        sopId,
        stageId,
        name: label,
        scheduleType: mode,
        ...(mode === "daily" ? { dailyTime, dailyDays: dailyDays.length ? dailyDays : undefined } : {}),
        ...(mode === "interval" ? { intervalValue: intVal, intervalUnit: intUnit } : {}),
        existingTaskId: existingTask?.id,
      });
      onChanged();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const DAYS = ["日", "一", "二", "三", "四", "五", "六"];

  // Position the popover near the anchor button
  const style: React.CSSProperties = { position: "fixed", zIndex: 9999 };
  if (anchorRef.current) {
    const rect = anchorRef.current.getBoundingClientRect();
    style.top = rect.bottom + 6;
    style.right = window.innerWidth - rect.right;
  }

  return (
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        style={style}
        className="w-64 rounded-xl border border-ink-900/10 bg-surface shadow-lg p-4 flex flex-col gap-3"
      >
        <div className="text-[11px] font-semibold text-ink-800">
          {stageId ? "节点定时触发" : "整体 SOP 定时触发"}
        </div>

        {/* Mode selector */}
        <div className="flex flex-col gap-1">
          {(["disabled", "daily", "interval"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="scheduleMode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                className="accent-accent"
              />
              <span className="text-[11px] text-ink-700">
                {m === "disabled" ? "不定时" : m === "daily" ? "每天固定时间" : "间隔执行"}
              </span>
            </label>
          ))}
        </div>

        {/* Daily config */}
        {mode === "daily" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted shrink-0">时间</span>
              <input
                type="time"
                value={dailyTime}
                onChange={(e) => setDailyTime(e.target.value)}
                className="flex-1 rounded-md border border-ink-900/15 bg-surface px-2 py-1 text-[11px] text-ink-800 focus:outline-none focus:border-accent/50"
              />
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-muted w-full mb-0.5">星期（不选=每天）</span>
              {DAYS.map((d, i) => (
                <button
                  key={i}
                  onClick={() => setDailyDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}
                  className={`h-6 w-6 rounded-md text-[10px] font-medium transition-colors ${
                    dailyDays.includes(i)
                      ? "bg-accent text-white"
                      : "bg-ink-900/5 text-ink-600 hover:bg-ink-900/10"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Interval config */}
        {mode === "interval" && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted shrink-0">每隔</span>
            <input
              type="number"
              min={1}
              value={intVal}
              onChange={(e) => setIntVal(Math.max(1, Number(e.target.value)))}
              className="w-16 rounded-md border border-ink-900/15 bg-surface px-2 py-1 text-[11px] text-ink-800 focus:outline-none focus:border-accent/50 text-center"
            />
            <select
              value={intUnit}
              onChange={(e) => setIntUnit(e.target.value as any)}
              className="flex-1 rounded-md border border-ink-900/15 bg-surface px-2 py-1 text-[11px] text-ink-700 focus:outline-none focus:border-accent/50"
            >
              <option value="minutes">分钟</option>
              <option value="hours">小时</option>
              <option value="days">天</option>
              <option value="weeks">周</option>
            </select>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-60"
          >
            {saving ? "保存中…" : mode === "disabled" && existingTask ? "移除定时" : "保存"}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-ink-900/10 px-3 py-1.5 text-[11px] font-medium text-ink-600 hover:bg-ink-900/5 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    </>
  );
}

// ═══ Main Component ═══

export function SopPage({ onClose, onOpenPlanTable, onNavigateToSession, titleBarHeight = 0 }: SopPageProps) {
  const [activeWorkflowTab] = useState<WorkflowTab>("lesson_cycle");
  const [selectedSopId, setSelectedSopId] = useState<string>("");
  const [sopList, setSopList] = useState<SopItem[]>(FALLBACK_SOP_LIST);
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, { tools: string[]; mcp: string[] }>>({});
  const [installedSkillOptions, setInstalledSkillOptions] = useState<ToolOption[]>([]);
  const [installedMcpOptions, setInstalledMcpOptions] = useState<ToolOption[]>([]);
  const [workflowRun, setWorkflowRun] = useState<WorkflowRun | null>(null);
  const [workflowRunMap, setWorkflowRunMap] = useState<Record<string, WorkflowRun | null>>({});
  const [showCheckPanel, setShowCheckPanel] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [planTableOpeningSopId, setPlanTableOpeningSopId] = useState<string | null>(null);
  const [workflowHistoryModal, setWorkflowHistoryModal] = useState<WorkflowHistoryModalState | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const loadedRef = useRef(false);
  const sopButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Schedule state
  const [schedulePopover, setSchedulePopover] = useState<{ stageId?: string; task: ScheduledTask | null } | null>(null);
  const sopScheduleBtnRef = useRef<HTMLButtonElement | null>(null);
  const [sopSchedules, setSopSchedules] = useState<ScheduledTask[]>([]);

  const loadSopSchedules = useCallback(async () => {
    if (!selectedSopId) return;
    try {
      const tasks = await window.electron.sopGetSopSchedules(selectedSopId);
      setSopSchedules(tasks);
    } catch { /* ignore */ }
  }, [selectedSopId]);

  useEffect(() => { loadSopSchedules(); }, [loadSopSchedules]);

  const loadPlanItems = useCallback(async () => {
    try {
      const items = await window.electron.getPlanItems();
      setPlanItems(items);
    } catch {
      setPlanItems([]);
    }
  }, []);

  useEffect(() => {
    void loadPlanItems();
    const unsub = window.electron.onPlanItemsChanged(() => { void loadPlanItems(); });
    return unsub;
  }, [loadPlanItems]);

  // Load SOP list from HAND.toml files
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    window.electron.sopList().then((results) => {
      if (results.length === 0) return;
      const mapped = results.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category ?? ("" as WorkCategory),
        status: "active" as const,
        workflowCount: r.workflowCount,
        icon: r.icon,
        stages: r.stages,
        createdAt: r.createdAt,
      }));
      setSopList(mapped);
      setSelectedSopId(mapped[0].id);
    }).catch(() => {
      setSelectedSopId(FALLBACK_SOP_LIST[0].id);
    });
  }, []);

  const refreshWorkflowRunMap = useCallback(async (sops: Pick<SopItem, "id">[]) => {
    if (sops.length === 0) {
      setWorkflowRunMap({});
      return;
    }
    const entries = await Promise.all(
      sops.map(async (sop) => {
        try {
          const run = await window.electron.workflowGetRun(sop.id);
          return [sop.id, run] as const;
        } catch {
          return [sop.id, null] as const;
        }
      }),
    );
    setWorkflowRunMap(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void refreshWorkflowRunMap(sopList);
  }, [refreshWorkflowRunMap, sopList]);

  // Load installed Skills and MCPs once on mount
  useEffect(() => {
    const loadSkillCatalog = typeof window.electron.skillCatalog === "function"
      ? window.electron.skillCatalog()
      : Promise.resolve<SkillCatalogData>({ skills: [], categories: [] });

    Promise.all([
      window.electron.getClaudeConfig(),
      loadSkillCatalog,
    ]).then(([claudeConfig, catalog]) => {
      // Build lookup maps from catalog
      const catalogMap = new Map(catalog.skills.map((s) => [s.name, s]));
      const categoryMap = new Map(catalog.categories.map((c) => [c.id, c.label]));

      // Build skill options from installed skills, enriched with catalog metadata
      const skillOptions: ToolOption[] = claudeConfig.skills
        .filter((s) => s.name && !s.name.startsWith("."))
        .map((s) => {
          const entry = catalogMap.get(s.name);
          const groupId = entry?.category ?? "other";
          return {
            value: s.name,
            group: categoryMap.get(groupId) ?? "其他",
            desc: entry?.description ?? s.description ?? "",
          };
        })
        .sort((a, b) => a.group.localeCompare(b.group, "zh"));
      setInstalledSkillOptions(skillOptions);

      // Build MCP options from installed MCPs, enriched with known catalog
      const mcpOptions: ToolOption[] = claudeConfig.mcpServers.map((m) => {
        const known = MCP_OPTIONS.find((o) => o.value === m.name);
        return {
          value: m.name,
          group: known?.group ?? "已安装",
          desc: known?.desc ?? (m.command ? `${m.command} ${(m.args ?? []).slice(0, 2).join(" ")}`.trim() : ""),
        };
      });
      // Merge with known MCP catalog entries not yet installed (as reference)
      setInstalledMcpOptions(mcpOptions.length > 0 ? mcpOptions : MCP_OPTIONS);
    }).catch(() => {
      // Fallback to static lists if IPC fails (e.g. in dev/mock)
      setInstalledSkillOptions(TOOL_OPTIONS);
      setInstalledMcpOptions(MCP_OPTIONS);
    });
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = () => setMenuOpenId(null);
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpenId]);

  // Load workflow run for the selected SOP and subscribe to changes
  useEffect(() => {
    window.electron.workflowGetRun(selectedSopId).then(setWorkflowRun).catch(() => setWorkflowRun(null));
    setShowCheckPanel(false);
    const unsub = window.electron.onWorkflowRunChanged((sopId: string) => {
      if (sopId === selectedSopId) {
        window.electron.workflowGetRun(sopId).then(setWorkflowRun).catch(() => {});
      }
      window.electron.workflowGetRun(sopId).then((run) => {
        setWorkflowRunMap((prev) => ({ ...prev, [sopId]: run }));
      }).catch(() => {
        setWorkflowRunMap((prev) => ({ ...prev, [sopId]: null }));
      });
    });
    return unsub;
  }, [selectedSopId]);

  const handleExecuteWorkflow = useCallback(async () => {
    try {
      const run = await window.electron.workflowExecute(selectedSopId);
      setWorkflowRun(run);
    } catch (err) {
      console.error("[workflow] Execute failed:", err);
    }
  }, [selectedSopId]);

  const handleExecuteStage = useCallback(async (stageId: string) => {
    try {
      const run = await window.electron.workflowExecuteStage(selectedSopId, stageId);
      setWorkflowRun(run);
    } catch (err) {
      console.error("[workflow] Execute stage failed:", err);
    }
  }, [selectedSopId]);

  const handleScheduleStage = useCallback((stageId: string) => {
    const task = sopSchedules.find((t) => t.stageId === stageId) ?? null;
    setSchedulePopover({ stageId, task });
  }, [sopSchedules]);

  const handleRetryStage = useCallback(async (stageId: string) => {
    try {
      const run = await window.electron.workflowRetryStage(selectedSopId, stageId);
      if (run) setWorkflowRun(run);
    } catch (err) {
      console.error("[workflow] Retry stage failed:", err);
    }
  }, [selectedSopId]);

  const handleDeleteSop = useCallback(async (sopId: string) => {
    setMenuOpenId(null);
    try {
      await window.electron.sopDelete(sopId);
      setSopList((prev) => {
        const next = prev.filter((s) => s.id !== sopId);
        if (selectedSopId === sopId) setSelectedSopId(next[0]?.id ?? "");
        return next;
      });
    } catch (err) {
      console.error("[sop] Delete failed:", err);
    }
  }, [selectedSopId]);

  const handleStartRename = useCallback((sop: SopItem) => {
    setMenuOpenId(null);
    setRenamingId(sop.id);
    setRenameValue(sop.name);
  }, []);

  const handleCommitRename = useCallback(async (sopId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) { setRenamingId(null); return; }
    try {
      const updated = await window.electron.sopRename(sopId, trimmed);
      setSopList((prev) => prev.map((s) =>
        s.id === sopId ? { ...s, name: updated.name } : s,
      ));
    } catch (err) {
      console.error("[sop] Rename failed:", err);
    } finally {
      setRenamingId(null);
    }
  }, [renameValue]);

  const workflowStatus = workflowRun?.status ?? "idle";

  const selectedSop = sopList.find((s) => s.id === selectedSopId) ?? sopList[0];

  const planSummaryBySopKey = useMemo(() => {
    const map = new Map<string, SopPlanSummary>();
    for (const item of planItems) {
      const key = normalizeSopSyncKey(item.sopName);
      const current = map.get(key) ?? { total: 0, failed: 0, inProgress: 0, overdue: 0 };
      current.total += 1;
      if (item.status === "failed") current.failed += 1;
      if (item.status === "in_progress" || item.status === "human_review") current.inProgress += 1;
      if (isPlanItemOverdue(item)) current.overdue += 1;
      map.set(key, current);
    }
    return map;
  }, [planItems]);

  const getPlanSummaryForSop = useCallback((sop: SopItem) => {
    const normalized = normalizeSopSyncKey(sop.name);
    return planSummaryBySopKey.get(normalized) ?? null;
  }, [planSummaryBySopKey]);

  const getSopDisplayStatus = useCallback((sop: SopItem): SopDisplayStatus => {
    if (sop.status === "draft" || sop.status === "paused") return sop.status;

    const planSummary = getPlanSummaryForSop(sop);
    if (planSummary) {
      if (planSummary.failed > 0) return "failed";
      if (planSummary.overdue > 0) return "overdue";
      if (planSummary.inProgress > 0) return "running";
      return "normal";
    }

    const run = workflowRunMap[sop.id];
    if (run?.status === "failed") return "failed";
    if (run?.status === "running") return "running";
    if (run?.status === "completed") return "normal";
    return "pending";
  }, [getPlanSummaryForSop, workflowRunMap]);

  const handleOpenPlanTableClick = useCallback(async () => {
    if (!selectedSop) return;
    setPlanTableOpeningSopId(selectedSop.id);
    try {
      const history = await window.electron.workflowGetHistory(selectedSop.id);
      const sortedRuns = [...history].sort((a, b) => {
        const aTime = new Date(a.startedAt ?? a.completedAt ?? 0).getTime();
        const bTime = new Date(b.startedAt ?? b.completedAt ?? 0).getTime();
        return bTime - aTime;
      });
      if (sortedRuns.length < 2) {
        onOpenPlanTable?.({ sopName: selectedSop.name, sopId: selectedSop.id });
        return;
      }
      setWorkflowHistoryModal({
        sopId: selectedSop.id,
        sopName: selectedSop.name,
        runs: sortedRuns,
      });
    } catch (err) {
      console.error("[sop] Failed to load workflow history:", err);
      emitToast("加载执行历史失败，已直接进入看板", "err");
      onOpenPlanTable?.({ sopName: selectedSop.name, sopId: selectedSop.id });
    } finally {
      setPlanTableOpeningSopId((current) => (current === selectedSop.id ? null : current));
    }
  }, [onOpenPlanTable, selectedSop]);

  const handleOpenWorkflowHistoryRun = useCallback((runId: string) => {
    if (!workflowHistoryModal) return;
    onOpenPlanTable?.({
      sopName: workflowHistoryModal.sopName,
      sopId: workflowHistoryModal.sopId,
      historyRunId: runId,
    });
    setWorkflowHistoryModal(null);
  }, [onOpenPlanTable, workflowHistoryModal]);

  const [selectedCategory, setSelectedCategory] = useState<WorkCategory | "all">("all");

  const categoryStats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const sop of sopList) {
      const cat = sop.category || "";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return CATEGORY_ORDER
      .filter((cat) => counts[cat])
      .map((cat) => ({ category: cat, style: CATEGORY_STYLE[cat] ?? CATEGORY_STYLE[""], count: counts[cat] }));
  }, [sopList]);

  const filteredSops = useMemo(
    () => selectedCategory === "all" ? sopList : sopList.filter((s) => (s.category || "") === selectedCategory),
    [sopList, selectedCategory],
  );

  const lessonData = useMemo(() => buildLessonCycleData(), []);
  const monthlyData = useMemo(() => buildMonthlySettlementData(), []);

  // Use HAND.toml stages if available, otherwise use hardcoded tab data
  const flowData = useMemo(() => {
    if (selectedSop?.stages && selectedSop.stages.length > 0) {
      return buildHandWorkflow(selectedSop.stages);
    }
    return activeWorkflowTab === "lesson_cycle" ? lessonData : monthlyData;
  }, [selectedSop, activeWorkflowTab, lessonData, monthlyData]);

  const hasHandStages = Boolean(selectedSop?.stages && selectedSop.stages.length > 0);

  // Clear overrides and selection when switching SOP or tab
  useEffect(() => {
    setSelectedNodeId(null);
    setNodeOverrides({});
    // Scroll the newly selected item into view
    sopButtonRefs.current[selectedSopId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedSopId, activeWorkflowTab]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === "step") {
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    }
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleNodeEdit = useCallback(
    (nodeId: string, tools: string[], mcp: string[]) => {
      setNodeOverrides((prev) => ({ ...prev, [nodeId]: { tools, mcp } }));
    },
    [],
  );

  // Build a map of stage status from the current workflow run
  const stageStatusMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (workflowRun) {
      for (const s of workflowRun.stages) {
        map[s.stageId] = s.status;
      }
    }
    return map;
  }, [workflowRun]);

  // Merge overrides + workflow status into flow nodes
  const flowNodes = useMemo(
    () =>
      flowData.nodes.map((node) => {
        const ov = nodeOverrides[node.id];
        const stageStatus = stageStatusMap[node.id];
        const extra: Record<string, unknown> = {};
        if (ov) Object.assign(extra, ov);
        if (stageStatus) extra.stageStatus = stageStatus;
        if (hasHandStages && node.type === "step") {
          extra.stageId = node.id;
          extra.onPlayStage = handleExecuteStage;
          extra.onScheduleStage = handleScheduleStage;
          extra.stageHasSchedule = sopSchedules.some((t) => t.stageId === node.id);
        }
        if (Object.keys(extra).length === 0) return node;
        return { ...node, data: { ...node.data, ...extra } };
      }),
    [flowData.nodes, nodeOverrides, stageStatusMap, hasHandStages, handleExecuteStage, handleScheduleStage, sopSchedules],
  );

  const selectedNode = selectedNodeId ? flowNodes.find((n) => n.id === selectedNodeId) : null;
  const selectedNodeData = selectedNode?.data as
    | { label: string; items: string[]; tools: string[]; mcp: string[]; color: string; bgColor: string }
    | undefined;

  const onNodesChange = useCallback(() => {}, []);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-surface-cream"
      style={{ top: `${titleBarHeight}px` }}
    >
      {/* ═══ Header ═══ */}
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
            onClick={onClose}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-ink-700 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
        </div>

        <div className="w-4" />
      </header>

      {/* ═══ Main Content ═══ */}
      <div className="flex flex-1 min-h-0 p-4 gap-3">

        {/* ═══ Left: Category Column + SOP List ═══ */}
        <div className="shrink-0 flex rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden">

          {/* Category filter column */}
          <div className="w-[52px] shrink-0 flex flex-col items-center border-r border-ink-900/5 py-2 gap-0.5">
            {/* All */}
            <button
              onClick={() => setSelectedCategory("all")}
              className={`flex flex-col items-center justify-center gap-1 w-10 py-2 rounded-xl transition-all ${
                selectedCategory === "all"
                  ? "bg-accent/10 text-accent"
                  : "text-muted hover:bg-ink-900/[0.04] hover:text-ink-600"
              }`}
              title="全部"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="1.5" y="2.5" width="5" height="5" rx="1" />
                <rect x="9.5" y="2.5" width="5" height="5" rx="1" />
                <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
                <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
              </svg>
              <span className="text-[8px] font-medium leading-none">全部</span>
            </button>

            <div className="w-5 border-t border-ink-900/6 my-1" />

            {categoryStats.map((cat) => {
              const isActive = selectedCategory === cat.category;
              return (
                <button
                  key={cat.category}
                  onClick={() => setSelectedCategory(cat.category)}
                  className={`flex flex-col items-center justify-center gap-1 w-10 py-2 rounded-xl transition-all ${
                    isActive
                      ? "text-ink-800"
                      : "text-muted hover:bg-ink-900/[0.04] hover:text-ink-600"
                  }`}
                  style={isActive ? { backgroundColor: `${cat.style.color}12` } : undefined}
                  title={cat.style.label}
                >
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full transition-transform ${isActive ? "scale-110" : ""}`}
                    style={{ backgroundColor: cat.style.color, opacity: isActive ? 1 : 0.5 }}
                  />
                  <span className="text-[8px] font-medium leading-none truncate max-w-[40px]">
                    {cat.style.label.slice(0, 2)}
                  </span>
                </button>
              );
            })}

          </div>

          {/* SOP list column */}
          <div className="w-[200px] flex flex-col overflow-hidden">
            <div
              className="flex-1 overflow-y-auto px-1.5 py-1.5"
              style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
            >
              {filteredSops.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
                  <span className="text-[10px] text-muted/60">暂无流程</span>
                </div>
              )}
              {filteredSops.map((sop) => {
                const isSelected = sop.id === selectedSopId;
                const planSummary = getPlanSummaryForSop(sop);
                const statusCfg = STATUS_CONFIG[getSopDisplayStatus(sop)];
                const isRenaming = renamingId === sop.id;
                const menuOpen = menuOpenId === sop.id;
                const isPlaceholder = sop.id.startsWith("_creating_");
                const createdStr = sop.createdAt
                  ? new Date(sop.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
                  : null;
                return (
                  <div
                    key={sop.id}
                    ref={(el) => { sopButtonRefs.current[sop.id] = el as unknown as HTMLButtonElement; }}
                    className={`group relative w-full text-left px-2.5 py-2 rounded-xl transition-all mb-0.5 cursor-pointer ${
                      isSelected
                        ? "bg-accent/8 shadow-[inset_0_0_0_1px_rgba(44,95,47,0.15)]"
                        : "hover:bg-ink-900/[0.03]"
                    }`}
                    onClick={() => !isRenaming && setSelectedSopId(sop.id)}
                  >
                    <div className="flex items-start gap-2">
                      {sop.icon ? (
                        <span className="text-[13px] leading-none mt-0.5 shrink-0">{sop.icon}</span>
                      ) : (
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-bold text-white shrink-0 mt-0.5"
                          style={{ backgroundColor: (CATEGORY_STYLE[sop.category] ?? CATEGORY_STYLE[""]).color }}
                        >
                          {sop.name.slice(0, 1)}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleCommitRename(sop.id);
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            onBlur={() => handleCommitRename(sop.id)}
                            className="w-full text-[11.5px] font-medium text-accent bg-transparent border-b border-accent/40 outline-none leading-snug"
                          />
                        ) : (
                          <span className={`text-[11.5px] font-medium leading-snug truncate block ${
                            isSelected ? "text-accent" : "text-ink-800"
                          }`}>
                            {sop.name}
                          </span>
                        )}
                        <p className="text-[10px] text-muted/70 leading-snug truncate mt-0.5">{sop.description}</p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className={`inline-flex items-center gap-1 text-[9px] font-medium ${statusCfg.color}`}>
                            <span className={`inline-block h-1 w-1 rounded-full ${statusCfg.dot}`} />
                            {statusCfg.label}
                          </span>
                          <span className="text-[9px] text-muted/40">·</span>
                          <span className="text-[9px] text-muted/60">
                            {planSummary?.total ? `${planSummary.total} 项` : `${sop.workflowCount} 阶段`}
                          </span>
                          {createdStr && (
                            <>
                              <span className="text-[9px] text-muted/40">·</span>
                              <span className="text-[9px] text-muted/50">{createdStr}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Context menu trigger */}
                    {!isPlaceholder && !isRenaming && (
                      <div className="absolute top-1.5 right-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(menuOpen ? null : sop.id);
                          }}
                          className={`flex items-center justify-center h-5 w-5 rounded-md transition-all text-muted hover:text-ink-700 hover:bg-ink-900/8 ${
                            menuOpen ? "opacity-100 bg-ink-900/8" : "opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
                            <circle cx="8" cy="3" r="1.2" />
                            <circle cx="8" cy="8" r="1.2" />
                            <circle cx="8" cy="13" r="1.2" />
                          </svg>
                        </button>

                        {/* Dropdown menu */}
                        {menuOpen && (
                          <div
                            className="absolute right-0 top-6 w-28 rounded-xl bg-surface border border-ink-900/10 shadow-lg overflow-hidden z-50"
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStartRename(sop); }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-ink-700 hover:bg-surface-secondary transition-colors"
                            >
                              <svg viewBox="0 0 14 14" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M10 2.5l1.5 1.5-7 7H3V9.5l7-7z" />
                              </svg>
                              重命名
                            </button>
                            <div className="border-t border-ink-900/5" />
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`确认删除「${sop.name}」？此操作不可撤销。`)) {
                                  handleDeleteSop(sop.id);
                                } else {
                                  setMenuOpenId(null);
                                }
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-red-600 hover:bg-red-50 transition-colors"
                            >
                              <svg viewBox="0 0 14 14" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M2 3.5h10M5 3.5V2.5h4v1M5.5 6v4M8.5 6v4M3 3.5l.5 8h7l.5-8" />
                              </svg>
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bottom actions */}
            <div className="shrink-0 border-t border-ink-900/5 px-1.5 py-1.5 flex flex-col gap-1">
              <button
                onClick={() => setShowCreateModal(true)}
                className="w-full flex items-center gap-2 rounded-xl px-2.5 py-2 text-[11px] font-medium text-muted hover:text-ink-700 hover:bg-ink-900/[0.04] transition-colors"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                新建流程
              </button>
              <button
                onClick={() => setShowStore(true)}
                className="w-full flex items-center gap-2 rounded-xl px-2.5 py-2 text-[11px] font-medium text-muted hover:text-ink-700 hover:bg-ink-900/[0.04] transition-colors"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                流程商店
              </button>
            </div>
          </div>
        </div>

        {/* ═══ Right: Visual Workflow Canvas ═══ */}
        <div className="flex-1 flex flex-col rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-end px-4 pt-2.5 pb-2 border-b border-ink-900/5 shrink-0">
            <div className="flex items-center gap-2">
              {hasHandStages && (
                <WorkflowActionButton
                  status={workflowStatus}
                  onExecute={handleExecuteWorkflow}
                  onCheck={() => setShowCheckPanel(true)}
                />
              )}
              {/* Whole-SOP schedule button */}
              {hasHandStages && (() => {
                const task = sopSchedules.find((t) => !t.stageId) ?? null;
                return (
                  <button
                    ref={sopScheduleBtnRef}
                    onClick={() => setSchedulePopover({ stageId: undefined, task })}
                    className={`flex items-center justify-center h-8 w-8 rounded-xl border shadow-soft transition-colors ${
                      task
                        ? "border-violet-400/40 bg-violet-50 text-violet-600 hover:bg-violet-100"
                        : "border-ink-900/8 bg-surface text-ink-500 hover:bg-surface-secondary hover:text-ink-700"
                    }`}
                    title={task ? `整体定时：${task.scheduleType === "daily" ? task.dailyTime : `每${task.intervalValue}${task.intervalUnit}`}` : "设置整体 SOP 定时触发"}
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill={task ? "currentColor" : "none"} stroke={task ? "none" : "currentColor"} strokeWidth="1.5">
                      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-3.5a.75.75 0 0 1 .75.75v3.19l1.53 1.53a.75.75 0 0 1-1.06 1.06l-1.75-1.75A.75.75 0 0 1 7.25 9V5.25A.75.75 0 0 1 8 4.5Z"/>
                    </svg>
                  </button>
                );
              })()}
              <button
                onClick={() => void handleOpenPlanTableClick()}
                disabled={!selectedSop || planTableOpeningSopId === selectedSop.id}
                className="flex items-center justify-center h-8 w-8 rounded-xl border border-ink-900/8 bg-surface text-ink-500 shadow-soft hover:bg-surface-secondary hover:text-ink-700 transition-colors disabled:opacity-60 disabled:cursor-wait"
                title="计划表"
              >
                {planTableOpeningSopId === selectedSop?.id ? (
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                    <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* React Flow Canvas */}
          <div className="flex-1 relative" style={{ minHeight: 0 }}>
            {/* Creating overlay */}
            {creatingId && selectedSopId === creatingId && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-cream/80 backdrop-blur-[2px]">
                <svg className="h-6 w-6 animate-spin text-accent mb-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-[13px] font-medium text-ink-700">正在生成工作流程…</span>
                <span className="text-[11px] text-muted mt-1">AI 正在设计流程图和执行计划</span>
                <button
                  onClick={async () => {
                    await window.electron.sopGenerateCancel?.();
                    setCreatingId(null);
                    setSopList((prev) => prev.filter((s) => s.id !== creatingId));
                    setSelectedSopId(sopList.find((s) => s.id !== creatingId)?.id ?? "");
                  }}
                  className="mt-4 px-3 py-1.5 rounded-lg text-[12px] text-ink-500 border border-ink-900/10 bg-surface hover:bg-surface-secondary hover:text-ink-700 transition-colors"
                >
                  取消
                </button>
              </div>
            )}
            <ReactFlow
              key={`${selectedSopId}-${hasHandStages ? "hand" : activeWorkflowTab}`}
              nodes={flowNodes}
              edges={flowData.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={handleNodeClick}
              onPaneClick={handlePaneClick}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{
                type: "smoothstep",
                style: EDGE_STYLE,
                markerEnd: EDGE_MARKER,
              }}
              minZoom={0.3}
              maxZoom={2}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#D1D1CC" />
              <MiniMap
                nodeStrokeWidth={2}
                pannable={false}
                zoomable={false}
                style={{ border: "1px solid var(--color-bg-400)", borderRadius: 8, background: "var(--color-surface-cream)" }}
              />
              <Controls
                showInteractive={false}
                style={{ border: "1px solid #E5E4DF", borderRadius: 8, background: "#FFFFFF", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
              />
            </ReactFlow>

            {/* Workflow check panel */}
            {showCheckPanel && workflowRun && (
              <WorkflowCheckPanel
                run={workflowRun}
                onClose={() => setShowCheckPanel(false)}
                onRetryStage={handleRetryStage}
                onReExecute={handleExecuteWorkflow}
                onNavigateToSession={onNavigateToSession
                  ? (sessionId) => {
                    onClose();
                    onNavigateToSession(sessionId);
                  }
                  : undefined
                }
              />
            )}

            {/* Node edit side panel */}
            {selectedNodeId && selectedNodeData && !showCheckPanel && (
              <NodeEditPanel
                label={selectedNodeData.label}
                color={selectedNodeData.color}
                tools={selectedNodeData.tools}
                mcp={selectedNodeData.mcp}
                skillOptions={installedSkillOptions.length > 0 ? installedSkillOptions : TOOL_OPTIONS}
                mcpOptions={installedMcpOptions.length > 0 ? installedMcpOptions : MCP_OPTIONS}
                onClose={() => setSelectedNodeId(null)}
                onChangeTools={(tools) => handleNodeEdit(selectedNodeId, tools, selectedNodeData.mcp)}
                onChangeMcp={(mcp) => handleNodeEdit(selectedNodeId, selectedNodeData.tools, mcp)}
              />
            )}
          </div>
        </div>
        {/* End Right Canvas */}

      </div>
      {/* End Main Content */}

      {/* ═══ SOP Schedule Popover ═══ */}
      {schedulePopover && (
        <SopSchedulePopover
          anchorRef={schedulePopover.stageId ? { current: null } : sopScheduleBtnRef}
          sopId={selectedSopId}
          stageId={schedulePopover.stageId}
          existingTask={schedulePopover.task}
          onClose={() => setSchedulePopover(null)}
          onChanged={() => { setSchedulePopover(null); loadSopSchedules(); }}
        />
      )}

      {workflowHistoryModal && (
        <WorkflowHistoryPickerModal
          sopName={workflowHistoryModal.sopName}
          runs={workflowHistoryModal.runs}
          onClose={() => setWorkflowHistoryModal(null)}
          onSelectRun={handleOpenWorkflowHistoryRun}
        />
      )}

      {/* ═══ Create SOP Modal ═══ */}
      {showCreateModal && (
        <CreateSopModal
          onClose={() => setShowCreateModal(false)}
          onCreate={(result) => {
            const newItem: SopItem = {
              id: result.id,
              name: result.name,
              description: result.description,
              category: result.category ?? ("" as WorkCategory),
              status: "active",
              workflowCount: result.workflowCount,
              icon: result.icon,
              stages: result.stages,
            };
            setSopList((prev) => [newItem, ...prev.filter((s) => s.id !== result.id)]);
            setSelectedSopId(result.id);
            setShowCreateModal(false);
          }}
        />
      )}

      {/* ═══ Workflow Store ═══ */}
      {showStore && (
        <WorkflowStore
          titleBarHeight={titleBarHeight}
          onClose={() => setShowStore(false)}
          onUseTemplate={async (prompt, templateName, templateCategory) => {
            const placeholderId = `_creating_${Date.now()}`;
            const placeholder: SopItem = {
              id: placeholderId,
              name: templateName,
              description: "正在生成…",
              category: templateCategory,
              status: "draft",
              workflowCount: 0,
              icon: "",
              stages: [],
            };
            setShowStore(false);
            setSopList((prev) => [placeholder, ...prev]);
            setSelectedSopId(placeholderId);
            setCreatingId(placeholderId);
            try {
              const result = await window.electron.sopGenerate(prompt);
              const newItem: SopItem = {
                id: result.id,
                name: result.name,
                description: result.description,
                category: result.category ?? ("" as WorkCategory),
                status: "active",
                workflowCount: result.workflowCount,
                icon: result.icon,
                stages: result.stages,
              };
              setSopList((prev) => [newItem, ...prev.filter((s) => s.id !== placeholderId && s.id !== result.id)]);
              setSelectedSopId(result.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "生成失败，请重试";
              console.error("[store] Template creation failed:", err);
              setSopList((prev) => prev.filter((s) => s.id !== placeholderId));
              setSelectedSopId(sopList[0]?.id ?? "");
              if (msg !== "生成已取消") emitToast(msg, "err");
            } finally {
              setCreatingId(null);
            }
          }}
        />
      )}
    </div>
  );
}

// ═══ Workflow Action Button (Execute / Check merged) ═══

function WorkflowActionButton({
  status,
  onExecute,
  onCheck,
}: {
  status: WorkflowStatus;
  onExecute: () => void;
  onCheck: () => void;
}) {
  if (status === "running") {
    return (
      <button
        disabled
        className="flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-[11px] font-medium text-blue-600 cursor-not-allowed"
      >
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        运行中...
      </button>
    );
  }

  if (status === "completed") {
    return (
      <button
        onClick={onCheck}
        className="flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
      >
        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7l3 3 5-6" />
        </svg>
        检查结果
      </button>
    );
  }

  if (status === "failed") {
    return (
      <button
        onClick={onCheck}
        className="flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-medium text-red-600 hover:bg-red-100 transition-colors"
      >
        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 4l6 6M10 4l-6 6" />
        </svg>
        检查问题
      </button>
    );
  }

  // idle
  return (
    <button
      onClick={onExecute}
      className="flex items-center gap-1.5 rounded-xl border border-accent/20 bg-accent/8 px-3 py-1.5 text-[11px] font-medium text-accent hover:bg-accent/15 transition-colors"
    >
      <svg viewBox="0 0 14 14" className="h-3 w-3" fill="currentColor">
        <path d="M3.5 1.5v11l9-5.5-9-5.5z" />
      </svg>
      执行
    </button>
  );
}

// ═══ Workflow Check Panel ═══

function formatDuration(ms?: number): string {
  if (!ms) return "--";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remaining = s % 60;
  return `${m}m ${remaining.toString().padStart(2, "0")}s`;
}

function WorkflowCheckPanel({
  run,
  onClose,
  onRetryStage,
  onReExecute,
  onNavigateToSession,
}: {
  run: WorkflowRun;
  onClose: () => void;
  onRetryStage: (stageId: string) => void;
  onReExecute: () => void;
  onNavigateToSession?: (sessionId: string) => void;
}) {
  const [expandedStages, setExpandedStages] = useState<Record<string, "input" | "output" | null>>({});

  const toggleExpand = (stageId: string, section: "input" | "output") => {
    setExpandedStages((prev) => ({
      ...prev,
      [stageId]: prev[stageId] === section ? null : section,
    }));
  };

  const completedCount = run.stages.filter((s) => s.status === "completed").length;
  const failedCount = run.stages.filter((s) => s.status === "failed").length;
  const totalDuration = run.startedAt && run.completedAt
    ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
    : run.startedAt
    ? Date.now() - new Date(run.startedAt).getTime()
    : 0;

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-[320px] flex flex-col bg-surface border-l border-ink-900/10 shadow-2xl z-10"
      style={{ borderTopRightRadius: "1rem", borderBottomRightRadius: "1rem" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-900/8 shrink-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[13px] font-semibold text-ink-800">Workflow 执行检查</span>
          <div className="flex items-center gap-2 text-[10px] text-muted">
            {run.startedAt && (
              <span>{new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
            )}
            <span>|</span>
            <span>{formatDuration(totalDuration)}</span>
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

      {/* Summary bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-ink-900/5 text-[10px] shrink-0">
        {completedCount > 0 && (
          <span className="flex items-center gap-1 text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {completedCount} 完成
          </span>
        )}
        {failedCount > 0 && (
          <span className="flex items-center gap-1 text-red-600">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {failedCount} 失败
          </span>
        )}
        {run.stages.filter((s) => s.status === "pending").length > 0 && (
          <span className="flex items-center gap-1 text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />
            {run.stages.filter((s) => s.status === "pending").length} 等待
          </span>
        )}
      </div>

      {/* Stage list */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
      >
        {run.stages.map((stage) => {
          const expanded = expandedStages[stage.stageId];
          const statusColor = stage.status === "completed" ? "#16A34A"
            : stage.status === "failed" ? "#DC2626"
            : stage.status === "in_progress" ? "#3B82F6"
            : "#9CA3AF";
          const statusIcon = stage.status === "completed" ? "✓"
            : stage.status === "failed" ? "✗"
            : stage.status === "in_progress" ? "●"
            : "○";

          return (
            <div
              key={stage.stageId}
              className="rounded-xl border border-ink-900/8 bg-surface overflow-hidden"
            >
              {/* Stage header */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span
                  className={`text-[11px] font-bold ${stage.status === "in_progress" ? "animate-pulse" : ""}`}
                  style={{ color: statusColor }}
                >
                  {statusIcon}
                </span>
                <span className="text-[11px] font-medium text-ink-800 flex-1 min-w-0 truncate">
                  {stage.label}
                </span>
                <span className="text-[9px] text-muted shrink-0">
                  {formatDuration(stage.duration)}
                </span>
              </div>

              {/* Error display */}
              {stage.error && (
                <div className="mx-3 mb-2 rounded-lg bg-red-50 border border-red-100 px-2.5 py-2 text-[10px] text-red-600 leading-relaxed">
                  {stage.error}
                </div>
              )}

              {/* Expandable sections */}
              <div className="flex items-center gap-1 px-3 pb-2">
                {stage.inputPrompt && (
                  <button
                    onClick={() => toggleExpand(stage.stageId, "input")}
                    className={`text-[9px] px-2 py-0.5 rounded-md transition-colors ${
                      expanded === "input"
                        ? "bg-accent/10 text-accent"
                        : "text-muted hover:bg-ink-900/5"
                    }`}
                  >
                    输入
                  </button>
                )}
                {stage.output && (
                  <button
                    onClick={() => toggleExpand(stage.stageId, "output")}
                    className={`text-[9px] px-2 py-0.5 rounded-md transition-colors ${
                      expanded === "output"
                        ? "bg-accent/10 text-accent"
                        : "text-muted hover:bg-ink-900/5"
                    }`}
                  >
                    输出
                  </button>
                )}
                <div className="flex-1" />
                {stage.sessionId && (
                  <button
                    className="text-[9px] text-accent hover:underline"
                    onClick={() => onNavigateToSession?.(stage.sessionId!)}
                  >
                    会话 →
                  </button>
                )}
                {stage.status === "failed" && (
                  <button
                    onClick={() => onRetryStage(stage.stageId)}
                    className="text-[9px] text-red-600 hover:text-red-700 font-medium"
                  >
                    重试
                  </button>
                )}
              </div>

              {/* Expanded content */}
              {expanded && (
                <div className="mx-3 mb-2.5 rounded-lg bg-surface-secondary border border-ink-900/5 overflow-hidden">
                  <pre
                    className="text-[9px] text-ink-600 leading-relaxed p-2.5 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto"
                    style={{ scrollbarWidth: "thin" }}
                  >
                    {expanded === "input" ? stage.inputPrompt : stage.output}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2.5 border-t border-ink-900/6 shrink-0">
        <button
          onClick={() => { onClose(); onReExecute(); }}
          className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-accent/20 bg-accent/8 px-3 py-2 text-[11px] font-medium text-accent hover:bg-accent/15 transition-colors"
        >
          <svg viewBox="0 0 14 14" className="h-3 w-3" fill="currentColor">
            <path d="M3.5 1.5v11l9-5.5-9-5.5z" />
          </svg>
          重新执行全部
        </button>
      </div>
    </div>
  );
}

// ═══ Tag Editor (reusable picker for Skills / MCP) ═══

function TagEditor({
  label,
  icon,
  items,
  options,
  badgeStyle,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  items: string[];
  options: ToolOption[];
  badgeStyle: { backgroundColor: string; color: string };
  onChange: (items: string[]) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showPicker) return;
    // Auto-focus search when picker opens
    setTimeout(() => searchRef.current?.focus(), 30);
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (pickerRef.current && !pickerRef.current.contains(target)) {
        setShowPicker(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  const available = options.filter((o) => !items.includes(o.value));

  // Filter by search query
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? available.filter(
        (o) =>
          o.value.toLowerCase().includes(q) ||
          o.desc.toLowerCase().includes(q) ||
          o.group.toLowerCase().includes(q),
      )
    : available;

  // When searching show flat "搜索结果" group, otherwise show by category
  const groups: Record<string, ToolOption[]> = q
    ? { "搜索结果": filtered }
    : filtered.reduce<Record<string, ToolOption[]>>((acc, opt) => {
        (acc[opt.group] ??= []).push(opt);
        return acc;
      }, {});

  const descOf = (val: string) => options.find((o) => o.value === val)?.desc ?? "";

  const addItem = (val: string) => {
    if (!items.includes(val)) onChange([...items, val]);
  };
  const removeItem = (val: string) => onChange(items.filter((i) => i !== val));
  const addCustom = () => {
    const v = customInput.trim();
    if (v) { addItem(v); setCustomInput(""); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[11px] font-semibold text-ink-600">{label}</span>
          <span className="text-[10px] text-muted bg-ink-900/5 rounded-full px-1.5 py-px">{items.length}</span>
        </div>
        <button
          onClick={() => setShowPicker((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover px-2 py-0.5 rounded-lg hover:bg-accent/8 transition-colors"
        >
          <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 2v10M2 7h10" />
          </svg>
          添加
        </button>
      </div>

      {/* Current items — card style with description */}
      <div className="flex flex-col gap-1 min-h-[22px] mb-1.5">
        {items.map((item) => {
          const desc = descOf(item);
          return (
            <div
              key={item}
              className="group flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
              style={{ backgroundColor: badgeStyle.backgroundColor }}
            >
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-mono font-medium leading-tight" style={{ color: badgeStyle.color }}>
                  {item}
                </span>
                {desc && (
                  <span className="text-[9px] text-muted/70 leading-tight mt-0.5">{desc}</span>
                )}
              </div>
              <button
                onClick={() => removeItem(item)}
                className="opacity-30 group-hover:opacity-80 rounded hover:bg-red-100 hover:text-red-600 p-0.5 shrink-0 transition-all"
              >
                <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 2l6 6M8 2l-6 6" />
                </svg>
              </button>
            </div>
          );
        })}
        {items.length === 0 && (
          <span className="text-[10px] text-muted/60 italic px-1">暂未配置</span>
        )}
      </div>

      {/* Picker dropdown — grouped with search and descriptions */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="mt-1 rounded-xl border border-ink-900/10 bg-surface shadow-lg overflow-hidden flex flex-col"
          style={{ maxHeight: 300 }}
        >
          {/* Search input */}
          <div className="px-3 pt-2 pb-1.5 border-b border-ink-900/6 shrink-0">
            <div className="flex items-center gap-1.5 rounded-lg bg-surface-secondary px-2.5 py-1.5">
              <svg viewBox="0 0 14 14" className="h-3 w-3 text-muted shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="5.5" cy="5.5" r="3.5" />
                <path d="M8.5 8.5l3 3" />
              </svg>
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setShowPicker(false); setSearchQuery(""); } }}
                placeholder="搜索名称或描述…"
                className="flex-1 text-[10px] bg-transparent outline-none text-ink-700 placeholder:text-muted/50 min-w-0"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} className="text-muted/60 hover:text-muted transition-colors shrink-0">
                  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 2l6 6M8 2l-6 6" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Options list */}
          <div style={{ overflowY: "auto", scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}>
            {Object.entries(groups).length > 0 ? (
              Object.entries(groups).map(([group, opts]) => (
                <div key={group}>
                  <div className="px-3 py-1.5 text-[8px] font-semibold text-muted/60 bg-surface-secondary uppercase tracking-wider sticky top-0 border-b border-ink-900/5 z-10">
                    {group} <span className="font-normal normal-case opacity-60">({opts.length})</span>
                  </div>
                  {opts.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { addItem(opt.value); setShowPicker(false); setSearchQuery(""); }}
                      className="w-full text-left px-3 py-2 hover:bg-surface-secondary transition-colors border-b border-ink-900/4 last:border-0"
                    >
                      <div className="text-[10px] font-mono font-medium text-ink-700 leading-tight">{opt.value}</div>
                      {opt.desc && <div className="text-[9px] text-muted mt-0.5 leading-tight">{opt.desc}</div>}
                    </button>
                  ))}
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-[10px] text-muted italic text-center">
                {q ? `没有匹配"${q}"的选项` : "所有选项已添加"}
              </div>
            )}
          </div>

          {/* Custom input footer */}
          <div className="flex items-center gap-2 border-t border-ink-900/8 px-3 py-2 bg-surface shrink-0">
            <input
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { addCustom(); setShowPicker(false); setSearchQuery(""); } }}
              placeholder="输入自定义名称…"
              className="flex-1 text-[10px] font-mono bg-transparent outline-none text-ink-700 placeholder:text-muted/40"
            />
            <button
              onClick={() => { addCustom(); setShowPicker(false); setSearchQuery(""); }}
              disabled={!customInput.trim()}
              className="text-[10px] text-accent hover:text-accent-hover disabled:opacity-30 transition-colors shrink-0"
            >
              ↵ 添加
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowHistoryPickerModal({
  sopName,
  runs,
  onClose,
  onSelectRun,
}: {
  sopName: string;
  runs: WorkflowRun[];
  onClose: () => void;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: "rgba(15, 23, 42, 0.32)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[640px] max-w-[calc(100vw-32px)] max-h-[80vh] flex flex-col rounded-3xl border border-ink-900/8 bg-surface shadow-xl overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-900/6 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-800">选择执行历史</h2>
            <p className="mt-1 text-[12px] text-muted leading-relaxed">
              {sopName} 已有多次执行记录，先选择一条历史，再进入对应的 Kanban 快照。
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors shrink-0"
            aria-label="关闭执行历史"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto px-5 py-4"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
        >
          <div className="flex flex-col gap-3">
            {runs.map((run) => {
              const statusMeta = getWorkflowRunStatusMeta(run.status);
              const durationLabel = formatWorkflowRunDuration(run);
              const preview = getWorkflowRunPreview(run);
              const finishedAt = run.completedAt ? formatWorkflowHistoryTimestamp(run.completedAt) : null;
              return (
                <button
                  key={run.id}
                  onClick={() => onSelectRun(run.id)}
                  className="group w-full rounded-2xl border border-ink-900/8 bg-surface-secondary/35 px-4 py-3 text-left hover:border-accent/30 hover:bg-accent/5 transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${statusMeta.className}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClassName}`} />
                          {statusMeta.label}
                        </span>
                        <span className="text-[12px] font-medium text-ink-700 tabular-nums">
                          开始于 {formatWorkflowHistoryTimestamp(run.startedAt)}
                        </span>
                        {durationLabel && (
                          <span className="text-[11px] text-muted">{durationLabel}</span>
                        )}
                        {finishedAt && (
                          <span className="text-[11px] text-muted">结束于 {finishedAt}</span>
                        )}
                      </div>
                      <p className="mt-2 text-[12px] text-ink-700 leading-relaxed line-clamp-2">
                        {preview}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-ink-900/5 p-2 text-muted group-hover:bg-accent/10 group-hover:text-accent transition-colors">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M5 12h14M13 5l7 7-7 7" />
                      </svg>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ Node Edit Panel ═══

function NodeEditPanel({
  label,
  color,
  tools,
  mcp,
  skillOptions,
  mcpOptions,
  onClose,
  onChangeTools,
  onChangeMcp,
}: {
  label: string;
  color: string;
  tools: string[];
  mcp: string[];
  skillOptions: ToolOption[];
  mcpOptions: ToolOption[];
  onClose: () => void;
  onChangeTools: (tools: string[]) => void;
  onChangeMcp: (mcp: string[]) => void;
}) {
  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-[260px] flex flex-col bg-surface border-l border-ink-900/10 shadow-2xl z-10"
      style={{ borderTopRightRadius: "1rem", borderBottomRightRadius: "1rem" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-900/8 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-[13px] font-semibold text-ink-800 truncate">{label}</span>
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

      {/* Hint */}
      <div className="px-4 pt-3 pb-0">
        <p className="text-[10px] text-muted/70 leading-relaxed">
          点击「添加」从列表中选择，或输入自定义名称。改动实时更新节点显示。
        </p>
      </div>

      {/* Body */}
      <div
        className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-5"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
      >
        {/* Skills */}
        <TagEditor
          label="Skills"
          icon={
            <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color }}>
              <path d="M11 3a2.5 2.5 0 0 0-3.5 2.2v.3L3.5 9.5a1.2 1.2 0 1 0 1.7 1.7L9.5 7h.3A2.5 2.5 0 0 0 12 3.5l-1.5 1.5-1-1 1.5-1z" />
            </svg>
          }
          items={tools}
          options={skillOptions}
          badgeStyle={{ backgroundColor: `${color}18`, color }}
          onChange={onChangeTools}
        />

        <div className="border-t border-ink-900/6" />

        {/* MCP */}
        <TagEditor
          label="MCP"
          icon={
            <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 text-teal-600" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="2.5" />
              <path d="M7 1v2.5M7 10.5V13M1 7h2.5M10.5 7H13" />
              <path d="M3.4 3.4l1.8 1.8M8.8 8.8l1.8 1.8M8.8 5.2l1.8-1.8M3.4 10.6l1.8-1.8" />
            </svg>
          }
          items={mcp}
          options={mcpOptions}
          badgeStyle={{ backgroundColor: "#CCFBF180", color: "#0F766E" }}
          onChange={onChangeMcp}
        />
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-ink-900/6 shrink-0">
        <p className="text-[9px] text-muted/50 text-center">更改实时生效 · 重新加载 SOP 后重置</p>
      </div>
    </div>
  );
}

// ═══ Create SOP Modal ═══

function CreateSopModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (result: HandSopResult) => void;
}) {
  const [sopName, setSopName] = useState("");
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const handleGenerate = async () => {
    const trimmed = desc.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    const trimmedName = sopName.trim();
    const nameLine = trimmedName ? `\n## 指定名称\nSOP 的 name 字段必须为："${trimmedName}"\n\n` : "";
    try {
      const result = await window.electron.sopGenerate(`${nameLine}${trimmed}`);
      onCreate(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "生成失败，请重试";
      if (msg !== "生成已取消") setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (loading) {
      await window.electron.sopGenerateCancel?.();
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
    >
      <div className="w-[520px] rounded-2xl bg-surface shadow-xl border border-ink-900/8 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-900/5">
          <div>
            <h2 className="text-sm font-semibold text-ink-800">新建工作流程</h2>
            <p className="text-[11px] text-muted mt-0.5">用自然语言描述你的工作流程，AI 将自动生成流程图和执行计划</p>
          </div>
          <button
            onClick={handleCancel}
            className="text-muted hover:text-ink-700 transition-colors p-1 rounded-lg hover:bg-ink-900/5"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-3">
          <div>
            <label className="text-[10px] text-muted font-medium mb-1.5 block">流程名称</label>
            <input
              ref={nameRef}
              value={sopName}
              onChange={(e) => setSopName(e.target.value)}
              disabled={loading}
              placeholder="留空由 AI 自动生成"
              className="w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-2.5 text-[13px] font-medium text-ink-800 placeholder:text-muted/40 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate();
              }}
            />
          </div>

          <div>
            <label className="text-[10px] text-muted font-medium mb-1.5 block">流程描述</label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              disabled={loading}
              placeholder={"例如：每周 VIP 客户跟进流程 — 周一发送学习资料和上课提醒，周三确认作业完成情况，周五整理老师反馈并归档，月底生成学习进度报告发给家长"}
              className="w-full h-28 rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-3 text-sm text-ink-800 placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all disabled:opacity-60"
              style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate();
              }}
            />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[11px] text-red-600">
              {error}
            </div>
          )}

          <p className="text-[10px] text-muted/60">
            描述越详细，生成质量越高 · {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter 快速生成
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-900/5 bg-surface-secondary/30">
          <button
            onClick={handleCancel}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors"
          >
            {loading ? "停止生成" : "取消"}
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading || !desc.trim()}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                AI 生成中…
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                生成流程
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══ Workflow Store ═══

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: WorkCategory;
  icon: string;
  prompt: string;
  stages: string[];
}

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ── 客户服务 ──
  {
    id: "t-vip-learning", name: "VIP 学习跟进", category: "客户服务", icon: "🎓",
    description: "课前资料发送、上课提醒、课后反馈收集、月度学习报告",
    prompt: "VIP 客户学习跟进流程：课前一天发送学习资料和预习提醒，上课当天发送 Zoom 链接和上课提醒，课后收集外教反馈和课堂录像，若外教24小时未反馈则自动催收，收到反馈后整理发送给家长，月底生成学习进度报告归档",
    stages: ["课前准备", "上课提醒", "课后收集", "反馈整理", "月度报告"],
  },
  {
    id: "t-satisfaction", name: "满意度调研", category: "客户服务", icon: "📋",
    description: "定期发送问卷、收集反馈、数据分析、改进建议",
    prompt: "客户满意度调研流程：每月15日向活跃客户发送满意度调研问卷，收集3天后统计回收率，对未填写客户发送提醒，汇总所有反馈数据进行分析，生成满意度报告和改进建议，将结果归档并通知相关团队",
    stages: ["发送问卷", "催收回复", "数据汇总", "分析报告"],
  },
  {
    id: "t-renewal", name: "续费提醒", category: "客户服务", icon: "🔄",
    description: "到期监控、提前通知、续费跟进、结果记录",
    prompt: "客户续费提醒流程：监控客户合同到期时间，到期前30天发送首次续费提醒，到期前14天发送第二次提醒并附优惠方案，到期前7天由销售进行电话跟进，记录续费结果，未续费客户转入挽回流程",
    stages: ["到期监控", "首次提醒", "优惠推送", "电话跟进", "结果记录"],
  },
  {
    id: "t-onboarding", name: "新客入职引导", category: "客户服务", icon: "👋",
    description: "欢迎邮件、资料发送、首次培训、跟进回访",
    prompt: "新客户入职引导流程：签约当天发送欢迎邮件和使用指南，第二天发送产品操作视频和常见问题文档，第三天安排首次线上会议进行产品培训，一周后回访使用情况并收集初期反馈，两周后确认客户已正常使用",
    stages: ["欢迎邮件", "资料发送", "培训会议", "回访跟进"],
  },
  {
    id: "t-complaint", name: "投诉处理", category: "客户服务", icon: "🛡️",
    description: "工单接收、分类分派、处理跟进、满意度回访",
    prompt: "客户投诉处理流程：接收客户投诉工单，自动分类投诉类型和紧急程度，根据类型分派给对应处理团队，跟踪处理进度并在超时时升级，处理完成后通知客户结果，3天后进行满意度回访确认问题已解决",
    stages: ["工单接收", "分类分派", "处理跟进", "结果通知", "满意度回访"],
  },
  // ── 情报监控 ──
  {
    id: "t-github-monitor", name: "GitHub Issue 监控", category: "情报监控", icon: "🐙",
    description: "抓取 Issue、分类分析、优先排序、通知团队",
    prompt: "GitHub Issue 监控流程：每天抓取指定仓库的新 Issue 和更新，进行分类标记（Bug/Feature/Question），评估优先级和影响范围，将高优先级 Issue 通知对应开发负责人，每周生成 Issue 趋势分析报告",
    stages: ["Issue 抓取", "分类标记", "优先排序", "团队通知"],
  },
  {
    id: "t-competitor", name: "竞品动态追踪", category: "情报监控", icon: "🔍",
    description: "监控竞品网站、内容提取、变化对比、周报",
    prompt: "竞品动态追踪流程：每天监控3-5个竞品的官网、博客和社交媒体，抓取新发布的产品更新、价格变动和营销活动，与上期数据对比分析变化点，每周五生成竞品动态周报发送给产品和市场团队",
    stages: ["数据采集", "内容提取", "变化对比", "周报生成"],
  },
  {
    id: "t-news-brief", name: "行业新闻简报", category: "情报监控", icon: "📰",
    description: "新闻采集、AI 摘要、分类归档、每日推送",
    prompt: "行业新闻简报流程：每天早上从指定新闻源和 RSS 采集行业相关新闻，用 AI 生成每篇新闻的摘要和关键词，按主题分类归档到知识库，生成当日新闻简报推送给团队成员",
    stages: ["新闻采集", "AI 摘要", "分类归档", "每日推送"],
  },
  {
    id: "t-social-sentiment", name: "社媒舆情监控", category: "情报监控", icon: "📡",
    description: "关键词监控、情感分析、异常告警、舆情报告",
    prompt: "社交媒体舆情监控流程：持续监控 Twitter、微博等平台的品牌关键词和行业关键词，对提及内容进行情感分析标记正面/中性/负面，负面情绪激增时触发即时告警通知公关团队，每周生成舆情趋势报告",
    stages: ["关键词监控", "情感分析", "异常告警", "舆情报告"],
  },
  {
    id: "t-tech-radar", name: "技术趋势雷达", category: "情报监控", icon: "🛰️",
    description: "技术博客扫描、趋势提取、影响评估、月度分析",
    prompt: "技术趋势雷达流程：每周扫描 Hacker News、TechCrunch、GitHub Trending 等技术信息源，提取新兴技术趋势和热门项目，评估对本团队技术栈的潜在影响，每月生成技术趋势雷达图和建议报告",
    stages: ["信息源扫描", "趋势提取", "影响评估", "月度报告"],
  },
  // ── 内部运营 ──
  {
    id: "t-weekly-report", name: "每周工作汇报", category: "内部运营", icon: "📊",
    description: "收集进展、自动汇总、生成周报、发送管理层",
    prompt: "每周工作汇报流程：周五下午从各团队成员收集本周工作进展和下周计划，自动汇总合并为统一格式，按项目维度整理生成周报文档，发送给管理层并归档到飞书知识库",
    stages: ["进展收集", "数据汇总", "周报生成", "发送归档"],
  },
  {
    id: "t-meeting-minutes", name: "会议纪要", category: "内部运营", icon: "🎙️",
    description: "录音转写、要点提取、待办分配、进度跟踪",
    prompt: "会议纪要自动化流程：会议结束后获取录音文件，进行语音转文字，AI 提取会议要点和决议事项，自动生成待办任务分配给对应负责人，每天跟踪待办完成进度并在到期前提醒",
    stages: ["录音转写", "要点提取", "待办分配", "进度跟踪"],
  },
  {
    id: "t-attendance", name: "考勤统计", category: "内部运营", icon: "⏰",
    description: "数据采集、异常检测、报表生成、通知 HR",
    prompt: "员工考勤统计流程：每天从考勤系统采集打卡数据，检测迟到、早退、缺卡等异常情况，对异常记录发送提醒给员工确认，月底汇总生成考勤报表发送给 HR 部门",
    stages: ["数据采集", "异常检测", "员工确认", "报表生成"],
  },
  {
    id: "t-doc-approval", name: "文档审批", category: "内部运营", icon: "✅",
    description: "提交申请、合规检查、多级审批、结果通知",
    prompt: "文档审批流程：员工提交审批申请和相关文档，系统自动检查文档完整性和合规性，按审批规则流转到对应审批人，审批通过后自动通知申请人并归档，超时未审批自动提醒审批人",
    stages: ["提交申请", "合规检查", "多级审批", "结果通知"],
  },
  {
    id: "t-knowledge-update", name: "知识库更新", category: "内部运营", icon: "📚",
    description: "内容采集、格式整理、分类归档、团队通知",
    prompt: "知识库更新流程：从团队日常沟通和项目文档中识别值得沉淀的知识，整理为标准格式的知识条目，按主题分类归档到知识库，通知相关团队成员有新知识更新，定期检查过期内容并标记需要更新",
    stages: ["内容识别", "格式整理", "分类归档", "团队通知"],
  },
  // ── 增长销售 ──
  {
    id: "t-lead-pipeline", name: "线索跟进", category: "增长销售", icon: "🎯",
    description: "线索获取、资质评估、分配销售、跟进提醒",
    prompt: "线索跟进流水线流程：从各渠道获取新线索（网站表单、社交媒体、广告），自动评估线索质量和意向度，将高质量线索分配给对应销售人员，设置跟进提醒周期，未转化线索定期重新评估或回收",
    stages: ["线索获取", "资质评估", "销售分配", "跟进提醒", "效果复盘"],
  },
  {
    id: "t-content-marketing", name: "内容营销排期", category: "增长销售", icon: "✍️",
    description: "选题策划、内容创作、多平台发布、数据复盘",
    prompt: "内容营销排期流程：每周一策划本周内容选题和关键词，安排创作任务给内容团队，内容审核通过后按排期在微信公众号、知乎、小红书等平台同步发布，每周五收集各平台数据进行效果复盘",
    stages: ["选题策划", "内容创作", "多平台发布", "数据复盘"],
  },
  {
    id: "t-growth-experiment", name: "增长实验", category: "增长销售", icon: "🧪",
    description: "假设制定、实验设计、数据收集、效果分析",
    prompt: "用户增长实验流程：提出增长假设和预期指标，设计 A/B 测试实验方案，配置实验参数并上线运行，每天收集实验数据监控关键指标，实验结束后进行统计分析输出结论和下一步建议",
    stages: ["假设制定", "实验设计", "数据监控", "效果分析"],
  },
  {
    id: "t-event-plan", name: "活动策划执行", category: "增长销售", icon: "🎪",
    description: "方案设计、物料准备、执行推进、效果评估",
    prompt: "活动策划执行流程：确定活动目标和主题，设计活动方案和预算，准备宣传物料和渠道投放，活动期间实时监控参与数据，活动结束后统计 ROI 和参与数据生成复盘报告",
    stages: ["方案设计", "物料准备", "渠道投放", "效果复盘"],
  },
  {
    id: "t-reactivation", name: "老客户唤醒", category: "增长销售", icon: "💌",
    description: "沉默筛选、个性化触达、响应跟踪、转化分析",
    prompt: "老客户唤醒流程：从客户数据库筛选超过60天未活跃的沉默客户，根据客户画像和历史行为生成个性化触达方案，通过邮件/短信/微信等渠道发送唤醒内容，跟踪客户响应行为，分析唤醒转化率并优化策略",
    stages: ["沉默筛选", "方案生成", "多渠道触达", "转化分析"],
  },
];

function WorkflowStore({
  titleBarHeight,
  onClose,
  onUseTemplate,
}: {
  titleBarHeight: number;
  onClose: () => void;
  onUseTemplate: (prompt: string, templateName: string, templateCategory: WorkCategory) => void;
}) {
  const [filterCategory, setFilterCategory] = useState<WorkCategory | "all">("all");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [customizeTemplate, setCustomizeTemplate] = useState<WorkflowTemplate | null>(null);

  const filtered = filterCategory === "all"
    ? WORKFLOW_TEMPLATES
    : WORKFLOW_TEMPLATES.filter((t) => t.category === filterCategory);

  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<WorkCategory | "all", number>> = { all: WORKFLOW_TEMPLATES.length };
    for (const t of WORKFLOW_TEMPLATES) counts[t.category] = (counts[t.category] ?? 0) + 1;
    return counts;
  }, []);

  const handleUse = (template: WorkflowTemplate) => {
    setCustomizeTemplate(template);
  };

  const allCategories: { key: WorkCategory | "all"; label: string; color?: string }[] = [
    { key: "all", label: "全部" },
    { key: "客户服务", label: "客户服务", color: "#2563EB" },
    { key: "情报监控", label: "情报监控", color: "#7C3AED" },
    { key: "内部运营", label: "内部运营", color: "#0D9488" },
    { key: "增长销售", label: "增长销售", color: "#D97706" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface-cream"
      style={{ top: `${titleBarHeight}px` }}
    >
      {/* Header */}
      <header
        className="relative flex items-center justify-between h-12 border-b border-ink-900/10 bg-surface-cream shrink-0"
        style={{
          paddingLeft: titleBarHeight === 0 ? '80px' : '24px',
          paddingRight: '24px',
          ...(titleBarHeight === 0 && { WebkitAppRegion: 'drag' } as React.CSSProperties),
        }}
      >
        <div
          className="flex items-center"
          style={titleBarHeight === 0 ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-ink-700 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
        </div>
        <span className="absolute left-1/2 -translate-x-1/2 text-[13px] font-semibold text-ink-800 pointer-events-none">流程商店</span>
        <div className="w-4" />
      </header>

      {/* Category filter pills */}
      <div className="flex items-center gap-2 px-8 py-4 shrink-0">
        {allCategories.map((cat) => {
          const isActive = filterCategory === cat.key;
          return (
            <button
              key={cat.key}
              onClick={() => setFilterCategory(cat.key)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-medium transition-all border ${
                isActive
                  ? "bg-accent/10 text-accent border-accent/20"
                  : "text-muted border-ink-900/8 hover:bg-surface-secondary hover:text-ink-700"
              }`}
            >
              {cat.color && (
                <span className="inline-block h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
              )}
              {cat.label}
              <span className="text-[9px] opacity-60">{categoryCounts[cat.key] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Template grid */}
      <div
        className="flex-1 overflow-y-auto px-8 pb-8"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {filtered.map((template) => {
            const catStyle = CATEGORY_STYLE[template.category] ?? CATEGORY_STYLE[""];
            const isLoading = loadingId === template.id;
            return (
              <div
                key={template.id}
                className="group flex flex-col rounded-2xl border border-ink-900/8 bg-surface p-4 transition-all hover:shadow-card hover:border-ink-900/12"
              >
                <div className="flex items-start gap-3 mb-2.5">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-bold text-white shrink-0"
                    style={{ backgroundColor: catStyle.color }}
                  >
                    {template.name.slice(0, 1)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[13px] font-semibold text-ink-800 leading-snug">{template.name}</h3>
                    <span
                      className="inline-block mt-1 text-[9px] font-medium rounded-full px-2 py-0.5"
                      style={{ backgroundColor: catStyle.bg, color: catStyle.color }}
                    >
                      {catStyle.label}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-muted leading-relaxed mb-3">{template.description}</p>

                <div className="flex flex-wrap gap-1 mb-4">
                  {template.stages.map((stage, i) => (
                    <span key={stage} className="flex items-center gap-1 text-[9px] text-ink-500">
                      {i > 0 && <span className="text-ink-400/40">→</span>}
                      <span className="rounded-md bg-ink-900/[0.04] px-1.5 py-0.5">{stage}</span>
                    </span>
                  ))}
                </div>

                <div className="mt-auto pt-2 border-t border-ink-900/5">
                  <button
                    onClick={() => handleUse(template)}
                    disabled={!!loadingId}
                    className="w-full flex items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-medium text-accent bg-accent/6 hover:bg-accent/12 border border-accent/15 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading ? (
                      <>
                        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        生成中…
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        使用此模板
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Template customize modal */}
      {customizeTemplate && (
        <TemplateCustomizeModal
          template={customizeTemplate}
          onClose={() => setCustomizeTemplate(null)}
          onConfirm={(finalPrompt, customName) => {
            setCustomizeTemplate(null);
            setLoadingId(customizeTemplate.id);
            onUseTemplate(finalPrompt, customName, customizeTemplate.category);
          }}
        />
      )}
    </div>
  );
}

// ═══ Template Customize Modal ═══

const CATEGORY_PLACEHOLDER: Record<string, string> = {
  "客户服务": "例如：我们的客户群体是 K12 家长，主要用飞书沟通，每周跟进一次",
  "情报监控": "例如：重点关注 OpenAI、Google、Anthropic 三家，信息源以 Twitter 和官方博客为主",
  "内部运营": "例如：团队 15 人，用钉钉协作，每周五下午提交周报",
  "增长销售": "例如：主要渠道是微信公众号和小红书，目标月新增 500 线索",
  "": "例如：请根据我们团队的实际情况调整",
};

function TemplateCustomizeModal({
  template,
  onClose,
  onConfirm,
}: {
  template: WorkflowTemplate;
  onClose: () => void;
  onConfirm: (finalPrompt: string, customName: string) => void;
}) {
  const [sopName, setSopName] = useState("");
  const [extra, setExtra] = useState("");
  const [editablePrompt, setEditablePrompt] = useState(template.prompt);
  const [showPrompt, setShowPrompt] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const catStyle = CATEGORY_STYLE[template.category] ?? CATEGORY_STYLE[""];

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const handleConfirm = () => {
    const trimmedExtra = extra.trim();
    const trimmedName = sopName.trim();
    const nameLine = trimmedName ? `\n## 指定名称\nSOP 的 name 字段必须为："${trimmedName}"\n` : "";
    let finalPrompt: string;
    if (trimmedExtra) {
      finalPrompt = `## 用户定制要求（优先级最高）\n${trimmedExtra}${nameLine}\n\n## 基础流程模板\n${editablePrompt}`;
    } else {
      finalPrompt = nameLine ? `${nameLine}\n${editablePrompt}` : editablePrompt;
    }
    onConfirm(finalPrompt, trimmedName || template.name);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[560px] max-h-[85vh] flex flex-col rounded-2xl bg-surface shadow-xl border border-ink-900/8 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-900/5 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-xl text-[12px] font-bold text-white shrink-0"
              style={{ backgroundColor: catStyle.color }}
            >
              {template.name.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink-800">{template.name}</h2>
              <p className="text-[11px] text-muted mt-0.5">{template.description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink-700 transition-colors p-1 rounded-lg hover:bg-ink-900/5 shrink-0"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.12) transparent" }}
        >
          {/* SOP name */}
          <div>
            <label className="text-[10px] text-muted font-medium mb-1.5 block">流程名称</label>
            <input
              ref={nameRef}
              value={sopName}
              onChange={(e) => setSopName(e.target.value)}
              placeholder={`留空自动生成 · 如"${template.name}"`}
              className="w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-2.5 text-[13px] font-medium text-ink-800 placeholder:text-muted/40 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleConfirm();
              }}
            />
          </div>

          {/* Stage preview */}
          <div>
            <div className="text-[10px] text-muted mb-2 font-medium">流程阶段预览</div>
            <div className="flex flex-wrap gap-1.5">
              {template.stages.map((stage, i) => (
                <span key={stage} className="flex items-center gap-1.5 text-[10px]">
                  {i > 0 && (
                    <svg viewBox="0 0 8 8" className="h-2 w-2 text-ink-400/40 shrink-0">
                      <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  )}
                  <span
                    className="rounded-lg px-2 py-1 font-medium"
                    style={{ backgroundColor: `${catStyle.color}10`, color: catStyle.color }}
                  >
                    {stage}
                  </span>
                </span>
              ))}
            </div>
            <p className="text-[9px] text-muted/50 mt-1.5">实际生成结果由 AI 根据描述决定，阶段仅供参考</p>
          </div>

          {/* Extra description */}
          <div>
            <label className="text-[10px] text-muted font-medium mb-1.5 block">补充你的业务信息</label>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={CATEGORY_PLACEHOLDER[template.category] ?? CATEGORY_PLACEHOLDER[""]}
              className="w-full h-24 rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-3 text-[12px] text-ink-800 placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all leading-relaxed"
              style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleConfirm();
              }}
            />
            <p className="text-[9px] text-muted/50 mt-1">描述越详细，生成的流程越贴合实际 · 可留空使用默认模板 · {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter 快速生成</p>
          </div>

          {/* Collapsible prompt editor */}
          <div>
            <button
              onClick={() => setShowPrompt((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] text-muted hover:text-ink-600 transition-colors"
            >
              <svg
                viewBox="0 0 10 10"
                className={`h-2.5 w-2.5 transition-transform ${showPrompt ? "rotate-90" : ""}`}
                fill="none" stroke="currentColor" strokeWidth="1.5"
              >
                <path d="M3 1.5l4 3.5-4 3.5" />
              </svg>
              <span className="font-medium">{showPrompt ? "收起完整提示词" : "查看 / 编辑完整提示词"}</span>
            </button>
            {showPrompt && (
              <textarea
                value={editablePrompt}
                onChange={(e) => setEditablePrompt(e.target.value)}
                className="mt-2 w-full h-40 rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-3 text-[11px] text-ink-700 font-mono resize-none focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all leading-relaxed"
                style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleConfirm();
                }}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-900/5 bg-surface-secondary/30 shrink-0">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-white shadow-soft hover:bg-accent-hover transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            开始生成
          </button>
        </div>
      </div>
    </div>
  );
}
