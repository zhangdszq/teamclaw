import { useState, useMemo, useCallback, type CSSProperties } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface SopPageProps {
  onClose: () => void;
  titleBarHeight?: number;
}

type WorkflowTab = "lesson_cycle" | "monthly_settlement";

interface ScheduleCard {
  id: string;
  name: string;
  cron: string;
  nextRun: string;
  status: "success" | "pending" | "paused";
}

const LEGEND_ITEMS = [
  { color: "#6366F1", label: "Prep/Fetch" },
  { color: "#3B82F6", label: "Reminder/Schedule" },
  { color: "#0D9488", label: "Trigger/Exec" },
  { color: "#2C5F2F", label: "Feedback/Store" },
  { color: "#D97706", label: "Branch/Event" },
];

// ═══ Custom Node Components ═══

function StepNode({ data }: { data: { label: string; items: string[]; tools: string[]; color: string; bgColor: string } }) {
  return (
    <div
      className="rounded-xl px-4 py-3 min-w-[170px] max-w-[200px]"
      style={{
        border: `1.5px solid ${data.color}30`,
        backgroundColor: data.bgColor,
        boxShadow: `0 2px 8px ${data.color}12`,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-3 !h-3" style={{ left: -6 }} />
      <div className="flex items-center gap-2 mb-2.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: data.color }} />
        <span className="text-[12px] font-semibold" style={{ color: data.color }}>{data.label}</span>
      </div>
      <div className="flex flex-col gap-1.5 mb-2.5">
        {data.items.map((item: string) => (
          <div key={item} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4A4A45" }}>
            <span className="inline-block h-[3px] w-[3px] rounded-full" style={{ backgroundColor: `${data.color}80` }} />
            {item}
          </div>
        ))}
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
        backgroundColor: "#FAF9F6",
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
const EDGE_MARKER: Edge["markerEnd"] = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#9B9B96" };

// ═══ Flow Data Builders ═══

function buildLessonCycleData(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    {
      id: "t-1", type: "step", position: { x: 0, y: 80 },
      data: { label: "T-1 课前准备", items: ["发送课前资料", "飞书归档"], tools: ["web_fetch"], color: "#6366F1", bgColor: "#EEF2FF" },
    },
    {
      id: "t-0", type: "step", position: { x: 280, y: 80 },
      data: { label: "T-0 上课提醒", items: ["群内提醒", "Zoom确认"], tools: ["schedule_create"], color: "#3B82F6", bgColor: "#EFF6FF" },
    },
    {
      id: "t+0", type: "step", position: { x: 560, y: 80 },
      data: { label: "T+0 课后触发", items: ["回放下载", "催收反馈"], tools: ["shell_exec"], color: "#0D9488", bgColor: "#F0FDFA" },
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
      data: { label: "T+1 反馈循环", items: ["反馈梳理发送", "视频双备份", "AI补位检查"], tools: ["memory_store", "web_search"], color: "#2C5F2F", bgColor: "#F0F7F0" },
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
      data: { label: "课时统计", items: ["查询当月授课记录", "统计外教/中教课时"], tools: ["knowledge_query"], color: "#6366F1", bgColor: "#EEF2FF" },
    },
    {
      id: "calc", type: "step", position: { x: 280, y: 80 },
      data: { label: "费用核算", items: ["生成课时统计表", "写入钉钉多维表"], tools: ["dingtalk-ai-table"], color: "#3B82F6", bgColor: "#EFF6FF" },
    },
    {
      id: "report", type: "step", position: { x: 560, y: 80 },
      data: { label: "月度报告", items: ["汇总反馈记录", "生成学习报告", "归档飞书文档"], tools: ["memory_recall", "file_write"], color: "#2C5F2F", bgColor: "#F0F7F0" },
    },
    {
      id: "notify", type: "step", position: { x: 860, y: 80 },
      data: { label: "通知发送", items: ["通知教师管理团队", "发送家校报告"], tools: ["event_publish"], color: "#D97706", bgColor: "#FFFBEB" },
    },
  ];

  const edges: Edge[] = [
    { id: "m1", source: "stat", target: "calc", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    { id: "m2", source: "calc", target: "report", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
    { id: "m3", source: "report", target: "notify", style: EDGE_STYLE, markerEnd: EDGE_MARKER },
  ];

  return { nodes, edges };
}

// ═══ Main Component ═══

export function SopPage({ onClose, titleBarHeight = 0 }: SopPageProps) {
  const [activeWorkflowTab, setActiveWorkflowTab] = useState<WorkflowTab>("lesson_cycle");

  const schedules: ScheduleCard[] = useMemo(() => [
    { id: "1", name: "课前1天提醒", cron: "0 20 * * MON", nextRun: "3月3日 20:00", status: "success" },
    { id: "2", name: "上课当天提醒", cron: "0 19 * * TUE", nextRun: "3月4日 19:00", status: "success" },
    { id: "3", name: "课后反馈催收", cron: "T+1 10:00 条件触发", nextRun: "3月5日 10:00", status: "success" },
    { id: "4", name: "月度报告生成", cron: "0 10 L * *", nextRun: "3月31日 10:00", status: "pending" },
    { id: "5", name: "月底清时结算", cron: "0 18 L * *", nextRun: "3月31日 18:00", status: "pending" },
  ], []);

  const lessonData = useMemo(() => buildLessonCycleData(), []);
  const monthlyData = useMemo(() => buildMonthlySettlementData(), []);
  const flowData = activeWorkflowTab === "lesson_cycle" ? lessonData : monthlyData;

  const timelineEvents = useMemo(() => [
    { day: 0, hour: 20, label: "课前1天提醒", color: "#6366F1", bg: "#EEF2FF" },
    { day: 1, hour: 19, label: "上课提醒", color: "#3B82F6", bg: "#EFF6FF" },
    { day: 1, hour: 20, label: "T-1 条件触发", color: "#0D9488", bg: "#F0FDFA" },
    { day: 2, hour: 19, label: "上课提醒", color: "#3B82F6", bg: "#EFF6FF" },
    { day: 2, hour: 20, label: "上课提醒", color: "#3B82F6", bg: "#EFF6FF" },
    { day: 4, hour: 18, label: "反馈催收", color: "#2C5F2F", bg: "#F0F7F0" },
  ], []);

  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = [18, 19, 20, 21, 22];

  const onNodesChange = useCallback(() => {}, []);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-surface-cream"
      style={{ top: `${titleBarHeight}px` }}
    >
      {/* ═══ Header ═══ */}
      <header className="flex items-center justify-between px-6 h-12 border-b border-ink-900/10 bg-surface-cream shrink-0 select-none">
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-ink-700 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
          <div className="h-5 w-px bg-ink-900/10" />
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-ink-800 tracking-tight">SOP</span>
            <span className="text-xs text-muted">Automation</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-2 border border-ink-900/8 shadow-soft">
            <span className="text-[11px] text-muted">SOP 名称</span>
            <span className="text-sm font-semibold text-ink-800">VVIP EduCare</span>
            <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
              Active
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 rounded-xl border border-ink-900/8 bg-surface px-3 py-2 text-xs font-medium text-ink-700 shadow-soft hover:bg-surface-secondary transition-colors">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            新建工作流
          </button>
          <button className="flex items-center gap-1.5 rounded-xl bg-accent text-white px-3 py-2 text-xs font-medium shadow-soft hover:bg-accent-hover transition-colors">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            新建 SOP
          </button>
        </div>
      </header>

      {/* ═══ Main Content ═══ */}
      <div className="flex flex-1 min-h-0 gap-4 p-4">
        {/* ─── Left: Visual Workflow Canvas ─── */}
        <div className="flex-1 flex flex-col rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-ink-900/5 shrink-0">
            <div className="flex gap-1">
              <button
                onClick={() => setActiveWorkflowTab("lesson_cycle")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all border ${
                  activeWorkflowTab === "lesson_cycle"
                    ? "bg-accent/8 text-accent border-accent/20"
                    : "text-muted border-transparent hover:bg-surface-secondary"
                }`}
              >
                课程周期流
              </button>
              <button
                onClick={() => setActiveWorkflowTab("monthly_settlement")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all border ${
                  activeWorkflowTab === "monthly_settlement"
                    ? "bg-accent/8 text-accent border-accent/20"
                    : "text-muted border-transparent hover:bg-surface-secondary"
                }`}
              >
                月度结算流
              </button>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted">
              {LEGEND_ITEMS.map((item) => (
                <span key={item.label} className="flex items-center gap-1">
                  <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}
                </span>
              ))}
            </div>
          </div>

          {/* React Flow Canvas */}
          <div className="flex-1" style={{ minHeight: 0 }}>
            <ReactFlow
              key={activeWorkflowTab}
              nodes={flowData.nodes}
              edges={flowData.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
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
              elementsSelectable={false}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#D1D1CC" />
              <MiniMap
                nodeStrokeWidth={2}
                pannable={false}
                zoomable={false}
                style={{ border: "1px solid #E5E4DF", borderRadius: 8, background: "#FAF9F6" }}
              />
              <Controls
                showInteractive={false}
                style={{ border: "1px solid #E5E4DF", borderRadius: 8, background: "#FFFFFF", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
              />
            </ReactFlow>
          </div>
        </div>

        {/* ─── Right: Scheduler Manager ─── */}
        <div className="w-[340px] shrink-0 flex flex-col rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden">
          <div className="px-5 pt-4 pb-3 shrink-0">
            <h2 className="text-sm font-semibold text-ink-800">调度管理</h2>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-ink-600">活跃调度</span>
              <span className="text-[10px] text-muted-light">Active Schedules</span>
            </div>
            <div className="flex flex-col gap-2 pb-3">
              {schedules.map((schedule) => (
                <ScheduleCardItem key={schedule.id} schedule={schedule} />
              ))}
            </div>
          </div>

          <div className="shrink-0 border-t border-ink-900/5 px-4 pt-3 pb-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-ink-600">本周时间线</span>
              <span className="text-[10px] text-muted-light">Weekly Timeline</span>
            </div>

            <div className="rounded-xl border border-ink-900/5 bg-surface-cream overflow-hidden">
              <div className="grid grid-cols-[40px_repeat(7,1fr)] border-b border-ink-900/5">
                <div />
                {weekdays.map((day) => (
                  <div key={day} className="text-center text-[10px] text-muted py-2 font-medium">{day}</div>
                ))}
              </div>
              {hours.map((hour) => (
                <div key={hour} className="grid grid-cols-[40px_repeat(7,1fr)] border-b border-ink-900/5 last:border-0">
                  <div className="text-[10px] text-muted-light py-3 text-right pr-2">{hour}:00</div>
                  {weekdays.map((_, dayIdx) => {
                    const event = timelineEvents.find((e) => e.day === dayIdx && e.hour === hour);
                    return (
                      <div key={dayIdx} className="relative py-1 px-0.5">
                        {event && (
                          <div
                            className="rounded px-1 py-1 text-[9px] font-medium leading-tight"
                            style={{ backgroundColor: event.bg, color: event.color }}
                          >
                            {event.label}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ Schedule Card ═══

function ScheduleCardItem({ schedule }: { schedule: ScheduleCard }) {
  const statusConfig = {
    success: { bg: "bg-success/8", text: "text-success", label: "成功" },
    pending: { bg: "bg-amber-500/8", text: "text-amber-600", label: "待执行" },
    paused: { bg: "bg-ink-900/5", text: "text-muted", label: "已暂停" },
  };
  const st = statusConfig[schedule.status];

  return (
    <div className="group rounded-xl border border-ink-900/8 bg-surface-cream p-3 hover:border-ink-900/15 hover:shadow-soft transition-all">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${schedule.status === "success" ? "bg-success" : schedule.status === "pending" ? "bg-amber-500" : "bg-ink-400"}`} />
          <span className="text-xs font-medium text-ink-800">{schedule.name}</span>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${st.bg} ${st.text}`}>
          {st.label}
        </span>
      </div>
      <div className="text-[10px] text-muted font-mono">
        {schedule.cron.startsWith("T") ? `trigger: ${schedule.cron}` : `cron: ${schedule.cron}`}
      </div>
      <div className="text-[10px] text-muted-light mt-1">
        下次: {schedule.nextRun}
      </div>
      <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <ActionBtn label="暂停" icon="pause" />
        <ActionBtn label="编辑" icon="edit" />
        <ActionBtn label="删除" icon="delete" />
      </div>
    </div>
  );
}

function ActionBtn({ label, icon }: { label: string; icon: "pause" | "edit" | "delete" }) {
  const paths: Record<string, string> = {
    pause: "M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z",
    edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    delete: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
  };

  return (
    <button
      className="rounded-md px-2 py-1 text-[10px] text-muted hover:text-ink-700 hover:bg-surface-tertiary transition-colors"
      title={label}
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d={paths[icon]} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
