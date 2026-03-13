import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { extractTriggerPhrases, findBestSkillMatch } from "../../shared/skill-matcher.js";
import { loadAssistantsConfig } from "./assistants-config.js";
import { IMAGE_INLINE_RULE } from "./bot-base.js";

export interface SkillInfo {
  name: string;
  label: string;
  description: string;
  triggers?: string[];
}

export interface ResolvedSkillCommand {
  skillName: string;
  skillContent: string;
  userText: string;
}

export interface ResolveSkillPromptOptions {
  autoActivate?: boolean;
  preferredSkillName?: string;
  installedSkills?: Map<string, SkillInfo>;
  contentLoader?: (skillName: string) => string | null;
}

function extractBacktickedIdentifiers(content: string): string[] {
  const matches = content.matchAll(/`([a-zA-Z0-9_-]+)`/g);
  return [...new Set(Array.from(matches, (match) => match[1]).filter(Boolean))];
}

export function loadMcpNeedsAuthCache(): Set<string> {
  const filePath = join(homedir(), ".claude", "mcp-needs-auth-cache.json");
  if (!existsSync(filePath)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return new Set(Object.keys(raw));
  } catch {
    return new Set();
  }
}

export function normalizeSkillNames(skillNames?: string[]): string[] {
  return (skillNames ?? []).map((name) => String(name).trim()).filter(Boolean);
}

export function toSkillCommandName(skillName: string): string {
  return skillName.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}

// ── Catalog enrichment ─────────────────────────────────────────────────────────

interface CatalogEntry {
  name: string;
  label?: string;
  description?: string;
  category?: string;
  tags?: string[];
  installPath?: string;
}

let catalogCache: Map<string, CatalogEntry> | undefined;

function resolveCatalogPath(): string | null {
  const candidates: string[] = [];
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(thisDir, "..", "..", "..", "skills-catalog.json"));
  } catch { /* import.meta.url unavailable in CJS / test */ }
  try {
    if ((process as unknown as Record<string, unknown>).resourcesPath) {
      candidates.push(join((process as unknown as Record<string, string>).resourcesPath, "skills-catalog.json"));
    }
  } catch { /* not in electron */ }
  candidates.push(join(process.cwd(), "skills-catalog.json"));
  return candidates.find((p) => existsSync(p)) ?? null;
}

function loadCatalogLookup(): Map<string, CatalogEntry> {
  if (catalogCache) return catalogCache;
  catalogCache = new Map();
  const catalogPath = resolveCatalogPath();
  if (!catalogPath) return catalogCache;
  try {
    const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as { skills?: CatalogEntry[] };
    for (const entry of raw.skills ?? []) {
      catalogCache.set(entry.name, entry);
      if (entry.installPath) {
        const url = entry.installPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
        const blobMatch = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/);
        let dirName: string;
        if (blobMatch) {
          const parts = blobMatch[1].split("/");
          const last = parts[parts.length - 1];
          dirName = last.includes(".") ? parts[parts.length - 2] ?? "" : last;
        } else {
          dirName = url.split("/").pop() ?? "";
        }
        if (dirName && !catalogCache.has(dirName)) catalogCache.set(dirName, entry);
      }
    }
  } catch { /* best-effort */ }
  return catalogCache;
}

export function enrichSkillWithCatalog(skill: SkillInfo): SkillInfo {
  const catalog = loadCatalogLookup();
  const entry = catalog.get(skill.name);
  if (!entry) return skill;
  const enriched = { ...skill };
  if (entry.label) enriched.label = entry.label;
  if (entry.description) enriched.description = entry.description;
  const triggers = new Set<string>(skill.triggers ?? []);
  for (const tag of entry.tags ?? []) triggers.add(tag.toLowerCase());
  for (const phrase of extractTriggerPhrases(enriched.description)) triggers.add(phrase);
  enriched.triggers = [...triggers];
  return enriched;
}

// ── YAML / frontmatter helpers ──────────────────────────────────────────────────

function stripSurroundingQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function normalizeYamlBlockLines(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^(\s*)/)?.[1].length ?? 0);

  if (indents.length === 0) return lines.map(() => "");
  const sharedIndent = Math.min(...indents);

  return lines.map((line) => {
    if (!line.trim()) return "";
    return line.slice(sharedIndent);
  });
}

function foldYamlBlock(lines: string[]): string {
  const paragraphs: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    paragraphs.push(buffer.join(" "));
    buffer = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      if (paragraphs.at(-1) !== "") paragraphs.push("");
      continue;
    }
    buffer.push(line.trim());
  }

  flush();
  return paragraphs.join("\n").trim();
}

export function parseSkillMarkdownMetadata(
  content: string,
  fallbackName = "",
): {
  label: string;
  description: string;
} {
  const lines = content.split("\n");
  let label = fallbackName;
  let description = "";
  let contentStartIndex = 0;

  if (lines[0]?.trim() === "---") {
    const fmEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (fmEnd > 0) {
      contentStartIndex = fmEnd + 1;
      const frontmatterLines = lines.slice(1, fmEnd);
      for (let idx = 0; idx < frontmatterLines.length; idx++) {
        const raw = frontmatterLines[idx];
        const trimmed = raw.trim();
        if (trimmed.startsWith("name:")) {
          label = stripSurroundingQuotes(trimmed.slice("name:".length).trim()) || label;
          continue;
        }

        if (!trimmed.startsWith("description:")) continue;

        const rawValue = stripSurroundingQuotes(trimmed.slice("description:".length).trim());
        if (/^[>|][+-]?$/.test(rawValue)) {
          const baseIndent = raw.match(/^(\s*)/)?.[1].length ?? 0;
          const blockLines: string[] = [];
          let nextIndex = idx + 1;
          while (nextIndex < frontmatterLines.length) {
            const candidate = frontmatterLines[nextIndex];
            if (!candidate.trim()) {
              blockLines.push("");
              nextIndex += 1;
              continue;
            }

            const indent = candidate.match(/^(\s*)/)?.[1].length ?? 0;
            if (indent <= baseIndent) break;
            blockLines.push(candidate);
            nextIndex += 1;
          }

          const normalizedBlockLines = normalizeYamlBlockLines(blockLines);
          description = rawValue.startsWith(">")
            ? foldYamlBlock(normalizedBlockLines)
            : normalizedBlockLines.join("\n").trim();
          idx = nextIndex - 1;
          continue;
        }

        description = rawValue;
      }
    }
  }

  if (!description) {
    const bodyLines = lines.slice(contentStartIndex);
    const firstLine = bodyLines.find((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && trimmed !== "---";
    });
    description = firstLine?.trim().slice(0, 200) ?? "";
  }

  return { label, description };
}

export function loadInstalledSkills(): Map<string, SkillInfo> {
  const result = new Map<string, SkillInfo>();
  const skillsDirs = [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".cursor", "skills"),
    join(homedir(), ".codex", "skills"),
  ];

  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".") || result.has(name)) continue;
        const skillDir = join(dir, name);
        if (!statSync(skillDir).isDirectory()) continue;
        const skillFile = join(skillDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;

        let label = name;
        let description = "";
        let mdTriggers: string[] = [];
        try {
          const content = readFileSync(skillFile, "utf8");
          ({ label, description } = parseSkillMarkdownMetadata(content, name));
          mdTriggers = extractTriggerPhrases(description);
        } catch {
          // Ignore malformed local skills.
        }

        const base: SkillInfo = { name, label, description, triggers: mdTriggers };
        result.set(name, enrichSkillWithCatalog(base));
      }
    } catch {
      // Ignore unreadable skill directories.
    }
  }

  return result;
}

export function loadSkillContent(skillName: string): string | null {
  const dirs = [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".cursor", "skills"),
    join(homedir(), ".codex", "skills"),
  ];
  for (const dir of dirs) {
    const filePath = join(dir, skillName, "SKILL.md");
    if (!existsSync(filePath)) continue;
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      // Ignore unreadable skill files.
    }
  }
  return null;
}

function getConfiguredSkillInfos(
  skillNames?: string[],
  installedSkills: Map<string, SkillInfo> = loadInstalledSkills(),
): SkillInfo[] {
  return normalizeSkillNames(skillNames).map((name) => {
    const installed = installedSkills.get(name);
    return installed ?? { name, label: name, description: "" };
  });
}

export function buildAvailableSkillsSection(
  skillNames?: string[],
  installedSkills: Map<string, SkillInfo> = loadInstalledSkills(),
): string | undefined {
  const skills = getConfiguredSkillInfos(skillNames, installedSkills);
  if (skills.length === 0) return undefined;

  const lines = skills.map((skill) => {
    const title = skill.label && skill.label !== skill.name
      ? `${skill.name} (${skill.label})`
      : skill.name;
    const description = skill.description?.trim();
    return description ? `- ${title}: ${description}` : `- ${title}`;
  });
  return `## 可用技能\n${lines.join("\n")}`;
}

export function resolveSkillCommand(
  text: string,
  skillNames?: string[],
  contentLoader: (skillName: string) => string | null = loadSkillContent,
): ResolvedSkillCommand | null {
  if (!text.startsWith("/")) return null;
  const normalizedSkills = normalizeSkillNames(skillNames);
  if (normalizedSkills.length === 0) return null;

  const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const [, rawCommand, rawArgs] = match;
  const normalizedCommand = rawCommand.toLowerCase().replace(/@\S+$/, "");
  const matchedSkill = normalizedSkills.find((name) => {
    return (
      name.toLowerCase() === normalizedCommand ||
      toSkillCommandName(name) === normalizedCommand
    );
  });
  if (!matchedSkill) return null;

  const skillContent = contentLoader(matchedSkill);
  if (!skillContent) return null;

  return {
    skillName: matchedSkill,
    skillContent,
    userText: rawArgs?.trim() || `请执行技能 ${matchedSkill}`,
  };
}

export function resolveSkillPromptContext(
  text: string,
  skillNames?: string[],
  options?: ResolveSkillPromptOptions,
): ResolvedSkillCommand | null {
  const contentLoader = options?.contentLoader ?? loadSkillContent;
  const explicit = resolveSkillCommand(text, skillNames, contentLoader);
  if (explicit) return explicit;
  if (options?.autoActivate === false) return null;

  const normalizedSkills = normalizeSkillNames(skillNames);
  if (normalizedSkills.length === 0) return null;

  const preferredSkillName = options?.preferredSkillName?.trim();
  if (preferredSkillName && normalizedSkills.includes(preferredSkillName)) {
    const skillContent = contentLoader(preferredSkillName);
    if (skillContent) {
      return {
        skillName: preferredSkillName,
        skillContent,
        userText: text,
      };
    }
  }

  const installedSkills = options?.installedSkills ?? loadInstalledSkills();
  const matchedSkill = findBestSkillMatch(text, getConfiguredSkillInfos(normalizedSkills, installedSkills));
  if (!matchedSkill) return null;

  const skillContent = contentLoader(matchedSkill.name);
  if (!skillContent) return null;

  return {
    skillName: matchedSkill.name,
    skillContent,
    userText: text,
  };
}

export function buildActivatedSkillSection(
  skillContent?: string | null,
  options?: {
    authNeededServers?: Iterable<string>;
  },
): string | undefined {
  if (!skillContent?.trim()) return undefined;
  const sections = [[
    "## 当前激活技能",
    "系统已根据当前请求预加载以下技能说明。",
    "如果你判断此技能与用户意图不符，请忽略以下技能内容，并参考「可用技能」列表自行判断。",
    "请严格按照以下技能说明执行用户请求：",
    "",
    "重要规则：",
    "- 技能内容已完整注入到本上下文中，不要调用 Skill 工具重新加载。",
    "- 不要执行 pwd、env、ls 等环境探测命令，直接按技能说明中给出的路径和参数执行。",
    "",
    skillContent,
  ].join("\n")];

  const authNeededServers = new Set(options?.authNeededServers ?? loadMcpNeedsAuthCache());
  const blockedServers = extractBacktickedIdentifiers(skillContent).filter((name) =>
    authNeededServers.has(name),
  );

  if (blockedServers.length > 0) {
    sections.push(
      [
        "## MCP 认证状态",
        `以下外部 MCP 服务器当前尚未完成 OAuth 授权：${blockedServers.map((name) => `\`${name}\``).join(", ")}`,
        "不要误判为工具不存在或未暴露。",
        "如果用户请求依赖这些服务器的操作，请明确说明真正原因是认证未完成，因此暂时无法实际执行，直到授权成功。",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function applyAssistantContextToPrompt(
  prompt: string,
  options?: {
    skillNames?: string[];
    persona?: string;
    assistantId?: string;
    activatedSkillContent?: string;
  },
): string {
  const assistantId = options?.assistantId;
  const config = assistantId ? loadAssistantsConfig() : undefined;
  const assistant = config?.assistants.find((item) => item.id === assistantId);

  const sections: string[] = [];
  const name = assistant?.name;
  const persona = options?.persona || assistant?.persona;
  const identity = [name ? `你的名字是「${name}」。` : "", persona?.trim() ?? ""]
    .filter(Boolean)
    .join("\n");
  if (identity) sections.push(`## 你的身份\n${identity}`);
  if (assistant?.coreValues?.trim()) sections.push(`## 核心价值观\n${assistant.coreValues.trim()}`);
  if (assistant?.relationship?.trim()) sections.push(`## 与用户的关系\n${assistant.relationship.trim()}`);
  if (assistant?.cognitiveStyle?.trim()) sections.push(`## 你的思维方式\n${assistant.cognitiveStyle.trim()}`);
  if (assistant?.operatingGuidelines?.trim()) sections.push(`## 操作规程\n${assistant.operatingGuidelines.trim()}`);
  if (config?.userContext?.trim()) sections.push(`## 关于用户\n${config.userContext.trim()}`);

  const normalizedSkills = normalizeSkillNames(options?.skillNames);
  if (normalizedSkills.length > 0) {
    const availableSkillsSection = buildAvailableSkillsSection(normalizedSkills);
    if (availableSkillsSection) sections.push(availableSkillsSection);
  }

  const skillSection = buildActivatedSkillSection(options?.activatedSkillContent);
  if (skillSection) sections.push(skillSection);

  sections.push(IMAGE_INLINE_RULE);

  if (sections.length === 0) return prompt;
  return `${sections.join("\n\n")}\n\n${prompt}`;
}
