import type { StreamMessage } from "../types.js";

const MAX_FALLBACK_HISTORY_CHARS = 6000;
const CURSOR_DELEGATION_SKILL = "operate-coding-tools";
const MAX_BLOCK_PREVIEW_CHARS = 1200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n...[中间部分省略]...\n${text.slice(-half)}`;
}

function truncateBlock(text: string): string {
  return truncateMiddle(text, MAX_BLOCK_PREVIEW_CHARS);
}

function stringifyBlockValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return String(value).trim();
  }
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return truncateBlock(content.trim());
  }

  if (Array.isArray(content)) {
    const text = content
      .flatMap((item) => {
        if (typeof item === "string") return [item.trim()];
        if (!isObject(item)) return [];
        if (item.type === "text" && typeof item.text === "string") {
          return [item.text.trim()];
        }
        return [];
      })
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) return truncateBlock(text);
  }

  return truncateBlock(stringifyBlockValue(content));
}

function renderAssistantContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const blocks = content
    .flatMap((item) => {
      if (!isObject(item) || typeof item.type !== "string") return [];

      if (item.type === "text" && typeof item.text === "string") {
        const text = item.text.trim();
        return text ? [text] : [];
      }

      if (item.type === "tool_use" && typeof item.name === "string") {
        const input = stringifyBlockValue(item.input);
        const suffix = input ? `\n${truncateBlock(input)}` : "";
        return [`[工具调用 ${item.name}]${suffix}`];
      }

      return [];
    })
    .filter(Boolean);

  return blocks.join("\n").trim();
}

function renderUserContextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const blocks = content
    .flatMap((item) => {
      if (!isObject(item) || typeof item.type !== "string") return [];

      if (item.type === "tool_result") {
        const rendered = renderToolResultContent(item.content);
        return rendered ? [`[工具结果]\n${rendered}`] : [];
      }

      return [];
    })
    .filter(Boolean);

  return blocks.join("\n").trim();
}

function normalizeSkillNames(skillNames?: string[]): string[] {
  return (skillNames ?? []).map((name) => String(name).trim()).filter(Boolean);
}

export function buildSkillContinuationGuidance(skillNames?: string[]): string {
  const normalized = normalizeSkillNames(skillNames);
  if (!normalized.includes(CURSOR_DELEGATION_SKILL)) return "";

  return [
    "## 当前技能约束",
    "本会话正在使用 `/operate-coding-tools`。",
    "继续时必须让 Cursor 完成实质分析、检索、修改和命令执行。",
    "当前模型只负责委派、补充约束、等待 Cursor 结果并向用户总结。",
    "不要把本应交给 Cursor 的工作自己做掉。",
  ].join("\n");
}

export function buildContinuePrompt(prompt: string, skillNames?: string[]): string {
  const guidance = buildSkillContinuationGuidance(skillNames);
  if (!guidance) return prompt;

  return [
    guidance,
    "",
    "## 用户最新消息",
    prompt,
  ].join("\n");
}

export function isResumeReadyMessage(message: unknown): boolean {
  if (!isObject(message) || typeof message.type !== "string") return false;
  return !(message.type === "system" && message.subtype === "init");
}

export function shouldFallbackFromContinueError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
  return /No conversation found with session ID/i.test(text)
    || /--resume requires a valid session ID/i.test(text)
    || /is not a valid UUID/i.test(text);
}

export function buildResumeFallbackPrompt(
  messages: StreamMessage[],
  prompt: string,
  skillNames?: string[],
): string {
  const historyLines = messages
    .map((message) => {
      const runtimeType = (message as { type?: string }).type;
      if (message.type === "user_prompt") {
        const text = message.prompt.trim();
        return text ? `[用户] ${text}` : "";
      }

      if (runtimeType !== "assistant" && runtimeType !== "human" && runtimeType !== "user") {
        return "";
      }

      const nestedMessage = (message as Record<string, unknown>).message;
      if (!isObject(nestedMessage)) return "";

      const content = (nestedMessage as Record<string, unknown>).content;
      if (runtimeType === "assistant") {
        const text = renderAssistantContent(content);
        return text ? `[助手] ${text}` : "";
      }

      if (runtimeType === "human") {
        const text = renderAssistantContent(content);
        return text ? `[用户] ${text}` : "";
      }

      const toolResult = renderUserContextContent(content);
      return toolResult ? `[上下文] ${toolResult}` : "";
    })
    .filter(Boolean);

  if (historyLines.length === 0) return prompt;

  const historyText = truncateMiddle(historyLines.join("\n\n"), MAX_FALLBACK_HISTORY_CHARS);
  const guidance = buildSkillContinuationGuidance(skillNames);
  return [
    "以下是同一会话已保存在本地的历史记录。",
    "上游会话当前无法继续，请基于这些历史自然延续对话。",
    "",
    ...(guidance ? [guidance, ""] : []),
    "## 本地历史",
    historyText,
    "",
    "## 用户最新消息",
    prompt,
    "",
    "请直接继续回答，不要重复询问历史里已经提供过的信息。",
  ].join("\n");
}
