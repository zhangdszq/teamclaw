import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { loadAssistantsConfig } from "./assistants-config.js";
import { IMAGE_INLINE_RULE } from "./bot-base.js";

export interface SkillInfo {
  name: string;
  label: string;
  description: string;
}

export interface ResolvedSkillCommand {
  skillName: string;
  skillContent: string;
  userText: string;
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
        try {
          const content = readFileSync(skillFile, "utf8");
          const lines = content.split("\n");
          if (lines[0]?.trim() === "---") {
            const fmEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
            if (fmEnd > 0) {
              const frontmatterLines = lines.slice(1, fmEnd);
              for (const raw of frontmatterLines) {
                const trimmed = raw.trim();
                if (trimmed.startsWith("name:")) {
                  label = trimmed.slice("name:".length).trim().replace(/^['"]|['"]$/g, "") || label;
                } else if (trimmed.startsWith("description:")) {
                  description = trimmed
                    .slice("description:".length)
                    .trim()
                    .replace(/^['"]|['"]$/g, "");
                }
              }
            }
          }

          if (!description) {
            const firstLine = lines.find((line) => {
              const trimmed = line.trim();
              return trimmed && !trimmed.startsWith("#") && trimmed !== "---";
            });
            description = firstLine?.trim().slice(0, 200) ?? "";
          }
        } catch {
          // Ignore malformed local skills.
        }

        result.set(name, { name, label, description });
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

export function buildActivatedSkillSection(
  skillContent?: string | null,
  options?: {
    authNeededServers?: Iterable<string>;
  },
): string | undefined {
  if (!skillContent?.trim()) return undefined;
  const sections = [`## 当前激活技能\n请严格按照以下技能说明执行用户请求：\n\n${skillContent}`];

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
  if (normalizedSkills.length > 0 && !options?.activatedSkillContent) {
    sections.push(`## 可用技能\n${normalizedSkills.join(", ")}`);
  }

  const skillSection = buildActivatedSkillSection(options?.activatedSkillContent);
  if (skillSection) sections.push(skillSection);

  sections.push(IMAGE_INLINE_RULE);

  if (sections.length === 0) return prompt;
  return `${sections.join("\n\n")}\n\n${prompt}`;
}
