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

import { copyFileSync, existsSync, mkdirSync } from "fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import { loadUserSettings } from "./user-settings.js";
import { getEnhancedEnv } from "./util.js";
import { getRecentConversationBlocks, recordConversation } from "./memory-store.js";
import type { StreamMessage } from "../types.js";

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
  /** Per-message identity context; only set while building a prompt. */
  isOwner?: boolean;
}

export interface OpenAIOverrides {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Matches absolute file paths in assistant replies — used to scrub history. */
export const FILE_PATH_RE = /\/(?:tmp|var\/folders|private\/var|home|Users)\/\S+\.\w{2,6}/i;

// ─── buildQueryEnv ────────────────────────────────────────────────────────────

/**
 * Build the environment variables required by the Claude Agent SDK / Codex runner.
 * Reads Anthropic API key and base URL from user settings, falling back to env vars.
 * If assistantConfig is provided, its apiAuthToken/apiBaseUrl take priority over global settings,
 * allowing multiple assistants to run in parallel with different API keys.
 */
export function buildQueryEnv(assistantConfig?: { apiAuthToken?: string; apiBaseUrl?: string; model?: string }): Record<string, string | undefined> {
  const settings = loadUserSettings();
  const apiKey =
    assistantConfig?.apiAuthToken ||
    settings.anthropicAuthToken ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    "";
  const baseURL = assistantConfig?.apiBaseUrl || settings.anthropicBaseUrl || "";

  return {
    ...getEnhancedEnv(),
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: apiKey } : {}),
    ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
  };
}

/**
 * Build per-assistant OpenAI overrides for proxy routing.
 * Uses assistant-level settings when provided, with optional model fallback.
 */
export function buildOpenAIOverrides(
  assistantConfig?: { apiAuthToken?: string; apiBaseUrl?: string; model?: string },
  fallbackModel?: string,
): OpenAIOverrides | undefined {
  const apiKey = assistantConfig?.apiAuthToken?.trim() || undefined;
  const baseUrl = assistantConfig?.apiBaseUrl?.trim() || undefined;
  const model = (fallbackModel || assistantConfig?.model || "").trim() || undefined;
  if (!apiKey && !baseUrl && !model) return undefined;
  return { apiKey, baseUrl, model };
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
  const isOwner = opts.isOwner !== false;
  const nameLine = `你的名字是「${opts.assistantName}」。`;
  const p = opts.persona?.trim();
  if (p) sections.push(`## 你的身份\n${nameLine}\n${p}`);
  else sections.push(`## 你的身份\n${nameLine}\n你是一个智能助手，请简洁有用地回答问题。`);

  if (opts.coreValues?.trim()) sections.push(`## 核心价值观\n${opts.coreValues.trim()}`);
  if (!isOwner) {
    sections.push(
      "## 对话身份提示\n当前对话对象不是软件 owner。不要暴露或假设 owner 的个人信息、历史偏好、共享长期记忆或其他联系人/群聊的上下文，只能基于当前会话和当前联系人/群聊的专属记忆回答。",
    );
  }
  const relationshipText = isOwner
    ? opts.relationship?.trim()
    : "你正在与外部联系人或群成员对话。保持礼貌、专业和有边界感，只根据当前对话中可见的信息协助对方。";
  if (relationshipText) sections.push(`## 与用户的关系\n${relationshipText}`);
  if (opts.cognitiveStyle?.trim()) sections.push(`## 你的思维方式\n${opts.cognitiveStyle.trim()}`);
  if (opts.operatingGuidelines?.trim()) sections.push(`## 操作规程\n${opts.operatingGuidelines.trim()}`);
  if (isOwner && opts.userContext?.trim()) sections.push(`## 关于用户\n${opts.userContext.trim()}`);

  const normalized = (opts.skillNames ?? []).map((s) => s.trim()).filter(Boolean);
  if (normalized.length > 0) {
    sections.push(
      `## 可用技能\n用户可通过 /<技能名> 调用以下技能：\n${normalized.map((s) => `/${s}`).join("\n")}`,
    );
  }

  sections.push(SCHEDULE_REMINDER_RULE, IMAGE_INLINE_RULE, BOT_VISUALIZATION_RULE);

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
  "- 优先将最终成品保存到当前工作区的 `outputs/<助理名>/` 目录，再调用 `send_file` 发送\n" +
  "- 如果文件先生成在 `/tmp` 等临时目录，发送时系统会自动归档到输出目录";

export const SCHEDULE_REMINDER_RULE =
  "## 定时与提醒规则\n" +
  "- 用户要求你在未来某个时间提醒、通知、催办，或按每天/每周/间隔重复执行时，必须调用 `create_scheduled_task` 创建系统定时任务。\n" +
  "- 简单提醒优先使用 `notifyText`；只有需要 AI 思考、搜索、读写文件或调用其他工具时才使用 `prompt`。\n" +
  "- 除非用户明确要求“只在当前会话里临时提醒”或“临时定时”，否则禁止使用当前会话内置的临时提醒、临时定时器或类似替代方案。\n" +
  "- 创建定时任务时若需要 `assistantId`，应使用助理 ID，而不是助理显示名称。";

/**
 * The "图文混排规则" section — injected via applyAssistantContext for all channels (App + Bot).
 * Instructs Claude to embed local image paths with Markdown ![](path) syntax so the UI
 * can render them inline and bots can extract & upload them.
 */
export const IMAGE_INLINE_RULE =
  "## 图文混排规则\n" +
  "当你的回复中包含本地图片文件（如截图、生成图等），必须将文件路径直接以 Markdown 图片语法嵌入回复正文：\n" +
  "- 格式：`![图片描述](/绝对/路径/图片.png)`\n" +
  "- 图片应出现在文字对应位置，不要只列文件路径。\n" +
  "- Windows 路径示例：`![截图](C:/Users/xxx/AppData/Local/Temp/shot.png)`\n" +
  "- macOS/Linux 路径示例：`![关键截图](/tmp/shot-123.png)`";

export const PRIVATE_WHITELIST_RULE =
  "## 私聊白名单权限\n" +
  "当前发起者位于本 Bot 的私聊白名单中，可使用完整的共享工具能力完成 setup、本地配置读取和自动化操作。\n" +
  "- 常见本地配置路径：`~/.vk-cowork/user-settings.json`、`~/.vk-cowork/bot-config.json`\n" +
  "- 读取本地配置时优先使用 `read_document`\n" +
  "- 一旦命中敏感配置/密钥路径，不要调用任何记忆沉淀或经验沉淀工具";

export type VisibleArtifactOptions = {
  defaultCwd?: string;
  assistantName?: string;
  assistantId?: string;
};

export type VisibleArtifactResult =
  | { filePath: string; originalPath: string; archivedPath?: string; error?: undefined }
  | { filePath: string; originalPath: string; archivedPath?: string; error: string };

export function sanitizeArtifactPathSegment(value?: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[^\w\-\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function getAssistantOutputDir(opts: VisibleArtifactOptions): string | null {
  const cwd = opts.defaultCwd?.trim();
  if (!cwd) return null;
  const dirName = sanitizeArtifactPathSegment(opts.assistantName)
    || sanitizeArtifactPathSegment(opts.assistantId)
    || "assistant";
  return join(resolve(cwd), "outputs", dirName);
}

function isPathInsideDir(targetDir: string, targetPath: string): boolean {
  const rel = relative(targetDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildUniqueArtifactPath(targetDir: string, fileName: string): string {
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  let candidate = join(targetDir, fileName);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(targetDir, `${stem}-${index}${ext}`);
    index++;
  }
  return candidate;
}

export function prepareVisibleArtifact(
  filePath: string,
  opts: VisibleArtifactOptions = {},
): VisibleArtifactResult {
  const rawPath = String(filePath ?? "").trim();
  const originalPath = rawPath
    ? (isAbsolute(rawPath) ? resolve(rawPath) : resolve(opts.defaultCwd?.trim() || process.cwd(), rawPath))
    : rawPath;

  if (!originalPath || !existsSync(originalPath)) {
    return {
      filePath: originalPath || rawPath,
      originalPath: originalPath || rawPath,
      error: `文件不存在: ${rawPath || filePath}`,
    };
  }

  const outputDir = getAssistantOutputDir(opts);
  if (!outputDir) {
    return { filePath: originalPath, originalPath };
  }

  if (isPathInsideDir(outputDir, originalPath)) {
    return { filePath: originalPath, originalPath };
  }

  mkdirSync(outputDir, { recursive: true });
  const archivedPath = buildUniqueArtifactPath(outputDir, basename(originalPath));
  copyFileSync(originalPath, archivedPath);
  return { filePath: archivedPath, originalPath, archivedPath };
}

export const BOT_VISUALIZATION_RULE =
  "## Bot 可视化回复规则\n" +
  "当前回复渠道是机器人聊天（如 Telegram、钉钉、飞书、QQ），不能使用前端专属的 `show-widget`、HTML、JS、iframe 或 Mermaid 代码块作为最终可视化输出。\n" +
  "当用户要求图表、流程图、结构图、时间线、海报、示意图等可视化内容时，必须先在本地生成图片文件，再把图片以内嵌方式发出。\n" +
  "- 优先生成 PNG；必要时也可生成 JPG 或 WebP\n" +
  "- 推荐用 Python（如 matplotlib、Pillow）或 SVG 导出 PNG\n" +
  "- 最终回复里把图片放在对应文字位置：`![图表说明](/绝对/路径/chart.png)`\n" +
  "- 不要把 `show-widget` 代码 fence、HTML 源码、Chart.js 代码直接发给用户\n" +
  "- 如果有多张图，按“文字 -> 图片 -> 文字 -> 图片”顺序组织回复";

// ─── parseReplySegments ───────────────────────────────────────────────────────

/** A segment in a mixed image+text reply. */
export type ReplySegment =
  | { kind: "text"; content: string }
  | { kind: "image"; path: string; alt: string };

/** Returns true for absolute local paths on both macOS/Linux and Windows. */
function isAbsLocalPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p);
}

/**
 * Split a Markdown reply that contains `![alt](path)` image references into an
 * ordered array of text segments and image segments.  Only absolute local paths
 * are extracted as image segments — remote http/https URLs are left as-is inside
 * text segments so they are rendered normally.
 */
export function parseReplySegments(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  // Regex: ![alt](path) where path is an absolute local path
  const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = IMG_RE.exec(text)) !== null) {
    const [fullMatch, alt, rawPath] = match;
    const path = rawPath.trim();

    if (!isAbsLocalPath(path)) continue; // leave remote URLs in text

    // Text before this image
    const before = text.slice(lastIndex, match.index);
    if (before) segments.push({ kind: "text", content: before });

    segments.push({ kind: "image", path, alt });
    lastIndex = match.index + fullMatch.length;
  }

  // Remaining text after the last image
  const trailing = text.slice(lastIndex);
  if (trailing) segments.push({ kind: "text", content: trailing });

  // If nothing was parsed as image, return a single text segment
  if (segments.length === 0) return [{ kind: "text", content: text }];
  return segments;
}

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
  contactKey?: string,
): string {
  // Primary: parse today's daily log for full Q&A pairs (persists across restarts).
  if (assistantId) {
    const fromLog = getRecentConversationBlocks(assistantId, 4, contactKey);
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

export type BotPostResponseTasks = {
  logEntry: string;
  recordOpts: {
    assistantId?: string;
    assistantName?: string;
    channel?: string;
    contactKey?: string;
    isOwner?: boolean;
  };
  updateTitle?: () => Promise<void> | void;
  onError?: (phase: "recordConversation" | "updateTitle", error: unknown) => void;
};

/**
 * Keep bot reply delivery on the critical path, and move log/title work
 * to the next tick so the user sees the answer first.
 */
export function scheduleBotPostResponseTasks(opts: BotPostResponseTasks): void {
  const timer = setTimeout(() => {
    try {
      recordConversation(opts.logEntry, opts.recordOpts);
    } catch (error) {
      opts.onError?.("recordConversation", error);
    }

    if (!opts.updateTitle) return;
    void Promise.resolve(opts.updateTitle()).catch((error) => {
      opts.onError?.("updateTitle", error);
    });
  }, 0);
  timer.unref?.();
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

// ─── extractPartialText ───────────────────────────────────────────────────────

/**
 * Extract the accumulated partial text from a Claude Agent SDK streaming message.
 * Used by all bot implementations (Telegram, DingTalk) for real-time preview.
 */
export function extractPartialText(message: Record<string, unknown>): string | null {
  const msg = message?.message as Record<string, unknown> | undefined;
  if (!msg?.content || !Array.isArray(msg.content)) return null;
  const texts = (msg.content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!);
  return texts.length > 0 ? texts.join("") : null;
}

function getAssistantBufferKey(message: StreamMessage): string | null {
  if ((message as { type?: string }).type !== "assistant") return null;
  const assistantMessage = message as {
    uuid?: unknown;
    message?: { id?: unknown };
  };
  if (typeof assistantMessage.uuid === "string" && assistantMessage.uuid) {
    return `uuid:${assistantMessage.uuid}`;
  }
  if (
    assistantMessage.message
    && typeof assistantMessage.message.id === "string"
    && assistantMessage.message.id
  ) {
    return `id:${assistantMessage.message.id}`;
  }
  return null;
}

/**
 * Persist bot stream messages while buffering assistant snapshots so only the
 * latest complete assistant message is written between tool/result boundaries.
 */
export function bufferPersistedBotMessage(
  message: StreamMessage,
  bufferedAssistant: StreamMessage | null,
  persist: (message: StreamMessage) => void,
): StreamMessage | null {
  if (message.type === "stream_event") return bufferedAssistant;

  if (message.type === "assistant") {
    if (bufferedAssistant) {
      const previousKey = getAssistantBufferKey(bufferedAssistant);
      const nextKey = getAssistantBufferKey(message);
      if (previousKey && nextKey && previousKey !== nextKey) {
        persist(bufferedAssistant);
      }
    }
    return message;
  }

  if (bufferedAssistant) persist(bufferedAssistant);
  persist(message);
  return null;
}

export function flushBufferedBotAssistantMessage(
  bufferedAssistant: StreamMessage | null,
  persist: (message: StreamMessage) => void,
): void {
  if (bufferedAssistant) persist(bufferedAssistant);
}

// ─── MediaGroupBuffer ─────────────────────────────────────────────────────────

export interface MediaGroupItem {
  filePath: string | null;
  messageId: number;
  caption?: string;
}

export interface FlushedMediaGroup {
  chatId: string;
  caption: string;
  filePaths: string[];
  messageIds: number[];
}

const DEFAULT_MEDIA_GROUP_WAIT_MS = 1_500;

/**
 * Aggregates media-group messages (Telegram albums) arriving as separate updates
 * into a single batch, then fires a callback with all collected file paths.
 */
export class MediaGroupBuffer {
  private groups = new Map<string, {
    chatId: string;
    caption: string;
    filePaths: string[];
    messageIds: number[];
    timer: ReturnType<typeof setTimeout>;
  }>();
  private waitMs: number;
  private onFlush: (groupKey: string, result: FlushedMediaGroup) => void;

  constructor(
    onFlush: (groupKey: string, result: FlushedMediaGroup) => void,
    waitMs = DEFAULT_MEDIA_GROUP_WAIT_MS,
  ) {
    this.onFlush = onFlush;
    this.waitMs = waitMs;
  }

  add(groupKey: string, chatId: string, item: MediaGroupItem): number {
    const existing = this.groups.get(groupKey);
    if (existing) {
      if (item.filePath) existing.filePaths.push(item.filePath);
      existing.messageIds.push(item.messageId);
      if (!existing.caption && item.caption) existing.caption = item.caption;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(groupKey), this.waitMs);
      return existing.filePaths.length;
    }

    const timer = setTimeout(() => this.flush(groupKey), this.waitMs);
    this.groups.set(groupKey, {
      chatId,
      caption: item.caption ?? "",
      filePaths: item.filePath ? [item.filePath] : [],
      messageIds: [item.messageId],
      timer,
    });
    return item.filePath ? 1 : 0;
  }

  private flush(groupKey: string): void {
    const entry = this.groups.get(groupKey);
    if (!entry) return;
    this.groups.delete(groupKey);
    this.onFlush(groupKey, {
      chatId: entry.chatId,
      caption: entry.caption,
      filePaths: entry.filePaths,
      messageIds: entry.messageIds,
    });
  }

  clear(): void {
    for (const entry of this.groups.values()) clearTimeout(entry.timer);
    this.groups.clear();
  }

  get size(): number {
    return this.groups.size;
  }
}
