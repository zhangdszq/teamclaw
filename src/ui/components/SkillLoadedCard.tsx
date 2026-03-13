import { useMemo, useState } from "react";
import MDContent from "../render/markdown";

// Skill category config - shared with PromptInput
const SKILL_CATEGORY_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  "development": { icon: "code", color: "text-blue-500", bgColor: "bg-blue-500/10" },
  "writing": { icon: "pen", color: "text-purple-500", bgColor: "bg-purple-500/10" },
  "analysis": { icon: "chart", color: "text-green-500", bgColor: "bg-green-500/10" },
  "design": { icon: "palette", color: "text-pink-500", bgColor: "bg-pink-500/10" },
  "productivity": { icon: "zap", color: "text-yellow-500", bgColor: "bg-yellow-500/10" },
  "research": { icon: "search", color: "text-cyan-500", bgColor: "bg-cyan-500/10" },
  "sales": { icon: "trending", color: "text-orange-500", bgColor: "bg-orange-500/10" },
  "other": { icon: "box", color: "text-gray-500", bgColor: "bg-gray-500/10" },
};

// Get category from skill name/description
function getSkillCategory(name: string, description?: string): string {
  const text = (name + " " + (description || "")).toLowerCase();
  
  if (text.includes("code") || text.includes("dev") || text.includes("程序") || text.includes("开发") || text.includes("debug")) {
    return "development";
  }
  if (text.includes("write") || text.includes("写作") || text.includes("文档") || text.includes("blog") || text.includes("article")) {
    return "writing";
  }
  if (text.includes("data") || text.includes("分析") || text.includes("chart") || text.includes("数据") || text.includes("report")) {
    return "analysis";
  }
  if (text.includes("design") || text.includes("设计") || text.includes("ui") || text.includes("ux") || text.includes("创意")) {
    return "design";
  }
  if (text.includes("效率") || text.includes("productivity") || text.includes("automat") || text.includes("自动")) {
    return "productivity";
  }
  if (text.includes("research") || text.includes("调研") || text.includes("搜索") || text.includes("search")) {
    return "research";
  }
  if (text.includes("sales") || text.includes("销售") || text.includes("coach") || text.includes("客户")) {
    return "sales";
  }
  return "other";
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

export type SkillLoadedMessage = {
  type: "skill_loaded";
  skillName: string;
  skillLabel?: string;
  skillContent: string;
  skillDescription?: string;
};

interface SkillLoadedCardProps {
  message: SkillLoadedMessage;
}

// Parse markdown sections
interface ParsedSection {
  title: string;
  content: string;
  level: number;
}

function parseMarkdownSections(content: string): ParsedSection[] {
  const lines = content.split("\n");
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = currentContent.join("\n").trim();
        sections.push(currentSection);
      }
      // Start new section
      currentSection = {
        title: headingMatch[2].trim(),
        content: "",
        level: headingMatch[1].length
      };
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = currentContent.join("\n").trim();
    sections.push(currentSection);
  }

  return sections;
}

// Extract summary/overview from content
function extractOverview(content: string): string {
  const sections = parseMarkdownSections(content);
  
  // Look for common overview section names
  const overviewNames = ["概述", "简介", "overview", "introduction", "about", "说明"];
  for (const section of sections) {
    if (overviewNames.some(name => section.title.toLowerCase().includes(name))) {
      return section.content;
    }
  }
  
  // If no overview section, use the first section after the title
  if (sections.length > 0) {
    // Skip the first section if it's just the title
    const firstContent = sections[0].content;
    if (firstContent) {
      return firstContent;
    }
    // Try second section
    if (sections.length > 1 && sections[1].content) {
      return sections[1].content;
    }
  }
  
  return "";
}

// Extract instruction/how to use from content
function extractInstruction(content: string): string {
  const sections = parseMarkdownSections(content);
  
  // Look for instruction-like section names
  const instructionNames = ["使用", "instruction", "how to", "usage", "用法", "请提供"];
  
  for (const section of sections) {
    if (instructionNames.some(name => section.title.toLowerCase().includes(name))) {
      return section.content;
    }
  }
  
  // Look for instruction in content (last paragraph often contains instructions)
  const lines = content.split("\n").filter(l => l.trim());
  const lastLines = lines.slice(-5);
  for (const line of lastLines) {
    if (line.includes("请") || line.includes("提供") || line.includes("Please") || line.includes("provide")) {
      return line;
    }
  }
  
  return "";
}

export function SkillLoadedCard({ message }: SkillLoadedCardProps) {
  const { skillName, skillLabel, skillContent, skillDescription } = message;
  const [isExpanded, setIsExpanded] = useState(false);
  const displayName = (skillLabel || "").trim() || skillName;
  
  const category = getSkillCategory(skillName, skillDescription);
  const config = SKILL_CATEGORY_CONFIG[category] || SKILL_CATEGORY_CONFIG.other;
  
  const parsedContent = useMemo(() => {
    const sections = parseMarkdownSections(skillContent);
    const overview = extractOverview(skillContent);
    const instruction = extractInstruction(skillContent);
    
    return { sections, overview, instruction };
  }, [skillContent]);

  return (
    <div className="flex flex-col mt-4">
      {/* Collapsed Header - Always visible, clickable */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-3 p-3 rounded-xl border border-ink-900/10 bg-surface-secondary hover:bg-surface-tertiary transition-colors text-left group"
      >
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${config.bgColor} flex-shrink-0`}>
          <SkillIcon type={config.icon} className={`h-5 w-5 ${config.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-ink-800">已加载 {displayName} 技能</span>
            <span className="flex items-center gap-1 text-xs text-success">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
                <circle cx="12" cy="12" r="4" />
              </svg>
              就绪
            </span>
          </div>
          {skillDescription && (
            <p className="text-sm text-muted mt-0.5 line-clamp-1">{skillDescription}</p>
          )}
        </div>
        {/* Expand/Collapse Icon */}
        <div className="flex-shrink-0 text-muted group-hover:text-ink-700 transition-colors">
          <svg 
            viewBox="0 0 24 24" 
            className={`h-5 w-5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="mt-2 rounded-2xl border border-ink-900/10 bg-surface-secondary overflow-hidden animate-in slide-in-from-top-2 duration-200">
          {/* Overview Section */}
          {parsedContent.overview && (
            <div className="px-5 py-4 border-b border-ink-900/5">
              <div className="text-xs font-medium text-muted uppercase tracking-wider mb-2">技能概述</div>
              <div className="text-sm text-ink-700 leading-relaxed">
                <MDContent text={parsedContent.overview} />
              </div>
            </div>
          )}

          {/* Sections */}
          {parsedContent.sections.slice(1).map((section, idx) => {
            // Skip if it's the overview section or instruction section
            const lowerTitle = section.title.toLowerCase();
            if (lowerTitle.includes("概述") || lowerTitle.includes("overview") || 
                lowerTitle.includes("使用") || lowerTitle.includes("instruction")) {
              return null;
            }
            
            if (!section.content) return null;
            
            return (
              <div key={idx} className="px-5 py-4 border-b border-ink-900/5 last:border-b-0">
                <div className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{section.title}</div>
                <div className="text-sm text-ink-700 leading-relaxed skill-content">
                  <MDContent text={section.content} />
                </div>
              </div>
            );
          })}

          {/* Instruction Footer */}
          {parsedContent.instruction && (
            <div className="px-5 py-4 bg-accent/5 border-t border-accent/10">
              <div className="flex items-start gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                <p className="text-sm text-accent leading-relaxed">{parsedContent.instruction}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Quick tip - only show when collapsed */}
      {!isExpanded && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          <span>点击展开查看详情，或直接输入相关内容开始使用</span>
        </div>
      )}
    </div>
  );
}
