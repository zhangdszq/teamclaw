import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent } from "../types";

const COLLAPSED_HEIGHT = 152;
const EXPANDED_HEIGHT = 404;

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
  if (text.includes("code") || text.includes("dev") || text.includes("程序") || text.includes("开发")) return "development";
  if (text.includes("write") || text.includes("写作") || text.includes("文档") || text.includes("blog")) return "writing";
  if (text.includes("data") || text.includes("分析") || text.includes("数据")) return "analysis";
  if (text.includes("design") || text.includes("设计") || text.includes("创意")) return "design";
  if (text.includes("效率") || text.includes("productivity") || text.includes("自动")) return "productivity";
  if (text.includes("research") || text.includes("调研") || text.includes("搜索")) return "research";
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

function QWSkillIcon({ type, className = "" }: { type: string; className?: string }) {
  switch (type) {
    case "code":
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>;
    case "pen":
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /></svg>;
    case "chart":
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>;
    case "palette":
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><circle cx="13.5" cy="6.5" r="1.5" /><circle cx="17.5" cy="10.5" r="1.5" /><circle cx="8.5" cy="7.5" r="1.5" /><circle cx="6.5" cy="12.5" r="1.5" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" /></svg>;
    case "zap":
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>;
    case "search":
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    default:
      return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" /></svg>;
  }
}

export function QuickWindow() {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | null>(null);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);

  // Skill state
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([]);
  const [activeSkill, setActiveSkill] = useState<SkillInfo | null>(null);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [skillSelectedIndex, setSkillSelectedIndex] = useState(0);
  const [slashTriggered, setSlashTriggered] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const skillBtnRef = useRef<HTMLButtonElement>(null);
  const skillFilterRef = useRef<HTMLInputElement>(null);

  const selectedAssistant = assistants.find((a) => a.id === selectedAssistantId);

  const assistantSkillNames = selectedAssistant?.skillNames ?? [];
  const availableSkills = allSkills.filter(
    (s) => assistantSkillNames.length === 0 || assistantSkillNames.includes(s.name)
  );
  const filteredSkills = availableSkills.filter((s) => {
    const f = skillFilter.toLowerCase();
    return s.name.toLowerCase().includes(f) || (s.label || "").toLowerCase().includes(f) || (s.description || "").toLowerCase().includes(f);
  });

  useEffect(() => {
    window.electron.getAssistantsConfig().then((c) => {
      setAssistants(c.assistants ?? []);
      if (c.defaultAssistantId) setSelectedAssistantId(c.defaultAssistantId);
      else if (c.assistants?.length > 0) setSelectedAssistantId(c.assistants[0].id);
    }).catch(console.error);

    window.electron.getClaudeConfig().then((config) => {
      setAllSkills(config.skills ?? []);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    const unsub = window.electron.onQuickWindowShow(() => {
      setPrompt("");
      setSending(false);
      setShowAssistantPicker(false);
      closeSkillPicker();
      setActiveSkill(null);
      setSlashTriggered(false);

      // Sync with main window's selected assistant
      try {
        const saved = localStorage.getItem("vk-cowork-selected-assistant");
        if (saved && assistants.some((a) => a.id === saved)) {
          setSelectedAssistantId(saved);
        }
      } catch {}

      setTimeout(() => inputRef.current?.focus(), 50);
    });
    inputRef.current?.focus();
    return unsub;
  }, [assistants]);

  useEffect(() => {
    if (!showAssistantPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowAssistantPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAssistantPicker]);

  useEffect(() => {
    if (!showSkillPicker) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !skillPickerRef.current?.contains(target) &&
        !skillBtnRef.current?.contains(target)
      ) {
        closeSkillPicker();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSkillPicker]);

  // Detect `/` slash command in prompt
  useEffect(() => {
    const trimmed = prompt.trimStart();
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      const filter = trimmed.slice(1);
      setSkillFilter(filter);
      setSkillSelectedIndex(0);
      if (!showSkillPicker) {
        setSlashTriggered(true);
        openSkillPicker();
      }
    } else if (slashTriggered && showSkillPicker && !trimmed.startsWith("/")) {
      closeSkillPicker();
      setSlashTriggered(false);
    }
  }, [prompt]);

  useEffect(() => {
    setActiveSkill(null);
  }, [selectedAssistantId]);

  function openSkillPicker() {
    setShowSkillPicker(true);
    setSkillFilter("");
    setSkillSelectedIndex(0);
    setShowAssistantPicker(false);
    window.electron.resizeQuickWindow(EXPANDED_HEIGHT);
    setTimeout(() => skillFilterRef.current?.focus(), 80);
  }

  function closeSkillPicker() {
    setShowSkillPicker(false);
    setSkillFilter("");
    setSlashTriggered(false);
    window.electron.resizeQuickWindow(COLLAPSED_HEIGHT);
  }

  function handleSelectSkill(skill: SkillInfo) {
    setActiveSkill(skill);
    const trimmed = prompt.trimStart();
    if (trimmed.startsWith("/")) {
      setPrompt("");
    }
    closeSkillPicker();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleClearSkill() {
    setActiveSkill(null);
    inputRef.current?.focus();
  }

  const sendEvent = useCallback((event: ClientEvent) => {
    window.electron.sendClientEvent(event);
  }, []);

  const handleSend = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending) return;

    setSending(true);
    const assistant = assistants.find((a) => a.id === selectedAssistantId);

    let title = text.slice(0, 50).trim() || "Quick Chat";
    try {
      title = await window.electron.generateSessionTitle(text);
    } catch { /* fallback */ }

    const skillNames = activeSkill
      ? [activeSkill.name]
      : assistant?.skillNames?.length
        ? assistant.skillNames
        : undefined;

    sendEvent({
      type: "session.start",
      payload: {
        title,
        prompt: text,
        cwd: assistant?.defaultCwd || undefined,
        allowedTools: "Read,Edit,Bash",
        provider: assistant?.provider || "claude",
        ...(assistant?.model ? { model: assistant.model } : {}),
        ...(selectedAssistantId ? { assistantId: selectedAssistantId } : {}),
        ...(assistant?.persona ? { assistantPersona: assistant.persona } : {}),
        ...(skillNames ? { assistantSkillNames: skillNames } : {}),
      },
    });

    setPrompt("");
    setSending(false);
    setActiveSkill(null);
    window.electron.showMainWindow();
  }, [prompt, sending, sendEvent, assistants, selectedAssistantId, activeSkill]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSkillPicker && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillSelectedIndex((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillSelectedIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        handleSelectSkill(filteredSkills[skillSelectedIndex]);
        return;
      }
    }

    if (e.key === "Escape") {
      if (showSkillPicker) {
        closeSkillPicker();
        inputRef.current?.focus();
      } else if (showAssistantPicker) {
        setShowAssistantPicker(false);
      } else {
        window.electron.hideQuickWindow();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showSkillPicker && filteredSkills.length > 0) {
        handleSelectSkill(filteredSkills[skillSelectedIndex]);
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="h-screen w-screen p-[6px] box-border" style={{ background: "transparent" }}>
      <div
        className="flex flex-col select-none overflow-hidden rounded-xl h-full"
        style={{
          background: "#FAFAF8",
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.03), 0 8px 32px rgba(0,0,0,0.04), 0 24px 64px rgba(0,0,0,0.03)",
          // @ts-ignore
          WebkitAppRegion: "drag",
        }}
      >
      {/* Drag handle */}
      <div
        className="flex items-center justify-center h-[12px] w-full flex-shrink-0 cursor-grab active:cursor-grabbing"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="w-7 h-[3px] rounded-full bg-ink-900/10" />
      </div>

      {/* Input row */}
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-2.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: "linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%)" }}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>

        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="你想让我做什么..."
          rows={1}
          disabled={sending}
          className="flex-1 resize-none bg-transparent text-[14px] text-ink-800 placeholder:text-ink-900/25 focus:outline-none disabled:opacity-50 leading-relaxed"
          style={{ maxHeight: 64, minHeight: 22 }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 64) + "px";
          }}
        />

        <button
          onClick={handleSend}
          disabled={!prompt.trim() || sending}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white transition-all disabled:opacity-20"
          style={{ background: !prompt.trim() || sending ? "#a0a0a0" : "linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%)" }}
        >
          {sending ? (
            <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          )}
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 pb-3 pt-0.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <div className="flex items-center gap-1" ref={pickerRef}>
          {/* Assistant chip */}
          <button
            onClick={() => { setShowAssistantPicker((v) => !v); if (showSkillPicker) closeSkillPicker(); }}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-medium transition-all ${
              showAssistantPicker
                ? "bg-ink-900/8 text-ink-800"
                : "bg-ink-900/[0.04] text-ink-500 hover:bg-ink-900/8 hover:text-ink-700"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span className="max-w-[72px] truncate">{selectedAssistant?.name || "默认"}</span>
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 opacity-40" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {/* Inline assistant picker */}
          {showAssistantPicker && assistants.length > 0 && (
            <div className="flex items-center gap-1">
              {assistants.map((a) => {
                const isActive = a.id === selectedAssistantId;
                return (
                  <button
                    key={a.id}
                    onClick={() => {
                      setSelectedAssistantId(a.id);
                      setShowAssistantPicker(false);
                      inputRef.current?.focus();
                    }}
                    className={`rounded-full px-2.5 py-[3px] text-[11px] font-medium transition-all ${
                      isActive
                        ? "bg-accent/12 text-accent"
                        : "bg-ink-900/[0.04] text-ink-500 hover:bg-ink-900/8 hover:text-ink-700"
                    }`}
                  >
                    {a.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Skill chip */}
          {!showAssistantPicker && (
            activeSkill ? (
              <div className="flex items-center gap-1 rounded-full bg-accent/10 pl-2 pr-1 py-[3px] text-[10px] font-medium text-accent max-w-[120px]">
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/>
                </svg>
                <span className="truncate">{activeSkill.label || activeSkill.name}</span>
                <button
                  onClick={handleClearSkill}
                  className="flex-shrink-0 flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-accent/20 text-accent/50 hover:text-accent transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="h-2 w-2"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>
                </button>
              </div>
            ) : availableSkills.length > 0 ? (
              <button
                ref={skillBtnRef}
                onClick={() => { showSkillPicker ? closeSkillPicker() : openSkillPicker(); }}
                className={`flex items-center gap-1 rounded-full px-2.5 py-[3px] text-[11px] font-medium transition-all ${
                  showSkillPicker
                    ? "bg-accent/10 text-accent"
                    : "bg-ink-900/[0.04] text-ink-500 hover:bg-ink-900/8 hover:text-ink-700"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18h6M10 22h4M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/>
                </svg>
                技能
              </button>
            ) : null
          )}

          {/* Provider dot */}
          {!showAssistantPicker && (
            <div className="flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-medium text-ink-400">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {selectedAssistant?.provider === "codex" ? "Codex" : "Claude"}
            </div>
          )}
        </div>

        <div className="flex-1" />
        <span className="text-[10px] text-ink-900/20 select-none">
          {sending ? "发送中..." : "⏎ 发送"}
        </span>
      </div>

      {/* Skill picker — expands downward below the toolbar */}
      {showSkillPicker && (
        <div ref={skillPickerRef} className="flex-1 flex flex-col min-h-0 border-t border-ink-900/[0.04]" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="flex items-center gap-2 rounded-xl bg-ink-900/[0.04] px-2.5 py-2">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted/60 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={skillFilterRef}
                type="text"
                placeholder="搜索技能..."
                value={skillFilter}
                onChange={(e) => { setSkillFilter(e.target.value); setSkillSelectedIndex(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSkillSelectedIndex((i) => (i + 1) % Math.max(1, filteredSkills.length));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSkillSelectedIndex((i) => (i - 1 + Math.max(1, filteredSkills.length)) % Math.max(1, filteredSkills.length));
                  } else if (e.key === "Enter" && filteredSkills[skillSelectedIndex]) {
                    e.preventDefault();
                    handleSelectSkill(filteredSkills[skillSelectedIndex]);
                  } else if (e.key === "Escape") {
                    closeSkillPicker();
                    inputRef.current?.focus();
                  }
                }}
                className="flex-1 bg-transparent text-[13px] text-ink-800 placeholder:text-muted/50 focus:outline-none"
              />
            </div>
          </div>

          {filteredSkills.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[13px] text-muted">{allSkills.length === 0 ? "暂无可用技能" : "没有匹配的技能"}</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto py-1 px-1.5">
              {(() => {
                const groups = groupSkillsByCategory(filteredSkills);
                let flatIdx = 0;
                return groups.map((group) => {
                  const items = group.skills.map((skill) => {
                    const idx = flatIdx++;
                    const cat = getSkillCategory(skill);
                    const config = SKILL_CATEGORY_CONFIG[cat] || SKILL_CATEGORY_CONFIG.other;
                    const isActive = idx === skillSelectedIndex;
                    return (
                      <button
                        key={skill.name}
                        className={`w-full px-2.5 py-2 text-left flex items-center gap-2.5 rounded-xl transition-all duration-150 ${
                          isActive
                            ? "bg-accent/[0.08] ring-1 ring-accent/20"
                            : "hover:bg-ink-900/[0.04]"
                        }`}
                        onClick={() => handleSelectSkill(skill)}
                        onMouseEnter={() => setSkillSelectedIndex(idx)}
                      >
                        <div className={`flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 ${config.color}`}>
                          <QWSkillIcon type={config.icon} className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-[12px] font-medium truncate transition-colors ${isActive ? "text-accent" : "text-ink-800"}`}>
                            {skill.label || skill.name}
                          </div>
                          {skill.description && (
                            <div className="text-[10px] text-muted truncate leading-tight mt-0.5">{skill.description}</div>
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
      )}
      </div>
    </div>
  );
}
