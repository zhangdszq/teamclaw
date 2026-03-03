import { useState, useMemo, useCallback, type CSSProperties } from "react";
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

interface SopPageProps {
  onClose: () => void;
  onOpenPlanTable?: () => void;
  titleBarHeight?: number;
}

type WorkflowTab = "lesson_cycle" | "monthly_settlement";

interface SopItem {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft" | "paused";
  assistant: string;
  workflowCount: number;
  icon: string;
}

const SOP_LIST: SopItem[] = [
  {
    id: "vvip-educare",
    name: "VVIP EduCare",
    description: "课程周期 & 月度结算自动化",
    status: "active",
    assistant: "教务助理",
    workflowCount: 2,
    icon: "🎓",
  },
  {
    id: "client-followup",
    name: "客户跟进",
    description: "潜客跟进 & 转化提醒",
    status: "active",
    assistant: "销售助理",
    workflowCount: 3,
    icon: "📞",
  },
  {
    id: "content-publish",
    name: "内容发布",
    description: "小红书 / 抖音定期推文",
    status: "draft",
    assistant: "运营助理",
    workflowCount: 1,
    icon: "✍️",
  },
  {
    id: "hr-onboarding",
    name: "员工入职",
    description: "新员工入职流程自动化",
    status: "paused",
    assistant: "HR 助理",
    workflowCount: 4,
    icon: "👤",
  },
  {
    id: "finance-report",
    name: "财务报表",
    description: "月末自动汇总与发送",
    status: "draft",
    assistant: "财务助理",
    workflowCount: 2,
    icon: "📊",
  },
];

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
const EDGE_MARKER: EdgeMarker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#9B9B96" };

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


const STATUS_CONFIG = {
  active: { label: "运行中", color: "text-success", bg: "bg-success/10", dot: "bg-success" },
  draft: { label: "草稿", color: "text-muted", bg: "bg-ink-900/5", dot: "bg-ink-400" },
  paused: { label: "已暂停", color: "text-amber-600", bg: "bg-amber-50", dot: "bg-amber-400" },
};

// ═══ Main Component ═══

export function SopPage({ onClose, onOpenPlanTable, titleBarHeight = 0 }: SopPageProps) {
  const [activeWorkflowTab, setActiveWorkflowTab] = useState<WorkflowTab>("lesson_cycle");
  const [selectedSopId, setSelectedSopId] = useState<string>("vvip-educare");

  const selectedSop = SOP_LIST.find((s) => s.id === selectedSopId) ?? SOP_LIST[0];

  const lessonData = useMemo(() => buildLessonCycleData(), []);
  const monthlyData = useMemo(() => buildMonthlySettlementData(), []);
  const flowData = activeWorkflowTab === "lesson_cycle" ? lessonData : monthlyData;

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
          <div className="h-5 w-px bg-ink-900/10" />
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-ink-800 tracking-tight">SOP</span>
            <span className="text-xs text-muted">Automation</span>
          </div>
        </div>

        <div
          className="flex items-center gap-3"
          style={titleBarHeight === 0 ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          <div className="flex items-center gap-2.5 rounded-xl bg-surface px-4 py-2 border border-ink-900/8 shadow-soft">
            <span className="text-[11px] text-muted">当前 SOP</span>
            <span className="text-sm font-semibold text-ink-800">{selectedSop.name}</span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CONFIG[selectedSop.status].bg} ${STATUS_CONFIG[selectedSop.status].color}`}>
              {STATUS_CONFIG[selectedSop.status].label}
            </span>
          </div>
        </div>

        <div
          className="flex items-center gap-2"
          style={titleBarHeight === 0 ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : undefined}
        >
          <button
            onClick={() => onOpenPlanTable?.()}
            className="flex items-center gap-1.5 rounded-xl border border-ink-900/8 bg-surface px-3 py-2 text-xs font-medium text-ink-700 shadow-soft hover:bg-surface-secondary transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            计划表
          </button>
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
      <div className="flex flex-1 min-h-0 p-4 gap-3">

        {/* ═══ Left: SOP List ═══ */}
        <div className="w-56 shrink-0 flex flex-col rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden">
          {/* List Header */}
          <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5 border-b border-ink-900/5 shrink-0">
            <span className="text-[11px] font-semibold text-ink-600 tracking-wide uppercase">SOP 列表</span>
            <span className="text-[10px] text-muted bg-ink-900/5 rounded-full px-1.5 py-0.5">{SOP_LIST.length}</span>
          </div>

          {/* SOP Items */}
          <div
            className="flex-1 overflow-y-auto py-1.5"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
          >
            {SOP_LIST.map((sop) => {
              const isSelected = sop.id === selectedSopId;
              const statusCfg = STATUS_CONFIG[sop.status];
              return (
                <button
                  key={sop.id}
                  onClick={() => setSelectedSopId(sop.id)}
                  className={`w-full text-left px-3 py-2.5 mx-1 rounded-xl transition-all mb-0.5 group ${
                    isSelected
                      ? "bg-accent/8 border border-accent/20"
                      : "hover:bg-surface-secondary border border-transparent"
                  }`}
                  style={{ width: "calc(100% - 8px)" }}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="text-base leading-none mt-0.5 shrink-0">{sop.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className={`text-[12px] font-semibold truncate ${isSelected ? "text-accent" : "text-ink-800"}`}>
                          {sop.name}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted leading-snug truncate mb-1.5">{sop.description}</p>
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-[2px] text-[9px] font-medium ${statusCfg.bg} ${statusCfg.color}`}>
                          <span className={`inline-block h-1 w-1 rounded-full ${statusCfg.dot}`} />
                          {statusCfg.label}
                        </span>
                        <span className="text-[9px] text-muted">{sop.workflowCount} 工作流</span>
                      </div>
                      <div className="mt-1 text-[9px] text-muted/70 truncate">
                        👤 {sop.assistant}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Add SOP button at bottom */}
          <div className="px-2 py-2 border-t border-ink-900/5 shrink-0">
            <button className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-900/15 py-2 text-[11px] text-muted hover:text-accent hover:border-accent/30 hover:bg-accent/5 transition-all">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
              新建 SOP
            </button>
          </div>
        </div>

        {/* ═══ Right: Visual Workflow Canvas ═══ */}
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
        {/* End Right Canvas */}

      </div>
      {/* End Main Content */}

    </div>
  );
}

