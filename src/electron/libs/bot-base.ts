/**
 * Shared base utilities for all bot implementations (Telegram, DingTalk, Feishu).
 *
 * Extracted from the three bot files to avoid triplication of:
 *   - buildQueryEnv        — Anthropic API key / base URL from settings
 *   - buildStructuredPersona — system prompt builder from AssistantConfig fields
 *   - buildHistoryContext   — in-memory + daily-log conversation context
 *   - isDuplicate / markProcessed — message dedup helpers (caller owns the Map)
 *   - ConvMessage / BaseBotOptions — shared types
 */

import { loadUserSettings } from "./user-settings.js";
import { getEnhancedEnv } from "./util.js";
import { getRecentConversationBlocks } from "./memory-store.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface ConvMessage {
  role: "user" | "assistant";
  content: string;
}

/** Common fields that all bot option interfaces share. */
export interface BaseBotOptions {
  assistantId: string;
  assistantName: string;
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  userContext?: string;
  /** Skill names to advertise in the system prompt (e.g. for Telegram /commands). */
  skillNames?: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Matches absolute file paths in assistant replies — used to scrub history. */
export const FILE_PATH_RE = /\/(?:tmp|var\/folders|private\/var|home|Users)\/\S+\.\w{2,6}/i;

// ─── buildQueryEnv ────────────────────────────────────────────────────────────

/**
 * Build the environment variables required by the Claude Agent SDK / Codex runner.
 * Reads Anthropic API key and base URL from user settings, falling back to env vars.
 */
export function buildQueryEnv(): Record<string, string | undefined> {
  const settings = loadUserSettings();
  const apiKey =
    settings.anthropicAuthToken ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    "";
  const baseURL = settings.anthropicBaseUrl || "";

  return {
    ...getEnhancedEnv(),
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: apiKey } : {}),
    ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
  };
}

// ─── buildStructuredPersona ───────────────────────────────────────────────────

/**
 * Build the system-prompt persona block from AssistantConfig fields.
 *
 * @param opts        Bot options implementing BaseBotOptions
 * @param extras      Optional extra sections appended at the end (platform-specific rules)
 */
export function buildStructuredPersona(
  opts: BaseBotOptions,
  ...extras: (string | undefined | null)[]
): string {
  const sections: string[] = [];
  const nameLine = `你的名字是「${opts.assistantName}」。`;
  const p = opts.persona?.trim();
  if (p) sections.push(`## 你的身份\n${nameLine}\n${p}`);
  else sections.push(`## 你的身份\n${nameLine}\n你是一个智能助手，请简洁有用地回答问题。`);

  if (opts.coreValues?.trim()) sections.push(`## 核心价值观\n${opts.coreValues.trim()}`);
  if (opts.relationship?.trim()) sections.push(`## 与用户的关系\n${opts.relationship.trim()}`);
  if (opts.cognitiveStyle?.trim()) sections.push(`## 你的思维方式\n${opts.cognitiveStyle.trim()}`);
  if (opts.operatingGuidelines?.trim()) sections.push(`## 操作规程\n${opts.operatingGuidelines.trim()}`);
  if (opts.userContext?.trim()) sections.push(`## 关于用户\n${opts.userContext.trim()}`);

  const normalized = (opts.skillNames ?? []).map((s) => s.trim()).filter(Boolean);
  if (normalized.length > 0) {
    sections.push(
      `## 可用技能\n用户可通过 /<技能名> 调用以下技能：\n${normalized.map((s) => `/${s}`).join("\n")}`,
    );
  }

  for (const extra of extras) {
    if (extra?.trim()) sections.push(extra.trim());
  }
  return sections.join("\n\n");
}

/** The "文件发送规则" section injected by Telegram (and optionally other platforms). */
export const FILE_SEND_RULE =
  "## 文件发送规则（强制）\n" +
  "当你生成了任何文件（音频、图片、视频、PDF、Excel 等），必须调用 `send_file` 工具将文件发送给用户。\n" +
  "- 不要说「已通过钉钉/其他渠道发送」\n" +
  "- 不要只告诉用户文件路径\n" +
  "- 直接调用 send_file(file_path='/tmp/xxx') 发送";

// ─── buildHistoryContext ──────────────────────────────────────────────────────

/**
 * Build a conversation-history string to inject into the system prompt.
 *
 * @param history             In-memory history (fallback when daily log is unavailable)
 * @param assistantId         Used to look up the daily conversation log
 * @param stripUserFilePaths  Strip trailing "文件路径: ..." from user messages (DingTalk)
 */
export function buildHistoryContext(
  history: ConvMessage[],
  assistantId?: string,
  stripUserFilePaths = false,
): string {
  // Primary: parse today's daily log for full Q&A pairs (persists across restarts).
  if (assistantId) {
    const fromLog = getRecentConversationBlocks(assistantId, 4);
    if (fromLog) return fromLog;
  }

  // Fallback: in-memory history — include both roles, filter file-analysis replies.
  if (!history.length) return "";
  const lines = history.slice(-8).map((m) => {
    const label = m.role === "user" ? "用户" : "助手";
    if (m.role === "assistant" && FILE_PATH_RE.test(m.content)) {
      return `${label}: [对某文件进行了分析，内容已省略]`;
    }
    const rawContent =
      stripUserFilePaths && m.role === "user"
        ? m.content.replace(/\n\n文件路径:[\s\S]*$/, "").trim()
        : m.content;
    const content = rawContent.length > 400 ? rawContent.slice(0, 400) + "…" : rawContent;
    return `${label}: ${content}`;
  });
  if (!lines.length) return "";
  return [
    "## 近期对话上下文（仅供参考）",
    "⚠️ 如历史中出现文件路径，那是以前的文件，与当前任务无关。",
    lines.join("\n"),
  ].join("\n");
}

// ─── Message deduplication ────────────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000;

/**
 * Check if a message key has already been processed (within the TTL window).
 * The caller owns the Map so each bot instance keeps independent dedup state.
 */
export function isDuplicate(key: string, store: Map<string, number>): boolean {
  const ts = store.get(key);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    store.delete(key);
    return false;
  }
  return true;
}

/**
 * Mark a message key as processed. Evicts stale entries when the store exceeds 5000 items.
 */
export function markProcessed(key: string, store: Map<string, number>): void {
  store.set(key, Date.now());
  if (store.size > 5000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, ts] of store) {
      if (ts < cutoff) store.delete(k);
    }
  }
}
