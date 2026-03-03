import { useCallback, useEffect, useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";

// Category metadata from remote catalog JSON
interface CatalogCategory {
  id: string;
  label: string;
  icon: string;
  color: string;
  order?: number;
}

// Skill from remote catalog JSON
interface CatalogSkill {
  name: string;
  label?: string;
  description: string;
  category: string;
  installPath: string;
  tags?: string[];
}

// Merged view combining catalog + installed state
interface ViewSkill {
  name: string;
  label?: string;
  description?: string;
  category: string;
  installPath?: string;
  isInstalled: boolean;
  isLocalOnly?: boolean;
  fullPath?: string;
}

// Fallback colors for auto-generated categories (cycles through palette)
const AUTO_COLORS = [
  "text-sky-600 bg-sky-500/10",
  "text-fuchsia-600 bg-fuchsia-500/10",
  "text-lime-600 bg-lime-500/10",
  "text-amber-600 bg-amber-500/10",
  "text-rose-600 bg-rose-500/10",
  "text-teal-600 bg-teal-500/10",
];

// Built-in category definitions — used as fallback when CDN catalog lacks a `categories` field.
// New categories should be added to skills-catalog.json; this list only covers well-known ones.
const BUILTIN_CATEGORIES: CatalogCategory[] = [
  { id: "teaching",           label: "教研专用",     icon: "graduation", color: "text-emerald-600 bg-emerald-500/10", order: 1  },
  { id: "picturebook",        label: "绘本馆专用",   icon: "book-open",  color: "text-rose-500 bg-rose-500/10",      order: 2  },
  { id: "product-management", label: "产品经理专用", icon: "target",     color: "text-violet-600 bg-violet-500/10",  order: 3  },
  { id: "operations",         label: "运营专用",     icon: "trending",   color: "text-orange-600 bg-orange-500/10",  order: 4  },
  { id: "video",              label: "视频处理",     icon: "video",      color: "text-red-500 bg-red-500/10",        order: 4  },
  { id: "image",              label: "图像生成",     icon: "image",      color: "text-orange-500 bg-orange-500/10",  order: 5  },
  { id: "writing",            label: "写作内容",     icon: "pen",        color: "text-purple-500 bg-purple-500/10",  order: 6  },
  { id: "social",             label: "社交媒体",     icon: "share",      color: "text-indigo-500 bg-indigo-500/10",  order: 7  },
  { id: "document",           label: "文档工具",     icon: "file",       color: "text-teal-500 bg-teal-500/10",      order: 8  },
  { id: "infographic",        label: "信息图表",     icon: "layout",     color: "text-amber-500 bg-amber-500/10",    order: 9  },
  { id: "development",        label: "开发工具",     icon: "code",       color: "text-blue-500 bg-blue-500/10",      order: 10 },
  { id: "productivity",       label: "效率工具",     icon: "zap",        color: "text-yellow-500 bg-yellow-500/10",  order: 11 },
  { id: "analysis",           label: "数据分析",     icon: "chart",      color: "text-green-500 bg-green-500/10",    order: 12 },
  { id: "design",             label: "设计创意",     icon: "palette",    color: "text-pink-500 bg-pink-500/10",      order: 13 },
  { id: "research",           label: "研究调查",     icon: "search",     color: "text-cyan-500 bg-cyan-500/10",      order: 14 },
  { id: "other",              label: "其他",         icon: "box",        color: "text-gray-500 bg-gray-500/10",      order: 99 },
];

// Convert kebab-case id to a readable label (e.g. "my-category" → "My Category")
function categoryIdToLabel(id: string): string {
  return id.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Fallback category detection for locally installed skills not in the catalog
function getSkillCategoryFromText(name: string, desc: string): string {
  const text = (name + " " + desc).toLowerCase();
  if (text.includes("product-management") || text.includes("产品经理") || text.includes("prd") || text.includes("roadmap") || text.includes("user-story") || text.includes("jtbd") || text.includes("prioritization")) return "product-management";
  if (text.includes("video") || text.includes("视频") || text.includes("youtube") || text.includes("ffmpeg")) return "video";
  if (text.includes("image") || text.includes("图像") || text.includes("图片") || text.includes("photo") || text.includes("gif")) return "image";
  if (text.includes("social") || text.includes("wechat") || text.includes("twitter") || text.includes("微信") || text.includes("小红书")) return "social";
  if (text.includes("pdf") || text.includes("docx") || text.includes("pptx") || text.includes("xlsx") || text.includes("文档") || text.includes("翻译")) return "document";
  if (text.includes("infographic") || text.includes("信息图") || text.includes("theme")) return "infographic";
  if (text.includes("code") || text.includes("dev") || text.includes("程序") || text.includes("开发") || text.includes("debug") || text.includes("mcp") || text.includes("frontend")) return "development";
  if (text.includes("write") || text.includes("写作") || text.includes("article") || text.includes("blog") || text.includes("comic") || text.includes("漫画")) return "writing";
  if (text.includes("data") || text.includes("分析") || text.includes("chart") || text.includes("数据") || text.includes("report")) return "analysis";
  if (text.includes("design") || text.includes("设计") || text.includes("ui") || text.includes("ux") || text.includes("创意") || text.includes("canvas")) return "design";
  if (text.includes("效率") || text.includes("productivity") || text.includes("automat") || text.includes("自动") || text.includes("feishu") || text.includes("飞书")) return "productivity";
  if (text.includes("research") || text.includes("调研") || text.includes("搜索") || text.includes("search")) return "research";
  return "other";
}

// Build a category config lookup: CDN catalog > built-in fallback > auto-generated
function buildCategoryConfig(
  catalogCategories: CatalogCategory[],
  allCategoryIds: string[]
): Record<string, { icon: string; color: string; label: string; order: number }> {
  const result: Record<string, { icon: string; color: string; label: string; order: number }> = {};

  // 1. Seed with built-in fallback (always available)
  BUILTIN_CATEGORIES.forEach(c => {
    result[c.id] = { icon: c.icon, color: c.color, label: c.label, order: c.order ?? 50 };
  });

  // 2. CDN catalog categories override builtins (CDN is authoritative when available)
  catalogCategories.forEach(c => {
    result[c.id] = { icon: c.icon, color: c.color, label: c.label, order: c.order ?? 50 };
  });

  // 3. Auto-generate config for any category not covered by either source
  let autoIndex = 0;
  for (const id of allCategoryIds) {
    if (!result[id]) {
      result[id] = {
        icon: "box",
        color: AUTO_COLORS[autoIndex % AUTO_COLORS.length],
        label: categoryIdToLabel(id),
        order: 50 + autoIndex,
      };
      autoIndex++;
    }
  }
  return result;
}

// Category icon component
function CategoryIcon({ type, className = "" }: { type: string; className?: string }) {
  switch (type) {
    case "graduation":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
          <path d="M6 12v5c3 3 9 3 12 0v-5" />
        </svg>
      );
    case "book-open":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      );
    case "video":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    case "image":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case "share":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      );
    case "file":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
    case "layout":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
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
          <path d="M2 2l7.586 7.586" />
          <circle cx="11" cy="11" r="2" />
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
    case "target":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      );
    case "trending":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
          <polyline points="17 6 23 6 23 12" />
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

interface McpSkillModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "mcp" | "skill";
}

const CATALOG_URL = "https://s.vipkidstatic.com/fe-static/temp/skills-catalog.json";

export function McpSkillModal({ open, onOpenChange, initialTab = "mcp" }: McpSkillModalProps) {
  const [activeTab, setActiveTab] = useState<"mcp" | "skill">(initialTab);
  const [loading, setLoading] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [skillFilter, setSkillFilter] = useState<"all" | "installed" | "available">("all");

  // Catalog state
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [catalogCategories, setCatalogCategories] = useState<CatalogCategory[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Install skill state
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installingNames, setInstallingNames] = useState<Set<string>>(new Set());
  const [deletingNames, setDeletingNames] = useState<Set<string>>(new Set());
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null);

  // Assistants state — for assigning skills to assistants
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  // After install: pick assistants to assign the newly installed skill
  const [pendingSkillName, setPendingSkillName] = useState<string | null>(null);
  const [assignSelection, setAssignSelection] = useState<Set<string>>(new Set());
  // For existing skill cards: manage which assistants own the skill
  const [managingSkillName, setManagingSkillName] = useState<string | null>(null);
  const [manageSelection, setManageSelection] = useState<Set<string>>(new Set());

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const fetchCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const res = await fetch(`${CATALOG_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCatalog(Array.isArray(data.skills) ? data.skills : []);
      setCatalogCategories(Array.isArray(data.categories) ? data.categories : []);
    } catch (err) {
      console.warn("Failed to fetch skill catalog:", err);
      setCatalog([]);
      setCatalogCategories([]);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadConfig = () => {
    setLoading(true);
    Promise.all([
      window.electron.getClaudeConfig(),
      window.electron.getAssistantsConfig(),
    ]).then(([config, assistantsConfig]) => {
      setMcpServers(config.mcpServers);
      setSkills(config.skills);
      setAssistants(assistantsConfig.assistants ?? []);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  };

  useEffect(() => {
    if (open) {
      loadConfig();
      setShowAddForm(false);
      setSelectedCategory(null);
      setSearchQuery("");
      setSkillFilter("all");
      fetchCatalog();
    }
  }, [open, fetchCatalog]);

  const handleAddServer = async (server: McpServer) => {
    const result = await window.electron.saveMcpServer(server);
    if (result.success) {
      setShowAddForm(false);
      loadConfig();
    }
    return result;
  };

  const handleDeleteServer = async (name: string) => {
    const result = await window.electron.deleteMcpServer(name);
    if (result.success) {
      loadConfig();
    }
    return result;
  };

  const handleInstallSkill = async () => {
    const url = installUrl.trim();
    if (!url) return;
    setInstalling(true);
    setInstallResult(null);
    try {
      const result = await window.electron.installSkill(url);
      setInstallResult({ success: result.success, message: result.message });
      if (result.success) {
        setInstallUrl("");
        loadConfig();
        if (result.skillName) {
          setPendingSkillName(result.skillName);
          setAssignSelection(new Set(assistants.map((a) => a.id)));
        }
      }
    } catch (err) {
      setInstallResult({ success: false, message: String(err) });
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallFromCatalog = async (skill: ViewSkill) => {
    if (!skill.installPath || installingNames.has(skill.name)) return;
    setInstallingNames((prev) => new Set([...prev, skill.name]));
    try {
      const result = await window.electron.installSkill(skill.installPath);
      if (result.success) {
        loadConfig();
        setPendingSkillName(result.skillName);
        setAssignSelection(new Set(assistants.map((a) => a.id)));
        setShowInstallForm(true);
      }
    } catch (err) {
      console.error("Failed to install skill from catalog:", err);
    } finally {
      setInstallingNames((prev) => {
        const next = new Set(prev);
        next.delete(skill.name);
        return next;
      });
    }
  };

  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);

  const handleDeleteSkill = async (skillName: string) => {
    if (deletingNames.has(skillName)) return;
    setDeletingNames((prev) => new Set([...prev, skillName]));
    setConfirmDeleteName(null);
    try {
      await window.electron.deleteSkill(skillName);
      loadConfig();
      if (managingSkillName === skillName) setManagingSkillName(null);
    } catch (err) {
      console.error("Failed to delete skill:", err);
    } finally {
      setDeletingNames((prev) => {
        const next = new Set(prev);
        next.delete(skillName);
        return next;
      });
    }
  };

  // Assign a skill to selected assistants
  const handleAssignSkill = useCallback(async (skillName: string, selectedIds: Set<string>) => {
    const updated = assistants.map((a) => {
      const currentSkills = a.skillNames ?? [];
      const isSelected = selectedIds.has(a.id);
      const hasSkill = currentSkills.includes(skillName);
      if (isSelected && !hasSkill) {
        return { ...a, skillNames: [...currentSkills, skillName] };
      }
      if (!isSelected && hasSkill) {
        return { ...a, skillNames: currentSkills.filter((s) => s !== skillName) };
      }
      return a;
    });
    try {
      const saved = await window.electron.saveAssistantsConfig({
        assistants: updated,
        defaultAssistantId: updated[0]?.id,
      });
      setAssistants(saved.assistants);
    } catch (err) {
      console.error("Failed to assign skill:", err);
    }
  }, [assistants]);

  // Helper: get assistants that own a skill
  const getSkillAssistants = useCallback((skillName: string) => {
    return assistants.filter((a) => (a.skillNames ?? []).includes(skillName));
  }, [assistants]);

  // Build view: catalog as primary source, plus local-only skills appended
  const mergedSkills = useMemo((): ViewSkill[] => {
    const installedMap = new Map(skills.map((s) => [s.name, s]));
    const catalogNames = new Set(catalog.map((s) => s.name));

    // Catalog skills first (with install status overlay)
    const result: ViewSkill[] = catalog.map((cs) => {
      const installed = installedMap.get(cs.name);
      return {
        name: cs.name,
        label: cs.label,
        description: cs.description,
        category: cs.category,
        installPath: cs.installPath,
        isInstalled: !!installed,
        fullPath: installed?.fullPath,
      };
    });

    // Then: locally installed skills NOT in catalog — marked with isLocalOnly
    // Description comes from catalog JSON only; SKILL.md content is not displayed
    for (const s of skills) {
      if (!catalogNames.has(s.name) && !s.name.startsWith(".")) {
        result.push({
          name: s.name,
          label: s.name,
          description: undefined,
          category: getSkillCategoryFromText(s.name, s.description || ""),
          isInstalled: true,
          isLocalOnly: true,
          fullPath: s.fullPath,
        });
      }
    }

    return result;
  }, [skills, catalog]);

  // Group by category (from merged list)
  const skillsByCategory = useMemo(() => {
    const grouped: Record<string, ViewSkill[]> = {};
    for (const skill of mergedSkills) {
      if (!grouped[skill.category]) grouped[skill.category] = [];
      grouped[skill.category].push(skill);
    }
    return grouped;
  }, [mergedSkills]);

  // Build dynamic category config from catalog data + auto-fallback for unknowns
  const categoryConfig = useMemo(() => {
    const allIds = Object.keys(skillsByCategory);
    return buildCategoryConfig(catalogCategories, allIds);
  }, [catalogCategories, skillsByCategory]);

  // Available categories sorted by catalog-defined order, unknowns last
  const availableCategories = useMemo(() => {
    return Object.keys(skillsByCategory).sort((a, b) => {
      const ao = categoryConfig[a]?.order ?? 50;
      const bo = categoryConfig[b]?.order ?? 50;
      if (ao !== bo) return ao - bo;
      return (categoryConfig[a]?.label || a).localeCompare(categoryConfig[b]?.label || b);
    });
  }, [skillsByCategory, categoryConfig]);

  // Filter merged skills
  const filteredSkills = useMemo(() => {
    let result = mergedSkills;

    if (skillFilter === "installed") result = result.filter((s) => s.isInstalled);
    else if (skillFilter === "available") result = result.filter((s) => !s.isInstalled);

    if (selectedCategory) result = result.filter((s) => s.category === selectedCategory);

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((s) =>
        s.name.toLowerCase().includes(query) ||
        (s.label || "").toLowerCase().includes(query) ||
        (s.description || "").toLowerCase().includes(query)
      );
    }

    return result;
  }, [mergedSkills, skillFilter, selectedCategory, searchQuery]);

  const installedCount = useMemo(() => mergedSkills.filter((s) => s.isInstalled).length, [mergedSkills]);
  const availableCount = useMemo(() => mergedSkills.filter((s) => !s.isInstalled).length, [mergedSkills]);

  // Different modal sizes for different tabs
  const isSkillTab = activeTab === "skill";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/30 backdrop-blur-sm" />
        <Dialog.Content 
          className={`fixed z-50 bg-surface shadow-elevated overflow-hidden transition-all duration-300 ${
            isSkillTab 
              ? "inset-4 rounded-2xl" 
              : "left-1/2 top-1/2 w-full max-w-lg max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 p-6 overflow-y-auto"
          }`}
        >
          {isSkillTab ? (
            // Full-screen 技能市场
            <div className="flex flex-col h-full">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-ink-900/10">
                <div className="flex items-center gap-4">
                  <Dialog.Title className="text-xl font-semibold text-ink-800">
                    技能市场
                  </Dialog.Title>
                  {/* Filter pills */}
                  <div className="flex items-center gap-1 rounded-xl bg-surface-secondary p-1">
                    {(["all", "installed", "available"] as const).map((f) => {
                      const labels = { all: `全部 ${mergedSkills.length}`, installed: `已安装 ${installedCount}`, available: `可安装 ${availableCount}` };
                      return (
                        <button
                          key={f}
                          onClick={() => setSkillFilter(f)}
                          className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                            skillFilter === f
                              ? "bg-accent text-white shadow-sm"
                              : "text-ink-600 hover:text-ink-800"
                          }`}
                        >
                          {labels[f]}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Manual install */}
                  <button
                    onClick={() => { setShowInstallForm(!showInstallForm); setInstallResult(null); }}
                    className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                      showInstallForm
                        ? "bg-accent text-white"
                        : "border border-ink-900/10 bg-surface-secondary text-ink-700 hover:bg-surface-tertiary"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    手动安装
                  </button>
                  {/* Search */}
                  <div className="relative">
                    <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      placeholder="搜索技能..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-52 rounded-xl border border-ink-900/10 bg-surface-secondary pl-10 pr-4 py-2 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                    />
                  </div>
                  <Dialog.Close asChild>
                    <button
                      className="rounded-full p-2 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                      aria-label="Close"
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </Dialog.Close>
                </div>
              </div>


              {/* Install Skill Form */}
              {showInstallForm && (
                <div className="px-6 py-3 border-b border-ink-900/10 bg-surface-secondary/50">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 relative">
                      <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                      <input
                        type="text"
                        placeholder="输入 Git 仓库地址，如 https://github.com/user/skill-name"
                        value={installUrl}
                        onChange={(e) => setInstallUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleInstallSkill(); }}
                        className="w-full rounded-xl border border-ink-900/10 bg-surface pl-10 pr-4 py-2.5 text-sm text-ink-800 font-mono placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        disabled={installing}
                      />
                    </div>
                    <button
                      onClick={handleInstallSkill}
                      disabled={installing || !installUrl.trim()}
                      className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
                    >
                      {installing ? (
                        <span className="flex items-center gap-2">
                          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                          安装中...
                        </span>
                      ) : "安装"}
                    </button>
                  </div>
                  {installResult && (
                    <div className={`mt-2 rounded-xl border p-2.5 text-xs font-mono whitespace-pre-wrap ${
                      installResult.success
                        ? "border-success/20 bg-success/5 text-success"
                        : "border-error/20 bg-error/5 text-error"
                    }`}>
                      {installResult.message}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-muted-light">
                    技能将同时安装到 ~/.claude/skills/ 和 ~/.codex/skills/
                  </p>

                  {/* Assistant assignment picker after successful install */}
                  {pendingSkillName && (
                    <div className="mt-3 rounded-xl border border-accent/20 bg-accent/5 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-ink-800">
                          给哪些助理配置「{pendingSkillName}」？
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                          <input
                            type="checkbox"
                            checked={assignSelection.size === assistants.length && assistants.length > 0}
                            onChange={(e) => {
                              setAssignSelection(e.target.checked ? new Set(assistants.map((a) => a.id)) : new Set());
                            }}
                            className="h-3.5 w-3.5 rounded border-ink-900/20 text-accent focus:ring-accent/30"
                          />
                          全选
                        </label>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {assistants.map((a) => {
                          const checked = assignSelection.has(a.id);
                          return (
                            <label
                              key={a.id}
                              className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                                checked
                                  ? "border-accent/40 bg-accent/10 text-ink-800"
                                  : "border-ink-900/10 bg-white text-muted hover:border-ink-900/20"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const next = new Set(assignSelection);
                                  if (checked) next.delete(a.id); else next.add(a.id);
                                  setAssignSelection(next);
                                }}
                                className="hidden"
                              />
                              {a.name}
                            </label>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={async () => {
                            await handleAssignSkill(pendingSkillName, assignSelection);
                            setPendingSkillName(null);
                          }}
                          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
                        >
                          确认分配
                        </button>
                        <button
                          onClick={() => setPendingSkillName(null)}
                          className="rounded-lg border border-ink-900/10 px-4 py-1.5 text-xs text-muted hover:bg-surface-tertiary transition-colors"
                        >
                          跳过
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-1 overflow-hidden">
                {/* Category Sidebar */}
                <div className="w-52 border-r border-ink-900/10 p-4 overflow-y-auto">
                  <div className="text-xs font-medium text-muted uppercase tracking-wider mb-3">分类</div>
                  <div className="space-y-0.5">
                    <button
                      onClick={() => setSelectedCategory(null)}
                      className={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                        selectedCategory === null
                          ? "bg-accent text-white"
                          : "text-ink-700 hover:bg-surface-tertiary"
                      }`}
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="7" height="7" />
                        <rect x="14" y="3" width="7" height="7" />
                        <rect x="3" y="14" width="7" height="7" />
                        <rect x="14" y="14" width="7" height="7" />
                      </svg>
                      <span className="truncate">全部</span>
                      <span className="ml-auto text-xs opacity-70 flex-shrink-0">{mergedSkills.length}</span>
                    </button>
                    {availableCategories.map(category => {
                      const config = categoryConfig[category];
                      const catSkills = skillsByCategory[category] || [];
                      const installedInCat = catSkills.filter(s => s.isInstalled).length;
                      return (
                        <button
                          key={category}
                          onClick={() => setSelectedCategory(category)}
                          className={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                            selectedCategory === category
                              ? "bg-accent text-white"
                              : "text-ink-700 hover:bg-surface-tertiary"
                          }`}
                        >
                          <CategoryIcon type={config.icon} className="h-4 w-4 flex-shrink-0" />
                          <span className="truncate">{config.label}</span>
                          <span className="ml-auto text-xs opacity-70 flex-shrink-0">
                            {installedInCat}/{catSkills.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  
                </div>

                {/* Skills Grid */}
                <div className="flex-1 p-6 overflow-y-auto">
                  {(loading || catalogLoading) ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3">
                      <svg className="h-8 w-8 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <p className="text-sm text-muted-light">正在加载技能目录...</p>
                    </div>
                  ) : filteredSkills.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <svg viewBox="0 0 24 24" className="h-16 w-16 text-muted-light" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                      </svg>
                      <p className="mt-4 text-lg text-muted">
                        {searchQuery ? "没有找到匹配的技能" : skillFilter === "available" ? "没有可安装的技能" : skillFilter === "installed" ? "还没有已安装的技能" : "暂无技能"}
                      </p>
                      {skillFilter === "installed" && (
                        <p className="mt-2 text-sm text-muted-light">从上方技能列表点击「安装」即可一键安装</p>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                      {filteredSkills.map((skill) => {
                        const config = categoryConfig[skill.category] ?? categoryConfig["other"];
                        const isInstalling = installingNames.has(skill.name);
                        return (
                          <div
                            key={skill.name}
                            className={`group rounded-2xl border p-5 transition-all duration-200 ${
                              skill.isInstalled
                                ? "border-ink-900/10 bg-surface-secondary hover:border-accent/30 hover:shadow-md"
                                : "border-dashed border-ink-900/15 bg-surface hover:border-accent/40 hover:bg-accent/3"
                            }`}
                          >
                            {/* Header */}
                            <div className="flex items-start gap-3">
                              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${config.color} flex-shrink-0`}>
                                <CategoryIcon type={config.icon} className="h-6 w-6" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <h3 className="text-base font-semibold text-ink-800 truncate">
                                    {skill.label || skill.name}
                                  </h3>
                                  {skill.isInstalled ? (
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                      {confirmDeleteName === skill.name ? (
                                        // Inline confirm
                                        <div className="flex items-center gap-1">
                                          <span className="text-[10px] text-error font-medium">确认删除?</span>
                                          <button
                                            onClick={() => handleDeleteSkill(skill.name)}
                                            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-error text-white hover:bg-error/80 transition-colors"
                                          >
                                            {deletingNames.has(skill.name) ? (
                                              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                              </svg>
                                            ) : "删除"}
                                          </button>
                                          <button
                                            onClick={() => setConfirmDeleteName(null)}
                                            className="rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-tertiary transition-colors"
                                          >
                                            取消
                                          </button>
                                        </div>
                                      ) : (
                                        <>
                                          <span className="flex items-center gap-1 text-[11px] text-success font-medium">
                                            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor"><circle cx="12" cy="12" r="4" /></svg>
                                            已安装
                                          </span>
                                          {skill.isLocalOnly && (
                                            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">本地</span>
                                          )}
                                          <button
                                            onClick={() => setConfirmDeleteName(skill.name)}
                                            title="删除技能"
                                            className="rounded-lg p-1 text-muted hover:bg-error/10 hover:text-error transition-colors"
                                          >
                                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                            </svg>
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => handleInstallFromCatalog(skill)}
                                      disabled={isInstalling || !skill.installPath}
                                      title={!skill.installPath ? "暂无安装地址" : ""}
                                      className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-40 flex-shrink-0"
                                    >
                                      {isInstalling ? (
                                        <>
                                          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                          </svg>
                                          安装中
                                        </>
                                      ) : (
                                        <>
                                          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                            <polyline points="7 10 12 15 17 10" />
                                            <line x1="12" y1="15" x2="12" y2="3" />
                                          </svg>
                                          安装
                                        </>
                                      )}
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[11px] font-medium text-muted">{config.label}</span>
                                  {skill.label && skill.label !== skill.name && (
                                    <span className="text-[10px] text-muted-light font-mono">{skill.name}</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Description — from catalog JSON only */}
                            <div className="mt-3 p-3 bg-surface rounded-xl border border-ink-900/5">
                              <p className="text-sm text-ink-700 leading-relaxed line-clamp-3">
                                {skill.description || (skill.isLocalOnly ? "本地已安装，暂无目录描述。" : "暂无描述信息。")}
                              </p>
                            </div>

                            {/* Installed: assistant assignment UI */}
                            {skill.isInstalled && (() => {
                              const owners = getSkillAssistants(skill.name);
                              const isManaging = managingSkillName === skill.name;
                              return (
                                <div className="mt-3">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      {owners.length > 0 ? owners.map((a) => (
                                        <span key={a.id} className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                                          {a.name}
                                        </span>
                                      )) : (
                                        <span className="text-[10px] text-muted-light">未分配助理</span>
                                      )}
                                    </div>
                                    <button
                                      onClick={() => {
                                        if (isManaging) {
                                          setManagingSkillName(null);
                                        } else {
                                          setManagingSkillName(skill.name);
                                          setManageSelection(new Set(owners.map((a) => a.id)));
                                        }
                                      }}
                                      className="px-2.5 py-1 rounded-lg text-[10px] font-medium text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors flex-shrink-0"
                                    >
                                      {isManaging ? "收起" : "分配"}
                                    </button>
                                  </div>
                                  {isManaging && (
                                    <div className="mt-2 rounded-xl border border-ink-900/10 bg-surface p-2.5">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] font-medium text-muted">选择助理</span>
                                        <label className="flex items-center gap-1 text-[10px] text-muted cursor-pointer">
                                          <input
                                            type="checkbox"
                                            checked={manageSelection.size === assistants.length && assistants.length > 0}
                                            onChange={(e) => {
                                              setManageSelection(e.target.checked ? new Set(assistants.map((a) => a.id)) : new Set());
                                            }}
                                            className="h-3 w-3 rounded border-ink-900/20 text-accent focus:ring-accent/30"
                                          />
                                          全选
                                        </label>
                                      </div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {assistants.map((a) => {
                                          const checked = manageSelection.has(a.id);
                                          return (
                                            <label
                                              key={a.id}
                                              className={`flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
                                                checked
                                                  ? "border-accent/40 bg-accent/10 text-ink-800"
                                                  : "border-ink-900/10 bg-white text-muted hover:border-ink-900/20"
                                              }`}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => {
                                                  const next = new Set(manageSelection);
                                                  if (checked) next.delete(a.id); else next.add(a.id);
                                                  setManageSelection(next);
                                                }}
                                                className="hidden"
                                              />
                                              {a.name}
                                            </label>
                                          );
                                        })}
                                      </div>
                                      <button
                                        onClick={async () => {
                                          await handleAssignSkill(skill.name, manageSelection);
                                          setManagingSkillName(null);
                                        }}
                                        className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-[10px] font-medium text-white hover:bg-accent-hover transition-colors"
                                      >
                                        保存
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {/* Footer: git source for non-installed catalog skills */}
                            {!skill.isInstalled && skill.installPath && (
                              <div className="mt-2.5 flex items-center text-[10px] text-muted-light">
                                <span className="font-mono truncate text-accent/60">{skill.installPath}</span>
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
          ) : (
            // Normal MCP Dialog
            <>
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-ink-800">
              Claude 配置
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-full p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* Tab buttons */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setActiveTab("mcp")}
              className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === "mcp"
                  ? "bg-accent text-white"
                  : "bg-surface-secondary text-ink-700 hover:bg-surface-tertiary"
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v6m0 6v10M1 12h6m6 0h10" />
                </svg>
                MCP 服务器
              </span>
            </button>
            <button
              onClick={() => setActiveTab("skill")}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors bg-surface-secondary text-ink-700 hover:bg-surface-tertiary"
            >
              <span className="flex items-center justify-center gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                Skills
              </span>
            </button>
          </div>

          {/* Content */}
          <div className="mt-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <svg className="h-6 w-6 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
                ) : showAddForm ? (
                <AddMcpForm 
                  onSubmit={handleAddServer} 
                  onCancel={() => setShowAddForm(false)} 
                />
              ) : (
                <McpServerList 
                  servers={mcpServers} 
                  onAdd={() => setShowAddForm(true)}
                  onDelete={handleDeleteServer}
                />
            )}
          </div>

          <div className="mt-4 rounded-xl border border-info/20 bg-info/5 p-3">
            <p className="text-xs text-info">
              配置文件位置：
              <code className="ml-1 rounded bg-info/10 px-1 py-0.5 font-mono">~/.claude/settings.json</code>
            </p>
          </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface AddMcpFormProps {
  onSubmit: (server: McpServer) => Promise<SaveMcpResult>;
  onCancel: () => void;
}

function AddMcpForm({ onSubmit, onCancel }: AddMcpFormProps) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddEnv = () => {
    setEnvPairs([...envPairs, { key: "", value: "" }]);
  };

  const handleRemoveEnv = (index: number) => {
    setEnvPairs(envPairs.filter((_, i) => i !== index));
  };

  const handleEnvChange = (index: number, field: "key" | "value", value: string) => {
    const newPairs = [...envPairs];
    newPairs[index][field] = value;
    setEnvPairs(newPairs);
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("请输入服务器名称");
      return;
    }
    if (!command.trim()) {
      setError("请输入命令");
      return;
    }

    setSaving(true);
    setError(null);

    const server: McpServer = {
      name: name.trim(),
      command: command.trim(),
    };

    if (args.trim()) {
      server.args = args.trim().split(/\s+/);
    }

    const validEnvPairs = envPairs.filter(p => p.key.trim() && p.value.trim());
    if (validEnvPairs.length > 0) {
      server.env = {};
      for (const pair of validEnvPairs) {
        server.env[pair.key.trim()] = pair.value.trim();
      }
    }

    const result = await onSubmit(server);
    setSaving(false);

    if (!result.success) {
      setError(result.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-medium text-ink-800">添加 MCP 服务器</span>
      </div>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">服务器名称 *</span>
        <input
          type="text"
          className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
          placeholder="例如: my-mcp-server"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">命令 *</span>
        <input
          type="text"
          className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono"
          placeholder="例如: npx, node, python"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">参数 (空格分隔)</span>
        <input
          type="text"
          className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono"
          placeholder="例如: -y @anthropic/mcp-server-fetch"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </label>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted">环境变量</span>
          <button
            type="button"
            onClick={handleAddEnv}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            + 添加
          </button>
        </div>
        {envPairs.map((pair, index) => (
          <div key={index} className="flex gap-2">
            <input
              type="text"
              className="flex-1 rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono"
              placeholder="KEY"
              value={pair.key}
              onChange={(e) => handleEnvChange(index, "key", e.target.value)}
            />
            <input
              type="text"
              className="flex-1 rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono"
              placeholder="VALUE"
              value={pair.value}
              onChange={(e) => handleEnvChange(index, "value", e.target.value)}
            />
            <button
              type="button"
              onClick={() => handleRemoveEnv(index)}
              className="rounded-lg p-2 text-muted hover:bg-error/10 hover:text-error transition-colors"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-error/20 bg-error/5 p-3">
          <p className="text-xs text-error">{error}</p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-xl border border-ink-900/10 bg-surface px-4 py-2.5 text-sm text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className="flex-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              保存中...
            </span>
          ) : (
            "保存"
          )}
        </button>
      </div>
    </div>
  );
}

interface McpServerListProps {
  servers: McpServer[];
  onAdd: () => void;
  onDelete: (name: string) => Promise<SaveMcpResult>;
}

function McpServerList({ servers, onAdd, onDelete }: McpServerListProps) {
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const handleDelete = async (name: string) => {
    if (!confirm(`确定要删除 MCP 服务器 "${name}" 吗？`)) {
      return;
    }
    setDeletingName(name);
    await onDelete(name);
    setDeletingName(null);
  };

  return (
    <div className="space-y-3">
      {/* Add button */}
      <button
        onClick={onAdd}
        className="w-full rounded-xl border-2 border-dashed border-ink-900/10 bg-surface-secondary/50 p-4 text-center hover:border-accent/30 hover:bg-accent/5 transition-colors group"
      >
        <div className="flex items-center justify-center gap-2 text-muted group-hover:text-accent transition-colors">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <span className="text-sm font-medium">添加 MCP 服务器</span>
        </div>
      </button>

      {servers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <svg viewBox="0 0 24 24" className="h-10 w-10 text-muted-light" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v6m0 6v10M1 12h6m6 0h10" />
          </svg>
          <p className="mt-3 text-sm text-muted">未配置 MCP 服务器</p>
          <p className="mt-1 text-xs text-muted-light">
            点击上方按钮添加第一个 MCP 服务器
          </p>
        </div>
      ) : (
        servers.map((server) => (
          <div
            key={server.name}
            className="rounded-xl border border-ink-900/10 bg-surface-secondary p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v6m0 6v10M1 12h6m6 0h10" />
                  </svg>
                </div>
                <span className="font-medium text-ink-800">{server.name}</span>
              </div>
              <button
                onClick={() => handleDelete(server.name)}
                disabled={deletingName === server.name}
                className="rounded-lg p-1.5 text-muted hover:bg-error/10 hover:text-error transition-colors disabled:opacity-50"
                title="删除"
              >
                {deletingName === server.name ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                )}
              </button>
            </div>
            <div className="mt-3 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-xs text-muted w-16 flex-shrink-0">命令:</span>
                <code className="text-xs font-mono text-ink-700 break-all bg-surface-tertiary px-1.5 py-0.5 rounded">
                  {server.command}
                </code>
              </div>
              {server.args && server.args.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted w-16 flex-shrink-0">参数:</span>
                  <code className="text-xs font-mono text-ink-700 break-all bg-surface-tertiary px-1.5 py-0.5 rounded">
                    {server.args.join(" ")}
                  </code>
                </div>
              )}
              {server.env && Object.keys(server.env).length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted w-16 flex-shrink-0">环境:</span>
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(server.env).map((key) => (
                      <span key={key} className="text-xs font-mono text-ink-600 bg-surface-tertiary px-1.5 py-0.5 rounded">
                        {key}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

