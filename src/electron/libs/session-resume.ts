import type { StreamMessage } from "../types.js";

const MAX_FALLBACK_HISTORY_CHARS = 6000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: string; text?: string } => isObject(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n...[中间部分省略]...\n${text.slice(-half)}`;
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
  return /No conversation found with session ID/i.test(text);
}

export function buildResumeFallbackPrompt(messages: StreamMessage[], prompt: string): string {
  const historyLines = messages
    .map((message) => {
      const runtimeType = (message as { type?: string }).type;
      if (message.type === "user_prompt") {
        const text = message.prompt.trim();
        return text ? `[用户] ${text}` : "";
      }

      if (runtimeType !== "assistant" && runtimeType !== "human") {
        return "";
      }

      const role = runtimeType === "assistant" ? "助手" : "用户";
      const nestedMessage = (message as Record<string, unknown>).message;
      const text = isObject(nestedMessage)
        ? extractTextContent((nestedMessage as Record<string, unknown>).content)
        : "";
      return text ? `[${role}] ${text}` : "";
    })
    .filter(Boolean);

  if (historyLines.length === 0) return prompt;

  const historyText = truncateMiddle(historyLines.join("\n\n"), MAX_FALLBACK_HISTORY_CHARS);
  return [
    "以下是同一会话已保存在本地的历史记录。",
    "上游会话当前无法继续，请基于这些历史自然延续对话。",
    "",
    "## 本地历史",
    historyText,
    "",
    "## 用户最新消息",
    prompt,
    "",
    "请直接继续回答，不要重复询问历史里已经提供过的信息。",
  ].join("\n");
}
