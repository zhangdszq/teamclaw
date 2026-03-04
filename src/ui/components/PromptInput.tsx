import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent } from "../types";
import { useAppStore } from "../store/useAppStore";

const DEFAULT_ALLOWED_TOOLS = "Read,Edit,Bash";
const MAX_ROWS = 12;
const LINE_HEIGHT = 21;
const MAX_HEIGHT = MAX_ROWS * LINE_HEIGHT;

// Skill category config
const SKILL_CATEGORY_CONFIG: Record<string, { icon: string; color: string }> = {
  "teaching":           { icon: "code",    color: "text-emerald-600 bg-emerald-500/10" },
  "picturebook":        { icon: "palette", color: "text-rose-500 bg-rose-500/10" },
  "product-management": { icon: "chart",   color: "text-violet-600 bg-violet-500/10" },
  "operations":         { icon: "zap",     color: "text-orange-600 bg-orange-500/10" },
  "video":              { icon: "palette", color: "text-red-500 bg-red-500/10" },
  "image":              { icon: "palette", color: "text-orange-500 bg-orange-500/10" },
  "social":             { icon: "search",  color: "text-indigo-500 bg-indigo-500/10" },
  "document":           { icon: "pen",     color: "text-teal-500 bg-teal-500/10" },
  "infographic":        { icon: "chart",   color: "text-amber-500 bg-amber-500/10" },
  "development":        { icon: "code",    color: "text-blue-500 bg-blue-500/10" },
  "writing":            { icon: "pen",     color: "text-purple-500 bg-purple-500/10" },
  "analysis":           { icon: "chart",   color: "text-green-500 bg-green-500/10" },
  "design":             { icon: "palette", color: "text-pink-500 bg-pink-500/10" },
  "productivity":       { icon: "zap",     color: "text-yellow-500 bg-yellow-500/10" },
  "research":           { icon: "search",  color: "text-cyan-500 bg-cyan-500/10" },
  "other":              { icon: "box",     color: "text-gray-500 bg-gray-500/10" },
};

// Category label lookup (matches BUILTIN_CATEGORIES in McpSkillModal)
const CATEGORY_LABELS: Record<string, string> = {
  "teaching": "教研专用", "picturebook": "绘本馆专用", "product-management": "产品经理专用",
  "operations": "运营专用", "video": "视频处理", "image": "图像生成", "writing": "写作内容",
  "social": "社交媒体", "document": "文档工具", "infographic": "信息图表",
  "development": "开发工具", "productivity": "效率工具", "analysis": "数据分析",
  "design": "设计创意", "research": "研究调查", "other": "其他",
};

function getSkillCategory(skill: SkillInfo): string {
  if (skill.category && skill.category in SKILL_CATEGORY_CONFIG) return skill.category;
  const text = (skill.name + " " + (skill.description || "")).toLowerCase();
  if (text.includes("code") || text.includes("dev") || text.includes("程序") || text.includes("开发") || text.includes("debug")) return "development";
  if (text.includes("write") || text.includes("写作") || text.includes("文档") || text.includes("blog") || text.includes("article")) return "writing";
  if (text.includes("data") || text.includes("分析") || text.includes("chart") || text.includes("数据") || text.includes("report")) return "analysis";
  if (text.includes("design") || text.includes("设计") || text.includes("ui") || text.includes("ux") || text.includes("创意")) return "design";
  if (text.includes("效率") || text.includes("productivity") || text.includes("automat") || text.includes("自动")) return "productivity";
  if (text.includes("research") || text.includes("调研") || text.includes("搜索") || text.includes("search")) return "research";
  return skill.category || "other";
}

function groupSkillsByCategory(skills: SkillInfo[]): { category: string; label: string; skills: SkillInfo[] }[] {
  const groups: Record<string, SkillInfo[]> = {};
  for (const skill of skills) {
    const cat = getSkillCategory(skill);
    (groups[cat] ??= []).push(skill);
  }
  return Object.entries(groups).map(([cat, items]) => ({
    category: cat,
    label: CATEGORY_LABELS[cat] || cat,
    skills: items,
  }));
}

// Skill icon component
function SkillIcon({ type, className = "" }: { type: string; className?: string }) {
  switch (type) {
    case "code":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "pen":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        </svg>
      );
    case "chart":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case "palette":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="13.5" cy="6.5" r="1.5" />
          <circle cx="17.5" cy="10.5" r="1.5" />
          <circle cx="8.5" cy="7.5" r="1.5" />
          <circle cx="6.5" cy="12.5" r="1.5" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
        </svg>
      );
    case "zap":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
      );
  }
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "深夜好，有什么想让我做的吗？";
  if (hour < 12) return "早上好，有什么想让我做的吗？";
  if (hour < 14) return "中午好，有什么想让我做的吗？";
  if (hour < 18) return "下午好，有什么想让我做的吗？";
  return "晚上好，有什么想让我做的吗？";
}

const QUICK_ACTIONS = [
  { id: "guide", label: "引导帮助", prompt: "" },
  { id: "write", label: "写作", prompt: "帮我写作：" },
  { id: "ppt", label: "PPT", prompt: "帮我制作一份PPT，主题是：" },
  { id: "research", label: "调研报告", prompt: "帮我撰写一份调研报告，主题是：" },
  { id: "analysis", label: "需求分析", prompt: "帮我分析以下需求：" },
  { id: "video", label: "视频", prompt: "帮我制作视频脚本，主题是：" },
  { id: "design", label: "设计", prompt: "帮我设计：" },
  { id: "excel", label: "Excel", prompt: "帮我处理Excel数据：" },
  { id: "code", label: "编程", prompt: "帮我编写代码：" },
] as const;

interface PromptInputProps {
  sendEvent: (event: ClientEvent) => void;
  sidebarWidth: number;
  rightPanelWidth?: number;
  onHeightChange?: (height: number) => void;
}

/**
 * 从助理配置的技能列表中找到最匹配当前 prompt 的技能。
 * - 只有 1 个技能：直接返回
 * - 多个技能：按 prompt 与技能名/描述关键词的匹配度打分，返回最高分
 */
function findBestSkill(prompt: string, availableSkills: SkillInfo[]): SkillInfo | null {
  if (availableSkills.length === 0) return null;
  if (availableSkills.length === 1) return availableSkills[0];

  const lower = prompt.toLowerCase();
  let bestScore = -1;
  let best = availableSkills[0];

  for (const skill of availableSkills) {
    let score = 0;
    if (lower.includes(skill.name.toLowerCase())) score += 3;
    const keywords = (skill.description || "")
      .toLowerCase()
      .split(/[\s,，。.!?！？、]+/)
      .filter((w) => w.length > 1);
    for (const kw of keywords) {
      if (lower.includes(kw)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = skill; }
  }
  return best;
}

export interface UsePromptActionsOptions {
  /** 当前可用的技能列表（来自组件 state） */
  skills?: SkillInfo[];
  /** 用户当前主动选中的技能名（null = 未手动选择） */
  activeSkillName?: string | null;
  /** 自动选中技能后的回调（用于更新工具栏） */
  onAutoSelectSkill?: (skill: SkillInfo) => void;
}

export function usePromptActions(
  sendEvent: (event: ClientEvent) => void,
  options: UsePromptActionsOptions = {},
) {
  const { skills: optionSkills, activeSkillName, onAutoSelectSkill } = options;

  const prompt = useAppStore((state) => state.prompt);
  const cwd = useAppStore((state) => state.cwd);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const setPrompt = useAppStore((state) => state.setPrompt);
  const setPendingStart = useAppStore((state) => state.setPendingStart);
  const setGlobalError = useAppStore((state) => state.setGlobalError);
  const provider = useAppStore((state) => state.provider);
  const assistantModel = useAppStore((state) => state.assistantModel);
  const selectedAssistantId = useAppStore((state) => state.selectedAssistantId);
  const selectedAssistantSkillNames = useAppStore((state) => state.selectedAssistantSkillNames);
  const selectedAssistantPersona = useAppStore((state) => state.selectedAssistantPersona);

  // Attachments - images, files and folders
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string; isImage: boolean; isDir: boolean; preview?: string }>>([]);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isRunning = activeSession?.status === "running";

  const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tiff", "avif"]);
  const isImagePath = (p: string) => IMAGE_EXTS.has((p.split(".").pop() ?? "").toLowerCase());

  const addAttachment = useCallback((filePath: string, isDir = false) => {
    const name = filePath.split("/").pop() ?? filePath;
    const img = !isDir && isImagePath(filePath);
    setAttachments(prev => {
      if (prev.some(a => a.path === filePath)) return prev;
      return [...prev, { path: filePath, name, isImage: img, isDir }];
    });
    // Load thumbnail asynchronously for images
    if (img) {
      window.electron.getImageThumbnail(filePath).then(dataUrl => {
        if (dataUrl) {
          setAttachments(prev => prev.map(a => a.path === filePath ? { ...a, preview: dataUrl } : a));
        }
      }).catch(() => {});
    }
  }, []);

  // Handle file/folder selection via button
  const handleSelectImage = useCallback(async () => {
    try {
      const items = await window.electron.selectFile();
      if (items) {
        items.forEach(({ path, isDir }) => addAttachment(path, isDir));
      }
    } catch (error) {
      console.error("Failed to select file:", error);
      setGlobalError("Failed to select file.");
    }
  }, [addAttachment, setGlobalError]);

  const handleRemoveImage = useCallback((path?: string) => {
    if (path) {
      setAttachments(prev => prev.filter(a => a.path !== path));
    } else {
      setAttachments([]);
    }
  }, []);

  // Handle pasted image
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    // Priority 1: files/folders pasted from Finder (Cmd+C → Cmd+V)
    const pastedFiles = e.clipboardData ? Array.from(e.clipboardData.files) : [];
    const filePaths: Array<{ path: string; isDir: boolean }> = [];

    for (const file of pastedFiles) {
      let filePath = "";
      try { filePath = window.electron.getPathForFile(file); } catch { filePath = ""; }
      if (filePath) {
        const isDir = file.type === "" && file.size === 0;
        filePaths.push({ path: filePath, isDir });
      }
    }

    if (filePaths.length > 0) {
      e.preventDefault();
      filePaths.forEach(({ path, isDir }) => addAttachment(path, isDir));
      return;
    }

    // Priority 2: inline image data (screenshots, copied images)
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              resolve(dataUrl.split(",")[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          const path = await window.electron.savePastedImage(base64, item.type);
          if (path) {
            addAttachment(path);
          }
        } catch (error) {
          console.error("Failed to handle pasted image:", error);
          setGlobalError("Failed to paste image.");
        }
        break;
      }
    }
  }, [addAttachment, setGlobalError]);

  // Handle file drop
  const handleDrop = useCallback(async (dataTransfer: DataTransfer) => {
    const files = Array.from(dataTransfer.files);
    for (const file of files) {
      // Electron 32+: use webUtils.getPathForFile() — File.path was removed
      let filePath = "";
      try {
        filePath = window.electron.getPathForFile(file);
      } catch {
        filePath = "";
      }
      if (filePath) {
        // Detect folder: dragged folders have file.type === "" and size === 0
        const isDir = file.type === "" && file.size === 0;
        addAttachment(filePath, isDir);
      } else if (file.type.startsWith("image/")) {
        // Fallback for images when path is unavailable
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const path = await window.electron.savePastedImage(base64, file.type);
          if (path) addAttachment(path);
        } catch (error) {
          console.error("Failed to handle dropped image:", error);
        }
      }
    }
  }, [addAttachment]);

  // Backward compat: imagePath is the first image attachment (if any)
  const imagePath = attachments.find(a => a.isImage)?.path ?? null;

  const handleSend = useCallback(async () => {
    if (!prompt.trim() && attachments.length === 0) return;

    let finalPrompt = prompt.trim();
    const hasAttachments = attachments.length > 0;

    if (hasAttachments) {
      const parts: string[] = [];
      for (const att of attachments) {
        if (att.isImage) {
          parts.push(`请分析这张图片: ${att.path}`);
        } else if (att.isDir) {
          parts.push(`请列出并分析这个文件夹: ${att.path}`);
        } else {
          parts.push(`请读取并分析这个文件: ${att.path}`);
        }
      }
      const attachmentText = parts.join("\n");
      finalPrompt = finalPrompt ? `${attachmentText}\n\n${finalPrompt}` : attachmentText;
      setAttachments([]);
    }

    // Determine if we need a new session:
    // 1. No active session
    // 2. Active session's provider differs from selected provider
    // 3. Active session's assistant differs from selected assistant
    // 4. Requests with attachments should always start a fresh session
    const activeProvider = activeSession?.provider ?? "claude";
    const activeAssistantId = activeSession?.assistantId;
    const assistantChanged = Boolean(selectedAssistantId) && activeAssistantId !== selectedAssistantId;
    const needNewSession = hasAttachments || !activeSessionId || (activeProvider !== provider) || assistantChanged;

    if (needNewSession) {
      // ── 自动选择技能 ──────────────────────────────────────────────────────────
      // 若用户未手动指定技能，且助理配置了技能，则按 prompt 关键词自动匹配最合适的
      let resolvedSkillNames: string[] | undefined;
      if (!activeSkillName && selectedAssistantSkillNames.length > 0) {
        const assistantSkills = (optionSkills ?? []).filter((s) =>
          selectedAssistantSkillNames.includes(s.name)
        );
        const best = findBestSkill(finalPrompt, assistantSkills);
        if (best) {
          resolvedSkillNames = [best.name];
          onAutoSelectSkill?.(best);
        } else {
          resolvedSkillNames = selectedAssistantSkillNames;
        }
      } else if (activeSkillName) {
        // 用户手动选择了技能，只用这一个
        resolvedSkillNames = [activeSkillName];
      } else {
        resolvedSkillNames = selectedAssistantSkillNames.length > 0
          ? selectedAssistantSkillNames
          : undefined;
      }

      let title = "";
      try {
        setPendingStart(true);
        title = await window.electron.generateSessionTitle(finalPrompt);
      } catch (error) {
        console.error(error);
        setPendingStart(false);
        setGlobalError("Failed to get session title.");
        return;
      }
      sendEvent({
        type: "session.start",
        payload: {
          title,
          prompt: finalPrompt,
          cwd: cwd.trim() || undefined,
          allowedTools: DEFAULT_ALLOWED_TOOLS,
          provider,
          ...(assistantModel ? { model: assistantModel } : {}),
          ...(selectedAssistantId ? { assistantId: selectedAssistantId } : {}),
          ...(selectedAssistantPersona ? { assistantPersona: selectedAssistantPersona } : {}),
          ...(resolvedSkillNames ? { assistantSkillNames: resolvedSkillNames } : {}),
        }
      });
    } else {
      if (activeSession?.status === "running") {
        setGlobalError("Session is still running. Please wait for it to finish.");
        return;
      }
      sendEvent({ type: "session.continue", payload: { sessionId: activeSessionId, prompt: finalPrompt } });
    }
    setPrompt("");
  }, [activeSession, activeSessionId, cwd, attachments, prompt, provider, assistantModel, selectedAssistantId, selectedAssistantSkillNames, selectedAssistantPersona, sendEvent, setGlobalError, setPendingStart, setPrompt, activeSkillName, optionSkills, onAutoSelectSkill]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    sendEvent({ type: "session.stop", payload: { sessionId: activeSessionId } });
  }, [activeSessionId, sendEvent]);

  // handleStartFromModal can be called with optional params (for scheduled tasks)
  const handleStartFromModal = useCallback((params?: { prompt?: string; cwd?: string; title?: string; assistantId?: string }) => {
    const effectiveCwd = params?.cwd || cwd.trim();
    const effectivePrompt = params?.prompt || prompt.trim();
    const effectiveTitle = params?.title;
    
    if (!effectiveCwd) {
      setGlobalError("Working Directory is required to start a session.");
      return;
    }
    
    if (!effectivePrompt) {
      setGlobalError("Prompt is required to start a session.");
      return;
    }
    
    // If params provided, directly start session (for scheduled tasks)
    if (params?.prompt) {
      setPendingStart(true);
      // Task's assistantId takes priority over currently selected assistant
      const effectiveAssistantId = params.assistantId || selectedAssistantId;
      sendEvent({
        type: "session.start",
        payload: { 
          title: effectiveTitle || "定时任务", 
          prompt: effectivePrompt, 
          cwd: effectiveCwd, 
          allowedTools: DEFAULT_ALLOWED_TOOLS,
          provider,
          ...(assistantModel ? { model: assistantModel } : {}),
          ...(effectiveAssistantId ? { assistantId: effectiveAssistantId } : {}),
          ...(selectedAssistantPersona ? { assistantPersona: selectedAssistantPersona } : {}),
        }
      });
      return;
    }
    
    // Otherwise use normal flow
    handleSend();
  }, [cwd, prompt, handleSend, sendEvent, setGlobalError, setPendingStart, provider, assistantModel, selectedAssistantId, selectedAssistantSkillNames, selectedAssistantPersona]);

  return { 
    prompt, 
    setPrompt, 
    isRunning, 
    imagePath,
    attachments,
    handleSend, 
    handleStop, 
    handleStartFromModal,
    handleSelectImage,
    handleRemoveImage,
    handlePaste,
    handleDrop,
  };
}

export function PromptInput({ sendEvent, sidebarWidth, rightPanelWidth = 0, onHeightChange }: PromptInputProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  const selectedAssistantSkillNames = useAppStore((state) => state.selectedAssistantSkillNames);
  const selectedAssistantSkillTags = useAppStore((state) => state.selectedAssistantSkillTags);
  const hasMessages = useAppStore((state) => {
    const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
    return (session?.messages?.length ?? 0) > 0;
  });
  const provider = useAppStore((state) => state.provider);
  void provider;

  // Skills state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [skillFilter, setSkillFilter] = useState("");
  const skillListRef = useRef<HTMLDivElement | null>(null);

  // Toolbar skill button state
  const [activeToolbarSkill, setActiveToolbarSkill] = useState<SkillInfo | null>(null);
  const [showToolbarSkillPicker, setShowToolbarSkillPicker] = useState(false);
  const [toolbarSkillFilter, setToolbarSkillFilter] = useState("");
  const [toolbarSkillSelectedIndex, setToolbarSkillSelectedIndex] = useState(0);
  const toolbarSkillListRef = useRef<HTMLDivElement | null>(null);
  const toolbarSkillPickerRef = useRef<HTMLDivElement | null>(null);
  const toolbarSkillBtnRef = useRef<HTMLButtonElement | null>(null);

  // 切换助理时，重置工具栏技能（让下次发送时重新自动匹配）
  const prevAssistantSkillKeyRef = useRef(selectedAssistantSkillNames.join(","));
  useEffect(() => {
    const key = selectedAssistantSkillNames.join(",");
    if (key !== prevAssistantSkillKeyRef.current) {
      prevAssistantSkillKeyRef.current = key;
      setActiveToolbarSkill(null);
    }
  }, [selectedAssistantSkillNames]);

  const [isDragOver, setIsDragOver] = useState(false);
  // Use state-based ref so useEffect re-runs when the div remounts (e.g. hasMessages toggle)
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const inputCardRef = useCallback((el: HTMLDivElement | null) => { setCardEl(el); }, []);

  const { 
    prompt, 
    setPrompt, 
    isRunning, 
    attachments,
    handleSend, 
    handleStop,
    handleSelectImage,
    handleRemoveImage,
    handlePaste,
    handleDrop,
  } = usePromptActions(sendEvent, {
    skills,
    activeSkillName: activeToolbarSkill?.name ?? null,
    onAutoSelectSkill: setActiveToolbarSkill,
  });

  // Native DOM listeners — React synthetic events are unreliable in Electron for file drops
  useEffect(() => {
    const el = cardEl;
    if (!el) return;

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (!el.contains(e.relatedTarget as Node)) {
        setIsDragOver(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (e.dataTransfer) handleDrop(e.dataTransfer);
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [cardEl, handleDrop]);

  // Report height changes to parent so scroll area can adjust padding
  useEffect(() => {
    if (!onHeightChange) return;
    const el = sectionRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeightChange(el.offsetHeight));
    ro.observe(el);
    onHeightChange(el.offsetHeight);
    return () => ro.disconnect();
  }, [onHeightChange]);

  // Memory indicator state
  const [memorySummary, setMemorySummary] = useState<{ longTermSize: number; dailyCount: number; totalSize: number } | null>(null);
  const [showMemoryTooltip, setShowMemoryTooltip] = useState(false);

  // Sync skills from global store
  const globalSkills = useAppStore((s) => s.skills);
  useEffect(() => {
    setSkills(globalSkills);
  }, [globalSkills]);

  // Load memory summary on mount
  useEffect(() => {
    window.electron.memoryList().then((list) => {
      setMemorySummary(list.summary);
    }).catch(console.error);
  }, []);

  // Filter skills based on input — only show skills the current assistant owns
  const filteredSkills = skills.filter(skill => {
    // If assistant has configured skills, only show those
    if (selectedAssistantSkillNames.length > 0) {
      if (!selectedAssistantSkillNames.includes(skill.name)) return false;
    }
    const filter = skillFilter.toLowerCase().replace(/^\//, "");
    return skill.name.toLowerCase().includes(filter) ||
      (skill.label || "").toLowerCase().includes(filter) ||
      (skill.description || "").toLowerCase().includes(filter);
  });

  // Filter skills for toolbar picker
  const toolbarFilteredSkills = skills.filter(skill => {
    if (selectedAssistantSkillNames.length > 0) {
      if (!selectedAssistantSkillNames.includes(skill.name)) return false;
    }
    const filter = toolbarSkillFilter.toLowerCase();
    return skill.name.toLowerCase().includes(filter) ||
      (skill.label || "").toLowerCase().includes(filter) ||
      (skill.description || "").toLowerCase().includes(filter);
  });

  // Close toolbar skill picker when clicking outside (exclude the toggle button itself)
  useEffect(() => {
    if (!showToolbarSkillPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insidePicker = toolbarSkillPickerRef.current?.contains(target);
      const insideBtn = toolbarSkillBtnRef.current?.contains(target);
      if (!insidePicker && !insideBtn) {
        setShowToolbarSkillPicker(false);
        setToolbarSkillFilter("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showToolbarSkillPicker]);

  // Check if we should show skills selector, and sync toolbar skill state with prompt
  useEffect(() => {
    const trimmed = prompt.trimStart();
    // Show skills selector only when:
    // 1. Prompt starts with /
    // 2. No space after the slash command (still typing the command name)
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      const filterPart = trimmed;
      setSkillFilter(filterPart);
      setShowSkills(true);
      setSelectedIndex(0);
    } else {
      setShowSkills(false);
      setSkillFilter("");
    }

    // If toolbar shows an active skill but the prompt no longer has its prefix, clear it
    setActiveToolbarSkill(prev => {
      if (!prev) return prev;
      const expectedPrefix = `/${prev.name} `;
      return trimmed.startsWith(expectedPrefix) ? prev : null;
    });
  }, [prompt]);

  // Scroll selected item into view
  useEffect(() => {
    if (showSkills && skillListRef.current) {
      const selectedElement = skillListRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex, showSkills]);

  const handleSelectSkill = useCallback(async (skill: SkillInfo) => {
    setShowSkills(false);
    setActiveToolbarSkill(skill);
    
    // Read full skill content
    try {
      const content = await window.electron.readSkillContent(skill.fullPath);
      if (content) {
        // Get current session ID
        const state = useAppStore.getState();
        const sessionId = state.activeSessionId;
        
        if (sessionId) {
          // Add skill_loaded message to the session
          state.addLocalMessage(sessionId, {
            type: "skill_loaded",
            skillName: skill.name,
            skillContent: content,
            skillDescription: skill.description
          });
        }
        
        // Also set prompt with skill slash command for Claude to use
        setPrompt(`/${skill.name} `);
      } else {
        // Fallback if content couldn't be loaded
        setPrompt(`/${skill.name} `);
      }
    } catch (error) {
      console.error("Failed to load skill content:", error);
      setPrompt(`/${skill.name} `);
    }
    
    promptRef.current?.focus();
  }, [setPrompt]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle skill selection navigation
    if (showSkills && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredSkills.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        handleSelectSkill(filteredSkills[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSkills(false);
        return;
      }
    }

    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (isRunning) { handleStop(); return; }
    handleSend();
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    target.style.height = "auto";
    const scrollHeight = target.scrollHeight;
    if (scrollHeight > MAX_HEIGHT) {
      target.style.height = `${MAX_HEIGHT}px`;
      target.style.overflowY = "auto";
    } else {
      target.style.height = `${scrollHeight}px`;
      target.style.overflowY = "hidden";
    }
  };

  useEffect(() => {
    if (!promptRef.current) return;
    promptRef.current.style.height = "auto";
    const scrollHeight = promptRef.current.scrollHeight;
    if (scrollHeight > MAX_HEIGHT) {
      promptRef.current.style.height = `${MAX_HEIGHT}px`;
      promptRef.current.style.overflowY = "auto";
    } else {
      promptRef.current.style.height = `${scrollHeight}px`;
      promptRef.current.style.overflowY = "hidden";
    }
  }, [prompt]);

  const skillsDropdown = showSkills ? (
    <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-ink-900/[0.06] bg-surface/95 backdrop-blur-xl shadow-[0_8px_40px_-12px_rgba(0,0,0,0.15),0_0_0_1px_rgba(0,0,0,0.03)] overflow-hidden z-50">
      {filteredSkills.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-900/[0.04] mb-3">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <p className="text-[13px] font-medium text-ink-600">
            {skills.length === 0 ? "暂无可用技能" : "没有匹配的技能"}
          </p>
          <p className="mt-1 text-xs text-muted">输入关键词筛选，或按 Esc 取消</p>
        </div>
      ) : (
        <div ref={skillListRef} className="max-h-[320px] overflow-y-auto overflow-x-hidden py-1.5 px-1.5">
          {(() => {
            const groups = groupSkillsByCategory(filteredSkills);
            let flatIdx = 0;
            return groups.map((group) => {
              const startIdx = flatIdx;
              const items = group.skills.map((skill) => {
                const idx = flatIdx++;
                const category = getSkillCategory(skill);
                const config = SKILL_CATEGORY_CONFIG[category] || SKILL_CATEGORY_CONFIG.other;
                const isActive = idx === selectedIndex;
                return (
                  <button
                    key={skill.name}
                    className={`group w-full px-3 py-2.5 text-left flex items-center gap-3 rounded-xl transition-all duration-150 ${
                      isActive
                        ? "bg-accent/[0.08] ring-1 ring-accent/20"
                        : "hover:bg-ink-900/[0.04]"
                    }`}
                    onClick={() => handleSelectSkill(skill)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className={`flex h-8 w-8 items-center justify-center rounded-[10px] flex-shrink-0 transition-colors ${
                      isActive ? config.color.replace(/\/10/, "/15") : config.color
                    }`}>
                      <SkillIcon type={config.icon} className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[13px] font-medium leading-tight truncate transition-colors ${
                        isActive ? "text-accent" : "text-ink-800"
                      }`}>
                        {skill.label || skill.name}
                      </div>
                      {skill.description && (
                        <div className="text-[11px] text-muted mt-0.5 truncate">{skill.description}</div>
                      )}
                    </div>
                  </button>
                );
              });
              void startIdx;
              return (
                <div key={group.category}>
                  {groups.length > 1 && (
                    <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted/60">
                      {group.label}
                    </div>
                  )}
                  {items}
                </div>
              );
            });
          })()}
        </div>
      )}
      <div className="border-t border-ink-900/[0.04] px-3.5 py-1.5 flex items-center gap-3 text-[11px] text-muted/70">
        <span className="flex items-center gap-1"><kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] bg-ink-900/[0.05] px-1 font-mono text-[10px] leading-none">↑↓</kbd>选择</span>
        <span className="flex items-center gap-1"><kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] bg-ink-900/[0.05] px-1 font-mono text-[10px] leading-none">Tab</kbd>确认</span>
        <span className="flex items-center gap-1"><kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] bg-ink-900/[0.05] px-1 font-mono text-[10px] leading-none">Esc</kbd>取消</span>
        <span className="ml-auto text-muted/50">{filteredSkills.length} 项</span>
      </div>
    </div>
  ) : null;

  const toolbarSkillPickerDropdown = showToolbarSkillPicker ? (
    <div ref={toolbarSkillPickerRef} className="absolute bottom-full left-0 mb-2 w-72 rounded-2xl border border-ink-900/[0.06] bg-surface/95 backdrop-blur-xl shadow-[0_8px_40px_-12px_rgba(0,0,0,0.15),0_0_0_1px_rgba(0,0,0,0.03)] overflow-hidden z-50">
      <div className="px-2.5 pt-2.5 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-ink-900/[0.04] px-2.5 py-2">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted/60 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            autoFocus
            type="text"
            placeholder="搜索技能..."
            value={toolbarSkillFilter}
            onChange={e => {
              setToolbarSkillFilter(e.target.value);
              setToolbarSkillSelectedIndex(0);
            }}
            onKeyDown={e => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setToolbarSkillSelectedIndex(prev => (prev + 1) % Math.max(1, toolbarFilteredSkills.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setToolbarSkillSelectedIndex(prev => (prev - 1 + Math.max(1, toolbarFilteredSkills.length)) % Math.max(1, toolbarFilteredSkills.length));
              } else if (e.key === "Enter" && toolbarFilteredSkills[toolbarSkillSelectedIndex]) {
                e.preventDefault();
                const skill = toolbarFilteredSkills[toolbarSkillSelectedIndex];
                handleSelectSkill(skill);
                setActiveToolbarSkill(skill);
                setShowToolbarSkillPicker(false);
                setToolbarSkillFilter("");
              } else if (e.key === "Escape") {
                setShowToolbarSkillPicker(false);
                setToolbarSkillFilter("");
              }
            }}
            className="flex-1 bg-transparent text-[13px] text-ink-800 placeholder:text-muted/50 focus:outline-none"
          />
        </div>
      </div>
      {toolbarFilteredSkills.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-[13px] text-muted">{skills.length === 0 ? "暂无可用技能" : "没有匹配的技能"}</p>
        </div>
      ) : (
        <div ref={toolbarSkillListRef} className="max-h-56 overflow-y-auto py-1 px-1.5">
          {(() => {
            const groups = groupSkillsByCategory(toolbarFilteredSkills);
            let flatIdx = 0;
            return groups.map((group) => {
              const items = group.skills.map((skill) => {
                const idx = flatIdx++;
                const category = getSkillCategory(skill);
                const config = SKILL_CATEGORY_CONFIG[category] || SKILL_CATEGORY_CONFIG.other;
                const isActive = idx === toolbarSkillSelectedIndex;
                return (
                  <button
                    key={skill.name}
                    className={`w-full px-2.5 py-2 text-left flex items-center gap-2.5 rounded-xl transition-all duration-150 ${
                      isActive
                        ? "bg-accent/[0.08] ring-1 ring-accent/20"
                        : "hover:bg-ink-900/[0.04]"
                    }`}
                    onClick={() => {
                      handleSelectSkill(skill);
                      setActiveToolbarSkill(skill);
                      setShowToolbarSkillPicker(false);
                      setToolbarSkillFilter("");
                    }}
                    onMouseEnter={() => setToolbarSkillSelectedIndex(idx)}
                  >
                    <div className={`flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 ${config.color}`}>
                      <SkillIcon type={config.icon} className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[12px] font-medium truncate transition-colors ${isActive ? "text-accent" : "text-ink-800"}`}>
                        {skill.label || skill.name}
                      </div>
                      {skill.description && (
                        <div className="text-[11px] text-muted mt-px truncate">{skill.description}</div>
                      )}
                    </div>
                  </button>
                );
              });
              return (
                <div key={group.category}>
                  {groups.length > 1 && (
                    <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted/60">
                      {group.label}
                    </div>
                  )}
                  {items}
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  ) : null;

  const inputCard = (
    <div
      ref={inputCardRef}
      className={`w-full rounded-2xl border bg-white shadow-[0_2px_12px_rgba(0,0,0,0.06),0_1px_3px_rgba(0,0,0,0.04)] transition-colors ${
        isDragOver
          ? "border-accent/60 bg-accent/[0.02] shadow-[0_0_0_2px_rgba(var(--color-accent-rgb),0.15)]"
          : "border-black/[0.07]"
      }`}
    >
      {/* Attachments Preview */}
      {attachments.length > 0 && (
        <div className="mx-3 mt-3">
          <div className="flex flex-wrap gap-2 max-h-44 overflow-y-auto pt-2 pr-2">
            {attachments.map((att) => (
              att.isImage ? (
                /* Image: thumbnail card */
                <div key={att.path} className="relative group flex-shrink-0">
                  <div className="h-16 w-16 rounded-xl overflow-hidden border border-ink-900/10 bg-surface-secondary flex items-center justify-center">
                    {att.preview ? (
                      <img src={att.preview} alt={att.name} className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <svg className="h-6 w-6 text-ink-300 animate-pulse" viewBox="0 0 24 24" fill="none">
                        <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemoveImage(att.path)}
                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink-800 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                  </button>
                </div>
              ) : (
                /* File or Folder: compact chip */
                <div key={att.path} className="group flex items-center gap-2 rounded-xl border border-ink-900/8 bg-surface-secondary pl-2.5 pr-1.5 py-1.5 max-w-[200px]">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 ${att.isDir ? "bg-yellow-500/10" : "bg-blue-500/10"}`}>
                    {att.isDir ? (
                      <svg className="h-3.5 w-3.5 text-yellow-600" viewBox="0 0 24 24" fill="none">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <svg className="h-3.5 w-3.5 text-blue-500" viewBox="0 0 24 24" fill="none">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        <polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-ink-700 truncate leading-tight">{att.name}</div>
                    <div className="text-[10px] text-muted uppercase leading-tight">
                      {att.isDir ? "文件夹" : (att.name.split(".").pop() || "文件")}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveImage(att.path)}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-ink-900/10 hover:text-ink-700 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                  </button>
                </div>
              )
            ))}
          </div>
          {/* Batch remove all */}
          {attachments.length > 1 && (
            <button
              onClick={() => handleRemoveImage()}
              className="mt-1.5 text-[11px] text-muted hover:text-ink-600 transition-colors"
            >
              清除全部 ({attachments.length})
            </button>
          )}
        </div>
      )}

      {/* Drag overlay hint */}
      {isDragOver && (
        <div className="mx-3 mt-3 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/40 bg-accent/5 px-4 py-3 gap-2 text-sm text-accent">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
          </svg>
          松开以添加图片或文件（支持批量）
        </div>
      )}

      {/* Textarea */}
      <div className="px-4 pt-4 pb-2">
        <textarea
          rows={hasMessages ? 1 : 3}
          className="w-full resize-none bg-transparent text-sm text-ink-800 placeholder:text-ink-400/60 focus:outline-none leading-relaxed"
          placeholder={attachments.length > 0 ? "为附件添加说明（可选）..." : "帮我把这个想法变成一个技术方案"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          ref={promptRef}
          disabled={isRunning}
        />
      </div>

      {/* Divider */}
      <div className="h-px bg-black/[0.05] mx-3" />

      {/* Toolbar */}
      <div className="flex items-center justify-between px-2.5 py-2">
        {/* Left icons */}
        <div className="flex items-center gap-0.5">
          {/* Attach */}
          <button
            onClick={handleSelectImage}
            disabled={isRunning}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-surface-secondary hover:text-ink-700 disabled:opacity-40"
            title="附件"
          >
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {/* Skill picker button */}
          {activeToolbarSkill ? (
            <div className="flex items-center gap-1 rounded-full bg-accent/10 pl-2.5 pr-1.5 py-1 text-xs font-medium text-accent max-w-[140px]">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span className="truncate">{activeToolbarSkill.label || activeToolbarSkill.name}</span>
              <button
                onClick={() => {
                  const prefix = `/${activeToolbarSkill.name} `;
                  const currentPrompt = useAppStore.getState().prompt;
                  setPrompt(currentPrompt.startsWith(prefix) ? currentPrompt.slice(prefix.length) : currentPrompt);
                  setActiveToolbarSkill(null);
                }}
                className="flex-shrink-0 flex h-4 w-4 items-center justify-center rounded-full hover:bg-accent/20 text-accent/70 hover:text-accent transition-colors"
                title="取消技能"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
              </button>
            </div>
          ) : (
            <button
              ref={toolbarSkillBtnRef}
              onClick={() => {
                setShowToolbarSkillPicker(prev => !prev);
                setToolbarSkillFilter("");
                setToolbarSkillSelectedIndex(0);
              }}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                showToolbarSkillPicker
                  ? "bg-accent/10 text-accent"
                  : "bg-ink-900/[0.05] text-ink-500 hover:bg-ink-900/[0.09] hover:text-ink-700"
              }`}
              title="选择技能"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/>
              </svg>
              自动
            </button>
          )}

          {/* Memory indicator (inline with toolbar) */}
          {memorySummary && memorySummary.totalSize > 0 && (
            <div
              className="relative"
              onMouseEnter={() => setShowMemoryTooltip(true)}
              onMouseLeave={() => setShowMemoryTooltip(false)}
            >
              <div className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-accent cursor-pointer">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                </svg>
                <span className="font-medium">记忆</span>
              </div>
              {showMemoryTooltip && (
                <div className="absolute bottom-full left-0 mb-2 w-52 rounded-xl border border-ink-900/10 bg-surface p-3 shadow-elevated z-50">
                  <p className="text-xs font-medium text-ink-800 mb-1.5">记忆系统已激活</p>
                  <div className="grid gap-1 text-[11px] text-muted">
                    <span>长期记忆: {memorySummary.longTermSize > 0 ? `${(memorySummary.longTermSize / 1024).toFixed(1)} KB` : "空"}</span>
                    <span>每日记忆: {memorySummary.dailyCount} 天</span>
                    <span>总计: {(memorySummary.totalSize / 1024).toFixed(1)} KB</span>
                  </div>
                  <p className="text-[10px] text-muted-light mt-1.5">新会话启动时自动注入</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: model + mic + send */}
        <div className="flex items-center gap-1.5">
          {/* Mic */}
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-surface-secondary hover:text-ink-700"
            title="语音输入"
          >
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
            </svg>
          </button>

          {/* Send / Stop */}
          <button
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-all ${
              isRunning
                ? "bg-error text-white hover:bg-error/90"
                : (prompt.trim() || attachments.length > 0)
                  ? "bg-[#2C5F2E] text-white hover:bg-[#2C5F2E]/90 shadow-sm"
                  : "bg-ink-900/8 text-ink-300 cursor-default"
            }`}
            onClick={isRunning ? handleStop : handleSend}
            aria-label={isRunning ? "停止" : "发送"}
          >
            {isRunning ? (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <section
      ref={sectionRef}
      className={
        hasMessages
          ? "fixed bottom-0 left-0 right-0 bg-gradient-to-t from-surface-cream via-surface-cream to-transparent pb-6 px-4 lg:pb-8 pt-12"
          : "fixed inset-0 flex flex-col items-center justify-center px-4 pointer-events-none"
      }
      style={{ marginLeft: `${sidebarWidth}px`, marginRight: `${rightPanelWidth}px`, transition: "margin 0.2s ease" }}
    >
      {hasMessages ? (
        <div className="mx-auto w-full max-w-full lg:max-w-3xl relative">
          {skillsDropdown}
          {toolbarSkillPickerDropdown}
          {inputCard}
        </div>
      ) : (
        <div className="pointer-events-auto w-full max-w-2xl flex flex-col items-center gap-5">
          {/* Keyboard shortcut hint */}
          <div className="flex items-center gap-1.5 rounded-full bg-surface-secondary/80 px-3.5 py-1.5 text-xs text-ink-400 border border-ink-900/[0.05]">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-ink-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6"/>
            </svg>
            <span>⌥ Space 可以随时唤醒AI输入，可在设置中自定义</span>
          </div>

          {/* Greeting */}
          <h1 className="text-2xl font-normal text-ink-900 tracking-[-0.01em] text-center">
            {getGreeting()}
          </h1>

          {/* Input card + skills dropdown */}
          <div className="w-full relative">
            {skillsDropdown}
            {toolbarSkillPickerDropdown}
            {inputCard}
          </div>

          {/* Quick action chips — use assistant skillTags if available */}
          <div className="flex flex-wrap gap-2 justify-center">
            {selectedAssistantSkillTags.length > 0 ? (
              <>
                <button
                  className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium bg-[#2C5F2E] text-white hover:bg-[#2C5F2E]/90 transition-all"
                  onClick={() => { promptRef.current?.focus(); }}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 006 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
                    <path d="M9 18h6M10 22h4"/>
                  </svg>
                  引导帮助
                </button>
                {selectedAssistantSkillTags.map((tag) => (
                  <button
                    key={tag}
                    className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium bg-surface-secondary text-ink-800 hover:bg-surface-tertiary border border-ink-900/[0.08] transition-all"
                    onClick={() => {
                      setPrompt(`帮我${tag}：`);
                      promptRef.current?.focus();
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </>
            ) : (
              QUICK_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all ${
                    action.id === "guide"
                      ? "bg-[#2C5F2E] text-white hover:bg-[#2C5F2E]/90"
                      : "bg-surface-secondary text-ink-800 hover:bg-surface-tertiary border border-ink-900/[0.08]"
                  }`}
                  onClick={() => {
                    if (action.prompt) setPrompt(action.prompt);
                    promptRef.current?.focus();
                  }}
                >
                  {action.id === "guide" && (
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 006 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
                      <path d="M9 18h6M10 22h4"/>
                    </svg>
                  )}
                  {action.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
