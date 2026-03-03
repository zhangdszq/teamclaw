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
  stages?: HandStage[];
}

// Fallback list shown before HAND.toml files are loaded
const FALLBACK_SOP_LIST: SopItem[] = [
  {
    id: "vvip-educare",
    name: "VVIP EduCare",
    description: "课程周期 & 月度结算自动化",
    status: "active",
    assistant: "教务助理",
    workflowCount: 2,
    icon: "🎓",
  },
];

const LEGEND_ITEMS = [
  { color: "#6366F1", label: "Prep/Fetch" },
  { color: "#3B82F6", label: "Reminder/Schedule" },
  { color: "#0D9488", label: "Trigger/Exec" },
  { color: "#2C5F2F", label: "Feedback/Store" },
  { color: "#D97706", label: "Branch/Event" },
];

const TOOL_OPTIONS: { value: string; group: string }[] = [
  { value: "file_read",               group: "文件" },
  { value: "file_write",              group: "文件" },
  { value: "file_list",               group: "文件" },
  { value: "web_fetch",               group: "网络" },
  { value: "web_search",              group: "网络" },
  { value: "shell_exec",              group: "命令行" },
  { value: "memory_store",            group: "记忆" },
  { value: "memory_recall",           group: "记忆" },
  { value: "schedule_create",         group: "调度" },
  { value: "schedule_list",           group: "调度" },
  { value: "schedule_delete",         group: "调度" },
  { value: "knowledge_add_entity",    group: "知识图谱" },
  { value: "knowledge_add_relation",  group: "知识图谱" },
  { value: "knowledge_query",         group: "知识图谱" },
  { value: "event_publish",           group: "事件" },
];

const MCP_OPTIONS: { value: string; group: string }[] = [
  { value: "dingtalk-ai-table",  group: "钉钉" },
  { value: "dingtalk-contacts",  group: "钉钉" },
  { value: "dingtalk-message",   group: "钉钉" },
  { value: "feishu-doc",         group: "飞书" },
  { value: "feishu-sheet",       group: "飞书" },
  { value: "feishu-message",     group: "飞书" },
  { value: "feishu-calendar",    group: "飞书" },
  { value: "exa",                group: "搜索" },
  { value: "github",             group: "开发" },
  { value: "slack",              group: "协作" },
  { value: "notion",             group: "协作" },
  { value: "airtable",           group: "数据" },
  { value: "google-calendar",    group: "Google" },
  { value: "google-sheets",      group: "Google" },
  { value: "google-docs",        group: "Google" },
  { value: "jira",               group: "项目管理" },
  { value: "linear",             group: "项目管理" },
  { value: "asana",              group: "项目管理" },
];

// ═══ Custom Node Components ═══

function StepNode({ data, selected }: { data: { label: string; items: string[]; tools: string[]; mcp: string[]; color: string; bgColor: string }; selected?: boolean }) {
  const hasSkills = data.tools.length > 0;
  const hasMcp = data.mcp.length > 0;
  const hasBadges = hasSkills || hasMcp;
  return (
    <div
      className="rounded-xl px-4 py-3 min-w-[170px] max-w-[210px] cursor-pointer transition-shadow"
      style={{
        border: selected ? `2px solid ${data.color}` : `1.5px solid ${data.color}30`,
        backgroundColor: data.bgColor,
        boxShadow: selected
          ? `0 0 0 3px ${data.color}22, 0 4px 12px ${data.color}20`
          : `0 2px 8px ${data.color}12`,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-3 !h-3" style={{ left: -6 }} />
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


const STATUS_CONFIG = {
  active: { label: "运行中", color: "text-success", bg: "bg-success/10", dot: "bg-success" },
  draft: { label: "草稿", color: "text-muted", bg: "bg-ink-900/5", dot: "bg-ink-400" },
  paused: { label: "已暂停", color: "text-amber-600", bg: "bg-amber-50", dot: "bg-amber-400" },
};

// ═══ Main Component ═══

export function SopPage({ onClose, onOpenPlanTable, titleBarHeight = 0 }: SopPageProps) {
  const [activeWorkflowTab, setActiveWorkflowTab] = useState<WorkflowTab>("lesson_cycle");
  const [selectedSopId, setSelectedSopId] = useState<string>("vvip-educare");
  const [sopList, setSopList] = useState<SopItem[]>(FALLBACK_SOP_LIST);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, { tools: string[]; mcp: string[] }>>({});
  const loadedRef = useRef(false);
  const sopButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Load SOP list from HAND.toml files
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    window.electron.sopList().then((results) => {
      if (results.length === 0) return;
      setSopList(results.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: "active" as const,
        assistant: "默认助理",
        workflowCount: r.workflowCount,
        icon: r.icon,
        stages: r.stages,
      })));
      // If current selection no longer exists, switch to first
      if (!results.find((r) => r.id === selectedSopId)) {
        setSelectedSopId(results[0].id);
      }
    }).catch(() => { /* keep fallback list */ });
  }, [selectedSopId]);

  const selectedSop = sopList.find((s) => s.id === selectedSopId) ?? sopList[0];

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

  // Merge overrides into flow nodes
  const flowNodes = useMemo(
    () =>
      flowData.nodes.map((node) => {
        const ov = nodeOverrides[node.id];
        if (!ov) return node;
        return { ...node, data: { ...node.data, ...ov } };
      }),
    [flowData.nodes, nodeOverrides],
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
        </div>
      </header>

      {/* ═══ Main Content ═══ */}
      <div className="flex flex-1 min-h-0 p-4 gap-3">

        {/* ═══ Left: SOP List ═══ */}
        <div className="w-56 shrink-0 flex flex-col rounded-2xl border border-ink-900/8 bg-surface shadow-soft overflow-hidden">
          {/* List Header */}
          <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5 border-b border-ink-900/5 shrink-0">
            <span className="text-[11px] font-semibold text-ink-600 tracking-wide uppercase">SOP 列表</span>
            <span className="text-[10px] text-muted bg-ink-900/5 rounded-full px-1.5 py-0.5">{sopList.length}</span>
          </div>

          {/* SOP Items */}
          <div
            className="flex-1 overflow-y-auto py-1.5"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
          >
            {sopList.map((sop) => {
              const isSelected = sop.id === selectedSopId;
              const statusCfg = STATUS_CONFIG[sop.status];
              return (
                <button
                  key={sop.id}
                  ref={(el) => { sopButtonRefs.current[sop.id] = el; }}
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
            <button
              onClick={() => setShowCreateModal(true)}
              className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-900/15 py-2 text-[11px] text-muted hover:text-accent hover:border-accent/30 hover:bg-accent/5 transition-all"
            >
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
              {hasHandStages ? (
                <span className="rounded-lg px-3 py-1.5 text-xs font-medium bg-accent/8 text-accent border border-accent/20">
                  {selectedSop?.name ?? "SOP"} 工作流
                </span>
              ) : (
                <>
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
                </>
              )}
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
          <div className="flex-1 relative" style={{ minHeight: 0 }}>
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
                style={{ border: "1px solid #E5E4DF", borderRadius: 8, background: "#FAF9F6" }}
              />
              <Controls
                showInteractive={false}
                style={{ border: "1px solid #E5E4DF", borderRadius: 8, background: "#FFFFFF", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
              />
            </ReactFlow>

            {/* Node edit side panel */}
            {selectedNodeId && selectedNodeData && (
              <NodeEditPanel
                label={selectedNodeData.label}
                color={selectedNodeData.color}
                tools={selectedNodeData.tools}
                mcp={selectedNodeData.mcp}
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

      {/* ═══ Create SOP Modal ═══ */}
      {showCreateModal && (
        <CreateSopModal
          onClose={() => setShowCreateModal(false)}
          onCreate={(result) => {
            const newItem: SopItem = {
              id: result.id,
              name: result.name,
              description: result.description,
              status: "active",
              assistant: "默认助理",
              workflowCount: result.workflowCount,
              icon: result.icon,
              stages: result.stages,
            };
            // Prepend so the new SOP appears at the top of the list
            setSopList((prev) => [newItem, ...prev.filter((s) => s.id !== result.id)]);
            setSelectedSopId(result.id);
            setShowCreateModal(false);
          }}
        />
      )}
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
  options: { value: string; group: string }[];
  badgeStyle: { backgroundColor: string; color: string };
  onChange: (items: string[]) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (pickerRef.current && !pickerRef.current.contains(target)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  const available = options.filter((o) => !items.includes(o.value));
  const groups = available.reduce<Record<string, string[]>>((acc, opt) => {
    (acc[opt.group] ??= []).push(opt.value);
    return acc;
  }, {});

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

      {/* Current items */}
      <div className="flex flex-wrap gap-1.5 min-h-[22px] mb-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="group flex items-center gap-1 rounded-md pl-2 pr-1 py-[3px] text-[9px] font-mono leading-none"
            style={badgeStyle}
          >
            {item}
            <button
              onClick={() => removeItem(item)}
              className="opacity-40 group-hover:opacity-100 rounded hover:bg-red-100 hover:text-red-600 p-px transition-all"
            >
              <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span className="text-[10px] text-muted/60 italic">暂未配置</span>
        )}
      </div>

      {/* Picker dropdown */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="mt-1 rounded-xl border border-ink-900/10 bg-surface shadow-lg overflow-hidden"
          style={{ maxHeight: 220, overflowY: "auto", scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
        >
          {Object.entries(groups).map(([group, opts]) => (
            <div key={group}>
              <div className="px-3 py-1 text-[8px] font-semibold text-muted/70 bg-surface-secondary uppercase tracking-wider sticky top-0">
                {group}
              </div>
              {opts.map((opt) => (
                <button
                  key={opt}
                  onClick={() => { addItem(opt); setShowPicker(false); }}
                  className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-ink-700 hover:bg-surface-secondary transition-colors"
                >
                  {opt}
                </button>
              ))}
            </div>
          ))}
          {available.length === 0 && (
            <div className="px-3 py-2 text-[10px] text-muted italic">所有选项已添加</div>
          )}
          <div className="flex items-center gap-2 border-t border-ink-900/8 px-3 py-2 bg-surface sticky bottom-0">
            <input
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { addCustom(); setShowPicker(false); } }}
              placeholder="自定义名称…"
              className="flex-1 text-[10px] font-mono bg-transparent outline-none text-ink-700 placeholder:text-muted/40"
            />
            <button
              onClick={() => { addCustom(); setShowPicker(false); }}
              disabled={!customInput.trim()}
              className="text-[10px] text-accent hover:text-accent-hover disabled:opacity-30 transition-colors"
            >
              ↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ Node Edit Panel ═══

function NodeEditPanel({
  label,
  color,
  tools,
  mcp,
  onClose,
  onChangeTools,
  onChangeMcp,
}: {
  label: string;
  color: string;
  tools: string[];
  mcp: string[];
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
          options={TOOL_OPTIONS}
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
          options={MCP_OPTIONS}
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
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleGenerate = async () => {
    const trimmed = desc.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const result = await window.electron.sopGenerate(trimmed);
      onCreate(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[520px] rounded-2xl bg-surface shadow-xl border border-ink-900/8 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-900/5">
          <div>
            <h2 className="text-sm font-semibold text-ink-800">新建 SOP</h2>
            <p className="text-[11px] text-muted mt-0.5">用自然语言描述你的标准操作流程，AI 将自动生成 SOP 流程图和计划</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink-700 transition-colors p-1 rounded-lg hover:bg-ink-900/5"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            disabled={loading}
            placeholder={"例如：每周 VIP 客户跟进流程 — 周一发送学习资料和上课提醒，周三确认作业完成情况，周五整理老师反馈并归档，月底生成学习进度报告发给家长"}
            className="w-full h-32 rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-3 text-sm text-ink-800 placeholder:text-muted/60 resize-none focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-all"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(0,0,0,0.15) transparent" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate();
            }}
          />

          {error && (
            <div className="mt-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[11px] text-red-600">
              {error}
            </div>
          )}

          <p className="mt-2 text-[10px] text-muted/60">
            描述越详细，生成质量越高 · {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter 快速生成
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-900/5 bg-surface-secondary/30">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors"
          >
            取消
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
                生成 SOP
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

