/**
 * Telegram Bot Service (grammY)
 *
 * Mirrors the DingTalk/Feishu bot architecture:
 * - Long polling via grammY (with optional proxy)
 * - Access control: dmPolicy (open/allowlist), groupPolicy (open/allowlist/mention)
 * - Message deduplication (5-min TTL)
 * - Media handling: photos, voice, documents, video
 * - Claude Agent SDK query() with shared MCP + per-session MCP
 * - OpenAI provider support
 * - Session/memory sync with in-app session store
 * - Conversation history (last N turns)
 * - Dynamic session title generation
 * - Proactive messaging
 * - Telegram HTML formatting + message chunking (4096 char limit)
 */
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { promptOnce, runAgent } from "./agent-client.js";
import { EventEmitter } from "events";
import { homedir } from "os";
import { loadUserSettings } from "./user-settings.js";
import { buildSmartMemoryContext, recordConversation } from "./memory-store.js";
import { patchAssistantBotOwnerIds, loadAssistantsConfig } from "./assistants-config.js";
import { getClaudeCodePath } from "./util.js";
import type { SessionStore } from "./session-store.js";
import type { StreamMessage } from "../types.js";
import { createSharedMcpServer } from "./shared-mcp.js";
import { loadMcporterServers } from "./mcporter-loader.js";
import {
  type ConvMessage,
  type BaseBotOptions,
  FILE_PATH_RE,
  FILE_SEND_RULE,
  buildOpenAIOverrides,
  buildQueryEnv,
  buildStructuredPersona as buildStructuredPersonaBase,
  buildHistoryContext,
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
  parseReplySegments,
  extractPartialText,
  bufferPersistedBotMessage,
  flushBufferedBotAssistantMessage,
  MediaGroupBuffer,
  type FlushedMediaGroup,
} from "./bot-base.js";
import {
  buildActivatedSkillSection,
  loadInstalledSkills,
  resolveSkillCommand,
} from "./skill-context.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface TelegramBotOptions {
  token: string;
  proxy?: string;
  assistantId: string;
  assistantName: string;
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  userContext?: string;
  provider?: "claude" | "openai";
  model?: string;
  defaultCwd?: string;
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  /** Require @mention in groups before responding */
  requireMention?: boolean;
  /** Owner Telegram user IDs for proactive messaging */
  ownerUserIds?: string[];
  /** Skill names configured for the assistant */
  skillNames?: string[];
}


interface StreamResult {
  text: string;
  draftMessageId: number | null;
}

// ─── Streaming helpers ───────────────────────────────────────────────────────

const DRAFT_THROTTLE_MS = 1500;
const DRAFT_SUFFIX = "\n\n⏳ ...";
const HEARTBEAT_INTERVAL_MS = 60_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const MEDIA_GROUP_WAIT_MS = 1_500;

// ─── Conversation history / persona (delegated to bot-base) ──────────────────

/** Telegram-specific persona wrapper: injects FILE_SEND_RULE as a built-in extra. */
function buildStructuredPersona(
  opts: TelegramBotOptions,
  ...extras: (string | undefined | null)[]
): string {
  return buildStructuredPersonaBase(opts, FILE_SEND_RULE, ...extras);
}

// ─── Message deduplication ────────────────────────────────────────────────────

const processedMsgs = new Map<string, number>();

function isDuplicate(key: string): boolean { return isDuplicateMsg(key, processedMsgs); }
function markProcessed(key: string): void { markProcessedMsg(key, processedMsgs); }

// ─── Access control ───────────────────────────────────────────────────────────

function isAllowed(ctx: Context, opts: TelegramBotOptions): boolean {
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const userId = String(ctx.from?.id ?? "");

  if (isGroup) {
    if ((opts.groupPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      const chatId = String(ctx.chat?.id ?? "");
      if (!allowed.includes(chatId) && !allowed.includes(userId)) {
        console.log(`[Telegram] Group ${chatId} / user ${userId} blocked by groupPolicy=allowlist`);
        return false;
      }
    }
  } else {
    if ((opts.dmPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      if (!userId || !allowed.includes(userId)) {
        console.log(`[Telegram] User ${userId} blocked by dmPolicy=allowlist`);
        return false;
      }
    }
  }
  return true;
}

// ─── Mention detection ────────────────────────────────────────────────────────

function isMentioned(ctx: Context, botUsername: string): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? [];
  for (const entity of entities) {
    if (entity.type === "mention") {
      const text = ctx.message?.text ?? ctx.message?.caption ?? "";
      const mention = text.substring(entity.offset, entity.offset + entity.length);
      if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
  }
  return false;
}

// ─── Markdown to Telegram HTML conversion ─────────────────────────────────────

function markdownToTelegramHtml(text: string): string {
  // Phase 1: stash code blocks and inline code before HTML-escaping plain text,
  // so their content is escaped once and the tags themselves aren't double-escaped.
  const blocks: string[] = [];
  const inlines: string[] = [];

  let result = text;

  result = result.replace(/```(\w+)?\n?([\s\S]*?)```/gs, (_m, _lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `\x02B${idx}\x03`;
  });

  result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlines.length;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\x02I${idx}\x03`;
  });

  // Phase 2: escape remaining plain text so raw < > & don't break parse_mode HTML.
  result = escapeHtml(result);

  // Phase 3: apply Markdown → Telegram HTML conversions on now-safe text.
  // Headings → bold (Telegram has no heading tags)
  result = result.replace(/^#{1,2} (.+)$/gm, "<b>$1</b>");
  result = result.replace(/^### (.+)$/gm, "<b>$1</b>");
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
  // Italic (avoid matching bold **)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  result = result.replace(/(?<!_)_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, "<i>$1</i>");
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Horizontal rule → Unicode line
  result = result.replace(/^---+$/gm, "──────────────");

  // Phase 4: restore stashed code blocks and inline code.
  result = result.replace(/\x02B(\d+)\x03/g, (_m, i) => blocks[parseInt(i)]);
  result = result.replace(/\x02I(\d+)\x03/g, (_m, i) => inlines[parseInt(i)]);

  return result;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Message chunking (Telegram 4096 char limit) ──────────────────────────────

const TG_MESSAGE_LIMIT = 4096;

function chunkMessage(text: string): string[] {
  if (text.length <= TG_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", TG_MESSAGE_LIMIT);
    if (splitAt < TG_MESSAGE_LIMIT * 0.3) {
      splitAt = remaining.lastIndexOf(" ", TG_MESSAGE_LIMIT);
    }
    if (splitAt < TG_MESSAGE_LIMIT * 0.3) {
      splitAt = TG_MESSAGE_LIMIT;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

// ─── Status emitter ───────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onTelegramBotStatusChange(
  cb: (assistantId: string, status: TelegramBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emitStatus(assistantId: string, status: TelegramBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Session update emitter ───────────────────────────────────────────────────

const sessionUpdateEmitter = new EventEmitter();

export function onTelegramSessionUpdate(
  cb: (sessionId: string, updates: { title?: string; status?: string }) => void,
): () => void {
  sessionUpdateEmitter.on("update", cb);
  return () => sessionUpdateEmitter.off("update", cb);
}

function emitSessionUpdate(sessionId: string, updates: { title?: string; status?: string }) {
  sessionStore?.updateSession(sessionId, updates as Parameters<SessionStore["updateSession"]>[1]);
  sessionUpdateEmitter.emit("update", sessionId, updates);
}

// ─── Injected session store ───────────────────────────────────────────────────

let sessionStore: SessionStore | null = null;

export function setTelegramSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Connection pool ──────────────────────────────────────────────────────────

const pool = new Map<string, TelegramConnection>();

function findAssistantByToken(token: string, excludeAssistantId?: string): string | null {
  for (const [assistantId, conn] of pool.entries()) {
    if (assistantId === excludeAssistantId) continue;
    if (conn.opts.token === token) return assistantId;
  }
  return null;
}

export async function startTelegramBot(opts: TelegramBotOptions): Promise<void> {
  stopTelegramBot(opts.assistantId);

  // Telegram long polling allows only one consumer per bot token.
  // If another assistant is using the same token, stop it first to avoid 409 conflicts.
  const duplicateAssistantId = findAssistantByToken(opts.token, opts.assistantId);
  if (duplicateAssistantId) {
    console.warn(
      `[Telegram] Duplicate token detected: stopping assistant=${duplicateAssistantId} before starting assistant=${opts.assistantId}`,
    );
    stopTelegramBot(duplicateAssistantId);
  }

  const conn = new TelegramConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start();
}

export function stopTelegramBot(assistantId: string): void {
  const conn = pool.get(assistantId);
  if (conn) {
    conn.stop();
    pool.delete(assistantId);
  }
  // Clean up related maps to prevent memory leaks
  const keysToClean = Array.from(histories.keys()).filter(k => k.startsWith(assistantId));
  for (const key of keysToClean) {
    histories.delete(key);
    botSessionIds.delete(key);
  }
  emitStatus(assistantId, "disconnected");
}

export function getTelegramBotStatus(assistantId: string): TelegramBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

/** Returns the first assistantId that has a connected Telegram bot, or null. */
export function getAnyConnectedTelegramAssistantId(): string | null {
  for (const [id, conn] of pool.entries()) {
    if (conn.status === "connected") return id;
  }
  return null;
}

export function updateTelegramBotConfig(
  assistantId: string,
  updates: Partial<Pick<TelegramBotOptions, "provider" | "model" | "persona" | "coreValues" | "relationship" | "cognitiveStyle" | "operatingGuidelines" | "userContext" | "assistantName" | "defaultCwd" | "skillNames">>,
): void {
  const conn = pool.get(assistantId);
  if (!conn) return;
  const prevSkills = conn.opts.skillNames;
  Object.assign(conn.opts, updates);
  if (updates.skillNames && JSON.stringify(updates.skillNames) !== JSON.stringify(prevSkills)) {
    conn.refreshCommands().catch((err) => console.warn("[Telegram] Failed to refresh commands:", err));
  }
  console.log(`[Telegram] Config updated for assistant=${assistantId}:`, Object.keys(updates));
}

// ─── Proactive messaging ──────────────────────────────────────────────────────

export async function sendProactiveTelegramMessage(
  assistantId: string,
  text: string,
  opts?: { targets?: string[]; title?: string },
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `Telegram Bot (${assistantId}) 未连接` };
  }
  return conn.sendProactive(text, opts?.targets);
}

// ─── Conversation history & session management ────────────────────────────────

const histories = new Map<string, ConvMessage[]>();
const MAX_TURNS = 10;
const botSessionIds = new Map<string, string>();
const titledSessions = new Map<string, number>();

function getHistory(key: string): ConvMessage[] {
  if (!histories.has(key)) histories.set(key, []);
  return histories.get(key)!;
}

function getBotSession(
  assistantId: string,
  chatId: string,
  assistantName: string,
  provider: "claude" | "openai",
  model: string | undefined,
  cwd: string | undefined,
  skillNames?: string[],
): string {
  const key = `${assistantId}:${chatId}`;
  if (!sessionStore) throw new Error("[Telegram] SessionStore not injected");
  const existingId = botSessionIds.get(key);
  if (existingId && sessionStore.getSession(existingId)) return existingId;
  const session = sessionStore.createSession({
    title: `[Telegram] ${assistantName}`,
    assistantId,
    assistantSkillNames: skillNames ?? [],
    provider,
    model,
    cwd,
  });
  botSessionIds.set(key, session.id);
  return session.id;
}

async function updateBotSessionTitle(
  sessionId: string,
  history: ConvMessage[],
  prefix = "[Telegram]",
): Promise<void> {
  const turns = Math.floor(history.length / 2);
  const prevCount = titledSessions.get(sessionId) ?? 0;
  const shouldUpdate = turns === 1 || (turns === 3 && prevCount < 2);
  if (!shouldUpdate) return;
  titledSessions.set(sessionId, prevCount + 1);

  const recentTurns = history.slice(-6);
  const contextLines = recentTurns
    .map((m) => {
      const role = m.role === "user" ? "用户" : "助手";
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}：${text.slice(0, 200)}`;
    })
    .join("\n");

  const fallback = (recentTurns[0]
    ? (typeof recentTurns[0].content === "string" ? recentTurns[0].content : "对话")
    : "对话"
  ).slice(0, 30).trim();

  try {
    const generated = (await promptOnce(
      `请根据以下对话内容，生成一个简短的中文标题（不超过12字，不加引号，不加标点），直接输出标题，不输出其他内容：\n\n${contextLines}`,
    ))?.trim() || "";
    const title = (generated && generated !== "New Session") ? generated : fallback;
    emitSessionUpdate(sessionId, { title: `${prefix} ${title}` });
    console.log(`[Telegram] Session title updated (turn ${turns}): "${title}"`);
  } catch (err) {
    console.warn(`[Telegram] Title generation failed:`, err);
    if (prevCount === 0) {
      emitSessionUpdate(sessionId, { title: `${prefix} ${fallback}` });
    }
  }
}

// ─── Claude session ID registry (for query() resume) ─────────────────────────

const botClaudeSessionIds = new Map<string, string>();

function getBotClaudeSessionId(key: string): string | undefined {
  return botClaudeSessionIds.get(key);
}

function setBotClaudeSessionId(key: string, claudeSessionId: string): void {
  botClaudeSessionIds.set(key, claudeSessionId);
  const appSessionId = botSessionIds.get(key);
  if (appSessionId && sessionStore) {
    sessionStore.updateSession(appSessionId, { claudeSessionId });
  }
}

// ─── Media extraction ─────────────────────────────────────────────────────────

async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  proxyUrl?: string,
  originalName?: string,
): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;

    const token = bot.token;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    let resp: Response;
    if (proxyUrl) {
      const undici = await import("undici");
      const dispatcher = new undici.ProxyAgent(proxyUrl);
      resp = await undici.fetch(url, { dispatcher }) as unknown as Response;
    } else {
      resp = await fetch(url);
    }
    if (!resp.ok) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());

    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    // Prefer original filename to preserve context; fall back to Telegram's ext
    let fileName: string;
    if (originalName) {
      const safeName = originalName.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
      fileName = `vk-tg-${Date.now()}-${safeName}`;
    } else {
      const ext = file.file_path.split(".").pop() ?? "bin";
      fileName = `vk-tg-${Date.now()}.${ext}`;
    }

    const tmpPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[Telegram] File saved: ${tmpPath} (${(buffer.length / 1024).toFixed(1)}KB)`);
    return tmpPath;
  } catch (err) {
    console.error(`[Telegram] File download error:`, err);
    return null;
  }
}

// ─── TelegramConnection ──────────────────────────────────────────────────────

class TelegramConnection {
  status: TelegramBotStatus = "disconnected";
  opts: TelegramBotOptions;
  private bot: Bot | null = null;
  private stopped = false;
  private inflight = new Set<string>();
  private botUsername = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private effectiveProxyUrl: string | undefined = undefined;
  private mediaGroupBuffer: MediaGroupBuffer;
  private mediaGroupCtxMap = new Map<string, Context>();

  constructor(opts: TelegramBotOptions) {
    this.opts = opts;
    this.mediaGroupBuffer = new MediaGroupBuffer(
      (groupKey, result) => this.onMediaGroupFlushed(groupKey, result).catch(
        (err) => console.error("[Telegram] Media group flush error:", err),
      ),
      MEDIA_GROUP_WAIT_MS,
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.clearTimers();
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting");

    try {
      const botConfig: ConstructorParameters<typeof Bot>[1] = {};

      const proxyUrl = this.opts.proxy
        || process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY
        || process.env.all_proxy || process.env.ALL_PROXY
        || undefined;

      this.effectiveProxyUrl = proxyUrl;

      let proxyDispatcher: import("undici").Dispatcher | undefined;
      if (proxyUrl) {
        const undici = await import("undici");
        proxyDispatcher = new undici.ProxyAgent(proxyUrl);
        console.log(`[Telegram] Using proxy: ${proxyUrl}`);
      }

      this.bot = new Bot(this.opts.token, botConfig);

      // Electron's built-in fetch ignores undici dispatcher, so we intercept
      // all grammY API calls and route them through undici.fetch + ProxyAgent.
      if (proxyDispatcher) {
        const dispatcher = proxyDispatcher;
        const undiciModule = await import("undici");
        const { InputFile } = await import("grammy");

        this.bot.api.config.use(async (_prev, method, payload, signal) => {
          // File upload methods contain InputFile instances which cannot be JSON-serialized.
          // Fall back to grammY's native multipart handler for these methods.
          const isFileUpload = payload != null && Object.values(payload as object).some((v) => v instanceof InputFile);
          if (isFileUpload) {
            if (method !== "getUpdates") console.log(`[Telegram] API call (native): ${method}`);
            return _prev(method, payload, signal);
          }

          const url = `https://api.telegram.org/bot${this.bot!.token}/${method}`;
          const body = payload !== undefined ? JSON.stringify(payload) : undefined;
          if (method !== "getUpdates") {
            console.log(`[Telegram] API call: ${method}`);
          }
          // Bridge AbortSignal: Electron's AbortSignal is incompatible with undici's,
          // so create a fresh controller and wire up the abort event.
          let fetchSignal: AbortSignal | undefined;
          if (signal) {
            if (signal.aborted) {
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            const ac = new AbortController();
            signal.addEventListener("abort", () => ac.abort((signal as any).reason), { once: true });
            fetchSignal = ac.signal;
          }
          try {
            const resp = await undiciModule.fetch(url, {
              method: "POST",
              headers: body ? { "Content-Type": "application/json" } : undefined,
              body,
              dispatcher,
              signal: fetchSignal,
            });
            const json = await resp.json() as any;
            if (!json.ok && method !== "getUpdates") {
              console.error(`[Telegram] API error ${method}:`, json.description);
            }
            return json;
          } catch (err) {
            console.error(`[Telegram] API fetch error ${method}:`, err instanceof Error ? err.message : err);
            throw err;
          }
        });
      }

      const me = await this.bot.api.getMe();
      this.botUsername = me.username ?? "";
      console.log(`[Telegram] Authenticated as @${this.botUsername}`);

      await this.registerCommands();
      this.setupHandlers();

      this.bot.start({
        onStart: () => {
          this.reconnectAttempts = 0;
          this.status = "connected";
          emitStatus(this.opts.assistantId, "connected");
          console.log(`[Telegram] Connected: assistant=${this.opts.assistantId} bot=@${this.botUsername}`);
        },
      }).catch((err) => {
        // bot.start() rejects when the polling loop exits abnormally.
        // 409 means another instance is still holding the long-poll connection;
        // wait longer than Telegram's 30s poll timeout before retrying.
        if (this.stopped) return;
        const is409 = err instanceof GrammyError && err.error_code === 409;
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[Telegram] Polling stopped (${is409 ? "409 conflict" : "error"}): ${detail}`);
        this.status = "error";
        emitStatus(this.opts.assistantId, "error", detail);
        if (is409) {
          // Telegram's default getUpdates timeout is 30s; wait 35s for the old connection to expire.
          console.log("[Telegram] Waiting 35s for previous long-poll to expire before reconnecting...");
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.stopped) this.scheduleReconnect();
          }, 35_000);
        } else {
          this.scheduleReconnect();
        }
      });

      this.status = "connected";
      emitStatus(this.opts.assistantId, "connected");
      this.startHeartbeat();
    } catch (err) {
      this.status = "error";
      const detail = err instanceof Error ? err.message : String(err);
      emitStatus(this.opts.assistantId, "error", detail);
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.bot) {
      try { this.bot.stop(); } catch { /* ignore */ }
      this.bot = null;
    }
    this.status = "disconnected";
  }

  // ── Auto-reconnect ─────────────────────────────────────────────────────────

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.mediaGroupBuffer.clear();
    this.mediaGroupCtxMap.clear();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (this.stopped || !this.bot) return;
      try {
        await this.bot.api.getMe();
      } catch (err) {
        console.warn("[Telegram] Heartbeat failed:", err instanceof Error ? err.message : err);
        if (!this.stopped) this.scheduleReconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.clearTimers();

    const jitter = Math.random() * 0.25;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts) * (1 + jitter), RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    console.log(`[Telegram] Scheduling reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting", `重连中 (${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        if (this.bot) { try { this.bot.stop(); } catch { /* ignore */ } this.bot = null; }
        await this.start();
      } catch (err) {
        console.error("[Telegram] Reconnect failed:", err instanceof Error ? err.message : err);
        if (!this.stopped) this.scheduleReconnect();
      }
    }, delay);
  }

  async refreshCommands(): Promise<void> {
    return this.registerCommands();
  }

  private async registerCommands(): Promise<void> {
    if (!this.bot) return;
    try {
      const builtinCmds = [
        { command: "start", description: "开始对话 / 查看欢迎信息" },
        { command: "myid", description: "查看你的 Telegram ID" },
        { command: "new", description: "重置当前对话" },
        { command: "skills", description: "查看可用技能列表" },
      ];

      const skillCmds: { command: string; description: string }[] = [];
      const skillNames = this.opts.skillNames ?? [];
      if (skillNames.length > 0) {
        const installed = loadInstalledSkills();
        for (const name of skillNames) {
          const info = installed.get(name);
          const cmd = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
          const desc = (info?.label ?? name).slice(0, 256);
          skillCmds.push({ command: cmd, description: desc });
        }
      }

      const allCmds = [...builtinCmds, ...skillCmds].slice(0, 100);
      await this.bot.api.setMyCommands(allCmds);
      console.log(`[Telegram] Commands registered: ${builtinCmds.length} builtin + ${skillCmds.length} skills`);
    } catch (err) {
      console.warn(`[Telegram] Failed to register commands:`, err);
    }
  }

  // ── Status reactions ─────────────────────────────────────────────────────────

  private async setReaction(chatId: number | string, messageId: number, emoji: string | null): Promise<void> {
    if (!this.bot) return;
    try {
      if (emoji) {
        await this.bot.api.setMessageReaction(
          Number(chatId), messageId,
          [{ type: "emoji", emoji: emoji as any }],  // eslint-disable-line @typescript-eslint/no-explicit-any
        );
      } else {
        await this.bot.api.setMessageReaction(Number(chatId), messageId, []);
      }
    } catch {
      // Silently ignore — reactions may not be supported in this chat
    }
  }

  async sendProactive(text: string, targets?: string[]): Promise<{ ok: boolean; error?: string }> {
    if (!this.bot) return { ok: false, error: "Bot 未启动" };

    const chatIds = targets?.length ? targets : (this.opts.ownerUserIds ?? []);
    if (chatIds.length === 0) {
      return { ok: false, error: "未指定接收者，请在配置中填写 ownerUserIds" };
    }

    const errors: string[] = [];
    for (const chatId of chatIds) {
      try {
        const chunks = chunkMessage(text);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), {
            parse_mode: "HTML",
          });
        }
      } catch (err) {
        errors.push(`${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === chatIds.length) {
      return { ok: false, error: errors.join("; ") };
    }
    return { ok: true };
  }

  // ── Handler setup ────────────────────────────────────────────────────────────

  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.on("message", async (ctx) => {
      if (this.stopped) return;
      try {
        await this.handleMessage(ctx);
      } catch (err) {
        console.error("[Telegram] Message handling error:", err);
      }
    });

    this.bot.catch((err) => {
      const ctx = err.ctx;
      console.error(`[Telegram] Error for update ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error("[Telegram] API error:", e.description);
        const isConflict = e.error_code === 409 || e.description.includes("terminated by other getUpdates request");
        if (isConflict && !this.stopped) {
          console.warn(`[Telegram] Polling conflict (assistant=${this.opts.assistantId}), scheduling reconnect`);
          this.scheduleReconnect();
        }
      } else if (e instanceof HttpError) {
        console.error("[Telegram] Network error:", e);
        if (!this.stopped) this.scheduleReconnect();
      } else {
        console.error("[Telegram] Unknown error:", e);
      }
    });
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    // Skip bot's own messages
    if (msg.from?.is_bot) return;

    const messageId = String(msg.message_id);
    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    // Deduplication
    const dedupKey = `tg:${this.opts.assistantId}:${chatId}:${messageId}`;
    if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) {
      return;
    }
    markProcessed(dedupKey);

    // Access control
    if (!isAllowed(ctx, this.opts)) return;

    // Auto-populate ownerUserIds on first private message
    if (!isGroup && !(this.opts.ownerUserIds?.length)) {
      const senderId = String(msg.from?.id ?? "");
      if (senderId) {
        const updated = patchAssistantBotOwnerIds(this.opts.assistantId, "telegram", senderId);
        if (updated) {
          this.opts.ownerUserIds = [senderId];
        }
      }
    }

    // Mention gating for groups
    if (isGroup && this.opts.requireMention !== false) {
      if (!isMentioned(ctx, this.botUsername)) {
        const replyToBot = msg.reply_to_message?.from?.username?.toLowerCase() === this.botUsername.toLowerCase();
        if (!replyToBot) return;
      }
    }

    // ── Media group aggregation ──────────────────────────────────────────────
    const mediaGroupId = (msg as any).media_group_id as string | undefined;
    if (mediaGroupId && (msg.photo || msg.video || msg.document)) {
      await this.bufferMediaGroupMessage(ctx, chatId, mediaGroupId);
      return;
    }

    // ── Single message processing ────────────────────────────────────────────
    this.inflight.add(dedupKey);
    try {
      await this.processSingleMessage(ctx, chatId);
    } finally {
      this.inflight.delete(dedupKey);
    }
  }

  // ── Media group buffering ──────────────────────────────────────────────────

  private async bufferMediaGroupMessage(ctx: Context, chatId: string, mediaGroupId: string): Promise<void> {
    const msg = ctx.message!;
    const groupKey = `${this.opts.assistantId}:${chatId}:${mediaGroupId}`;

    const filePath = await this.downloadMediaFromMessage(msg);

    await this.setReaction(chatId, msg.message_id, "👀");

    // Store the first ctx for replying later
    if (!this.mediaGroupCtxMap.has(groupKey)) {
      this.mediaGroupCtxMap.set(groupKey, ctx);
    }

    const count = this.mediaGroupBuffer.add(groupKey, chatId, {
      filePath,
      messageId: msg.message_id,
      caption: msg.caption ?? undefined,
    });

    console.log(`[Telegram] Media group ${mediaGroupId}: buffered ${count} file(s)`);
  }

  private async downloadMediaFromMessage(msg: NonNullable<Context["message"]>): Promise<string | null> {
    if (!this.bot) return null;
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      return downloadTelegramFile(this.bot, photo.file_id, this.effectiveProxyUrl);
    }
    if (msg.video) {
      return downloadTelegramFile(this.bot, msg.video.file_id, this.effectiveProxyUrl);
    }
    if (msg.document) {
      return downloadTelegramFile(this.bot, msg.document.file_id, this.effectiveProxyUrl, msg.document.file_name ?? undefined);
    }
    return null;
  }

  private async onMediaGroupFlushed(groupKey: string, result: FlushedMediaGroup): Promise<void> {
    const firstCtx = this.mediaGroupCtxMap.get(groupKey);
    this.mediaGroupCtxMap.delete(groupKey);
    if (!firstCtx) return;

    const { chatId, caption, filePaths, messageIds } = result;
    const validPaths = filePaths.filter(Boolean);
    const count = validPaths.length;

    const defaultText = count > 1 ? `用户发来了 ${count} 张图片` : "用户发来了一张图片";
    let fullText = caption || defaultText;

    if (validPaths.length > 0) {
      const pathsNote = validPaths.map((p: string) => `文件路径: ${p}`).join("\n");
      fullText = `${fullText}\n\n${pathsNote}\n⚠️ 这是${count > 1 ? `一组 ${count} 个` : "一个新"}文件，请直接读取上述路径的文件内容，不要参考任何历史对话中出现过的文件内容。`;
    }

    console.log(`[Telegram] Media group flushed: ${count} file(s), caption="${caption.slice(0, 60)}"`);

    const inflightKey = `tg-group:${groupKey}`;
    this.inflight.add(inflightKey);

    await firstCtx.replyWithChatAction("typing").catch((e) => console.warn("[Telegram] Failed to send typing action:", e));

    let ok = false;
    try {
      const skillContext = caption ? this.resolveSkillCommand(caption.trim()) : null;
      const finalText = skillContext?.userText
        ? `${skillContext.userText}\n\n${validPaths.map((p: string) => `文件路径: ${p}`).join("\n")}\n⚠️ 这是${count > 1 ? `一组 ${count} 个` : "一个新"}文件，请直接读取上述路径的文件内容，不要参考任何历史对话中出现过的文件内容。`
        : fullText;

      await this.generateAndDeliver(firstCtx, finalText, chatId, skillContext?.skillContent, validPaths.length > 0);
      ok = true;
    } finally {
      for (const msgId of messageIds) {
        await this.setReaction(chatId, msgId, ok ? "👍" : "😢");
      }
      this.inflight.delete(inflightKey);
    }
  }

  // ── Single (non-album) message processing ──────────────────────────────────

  private async processSingleMessage(ctx: Context, chatId: string): Promise<void> {
    // Extract content
    const extracted = await this.extractContent(ctx);
    if (!extracted.text) return;

    // Built-in commands
    const cmdText = extracted.text.trim();
    if (cmdText === "/start") {
      const msg = ctx.message!;
      const userId = msg.from?.id ?? "未知";
      const username = msg.from?.username ? `@${msg.from.username}` : "无";
      const skillNames = this.opts.skillNames ?? [];
      let skillLines = "";
      if (skillNames.length > 0) {
        const installed = loadInstalledSkills();
        const lines = skillNames.map((name) => {
          const info = installed.get(name);
          const cmd = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
          return `/${cmd} — ${info?.label ?? name}`;
        });
        skillLines = `\n\n<b>可用技能：</b>\n${lines.join("\n")}`;
      }
      await ctx.reply(
        `你好！我是 <b>${escapeHtml(this.opts.assistantName)}</b>，你的 AI 助手。\n\n` +
        `你的 Telegram ID: <code>${userId}</code>\n用户名: ${username}\n\n` +
        `直接发消息给我开始聊天吧！\n\n` +
        `<b>可用命令：</b>\n` +
        `/new — 重置对话\n` +
        `/myid — 查看你的 ID\n` +
        `/skills — 查看可用技能` +
        skillLines,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (cmdText === "/myid") {
      const msg = ctx.message!;
      const userId = msg.from?.id ?? "未知";
      const username = msg.from?.username ? `@${msg.from.username}` : "无";
      await ctx.reply(
        `你的 Telegram ID: <code>${userId}</code>\n用户名: ${username}\n群组 ID: <code>${chatId}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (cmdText === "/new" || cmdText === "/reset") {
      const historyKey = `${this.opts.assistantId}:${chatId}`;
      histories.delete(historyKey);
      botClaudeSessionIds.delete(historyKey);
      botSessionIds.delete(historyKey);
      await ctx.reply("对话已重置，开始新的对话吧！");
      return;
    }
    if (cmdText === "/skills") {
      const skillNames = this.opts.skillNames ?? [];
      if (skillNames.length === 0) {
        await ctx.reply("当前助手未配置任何技能。\n可在「助手管理」中添加技能。");
        return;
      }
      const installed = loadInstalledSkills();
      const lines = skillNames.map((name) => {
        const info = installed.get(name);
        const cmd = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const desc = info?.description ? ` — ${info.description.slice(0, 80)}` : "";
        return `/${cmd}  <b>${info?.label ?? name}</b>${desc}`;
      });
      await ctx.reply(
        `<b>可用技能（${skillNames.length}）：</b>\n\n${lines.join("\n\n")}\n\n` +
        `💡 直接发送 <code>/技能名 你的需求</code> 即可调用`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Skill command detection: /skillname [args]
    const skillContext = this.resolveSkillCommand(cmdText);

    // Append file paths with explicit read instruction
    let fullText = skillContext?.userText ?? extracted.text;
    if (extracted.filePaths?.length) {
      const pathsNote = extracted.filePaths.map((p: string) => `文件路径: ${p}`).join("\n");
      fullText = `${fullText}\n\n${pathsNote}\n⚠️ 这是一个新文件，请直接读取上述路径的文件内容，不要参考任何历史对话中出现过的文件内容。`;
    }

    const msg = ctx.message!;
    console.log(`[Telegram] Message from ${msg.from?.username ?? msg.from?.id}: ${fullText.slice(0, 100)}`);

    const userMsgId = msg.message_id;

    // Ack reaction + typing indicator
    await this.setReaction(chatId, userMsgId, "👀");
    await ctx.replyWithChatAction("typing").catch((e) => console.warn("[Telegram] Failed to send typing action:", e));

    // Generate and deliver reply
    const hasFiles = (extracted.filePaths?.length ?? 0) > 0;
    let ok = false;
    try {
      await this.generateAndDeliver(ctx, fullText, chatId, skillContext?.skillContent, hasFiles);
      ok = true;
    } finally {
      await this.setReaction(chatId, userMsgId, ok ? "👍" : "😢");
    }
  }

  // ── Content extraction ──────────────────────────────────────────────────────

  private async extractContent(ctx: Context): Promise<{ text: string; filePaths?: string[] }> {
    const msg = ctx.message;
    if (!msg) return { text: "" };

    // Text message
    if (msg.text) {
      let text = msg.text;
      // Strip @bot mention
      if (this.botUsername) {
        text = text.replace(new RegExp(`@${this.botUsername}\\s*`, "gi"), "").trim();
      }
      return { text: text || "[空消息]" };
    }

    // Photo
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const tmpPath = this.bot ? await downloadTelegramFile(this.bot, photo.file_id, this.effectiveProxyUrl) : null;
      const caption = msg.caption ?? "";
      if (tmpPath) {
        return { text: caption || "用户发来了一张图片", filePaths: [tmpPath] };
      }
      return { text: caption || "[图片消息]" };
    }

    // Voice / Audio
    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (fileId && this.bot) {
        const tmpPath = await downloadTelegramFile(this.bot, fileId, this.effectiveProxyUrl);
        if (tmpPath) {
          return { text: "用户发来了一条语音消息", filePaths: [tmpPath] };
        }
      }
      return { text: "[语音消息]" };
    }

    // Document
    if (msg.document) {
      const fileName = msg.document.file_name ?? "未知文件";
      if (this.bot) {
        const tmpPath = await downloadTelegramFile(this.bot, msg.document.file_id, this.effectiveProxyUrl, fileName);
        if (tmpPath) {
          const caption = msg.caption ? `${msg.caption}\n\n` : "";
          return { text: `${caption}用户发来了一个文件：${fileName}`, filePaths: [tmpPath] };
        }
      }
      return { text: `[文件: ${fileName}]` };
    }

    // Video
    if (msg.video) {
      if (this.bot) {
        const tmpPath = await downloadTelegramFile(this.bot, msg.video.file_id, this.effectiveProxyUrl);
        if (tmpPath) {
          return { text: msg.caption || "用户发来了一段视频", filePaths: [tmpPath] };
        }
      }
      return { text: "[视频消息]" };
    }

    // Sticker
    if (msg.sticker) {
      return { text: `[表情: ${msg.sticker.emoji ?? "🤔"}]` };
    }

    // Location
    if (msg.location) {
      return { text: `[位置: ${msg.location.latitude}, ${msg.location.longitude}]` };
    }

    // Caption fallback (for media with captions)
    if (msg.caption) {
      return { text: msg.caption };
    }

    return { text: "" };
  }

  // ── Skill command resolution ────────────────────────────────────────────────

  private resolveSkillCommand(text: string): { skillContent: string; userText: string } | null {
    const resolved = resolveSkillCommand(text, this.opts.skillNames);
    if (!resolved) return null;
    console.log(
      `[Telegram] Skill command activated: ${resolved.skillName} (${resolved.skillContent.length} chars)`,
    );
    return {
      skillContent: resolved.skillContent,
      userText: resolved.userText,
    };
  }

  // ── Generate reply and deliver ──────────────────────────────────────────────

  private async generateAndDeliver(
    ctx: Context,
    userText: string,
    chatId: string,
    skillContent?: string,
    hasFiles?: boolean,
  ): Promise<void> {
    const historyKey = `${this.opts.assistantId}:${chatId}`;
    const history = getHistory(historyKey);
    const provider = this.opts.provider ?? "claude";

    const sessionId = getBotSession(
      this.opts.assistantId,
      chatId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
      this.opts.skillNames,
    );

    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userText });

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = await buildSmartMemoryContext(userText, this.opts.assistantId, this.opts.defaultCwd);

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowStr = new Date().toLocaleString("zh-CN", { timeZone: tz, hour12: false });
    const currentTimeContext = `## 当前时间\n消息发送时间：${nowStr}（时区：${tz}）`;

    const skillSection = buildActivatedSkillSection(skillContent);

    // File/image messages must run in an isolated context to avoid mixing
    // previous analyses into the current file response.
    const historySection = (!hasFiles && history.length > 1)
      ? buildHistoryContext(history.slice(0, -1), this.opts.assistantId)
      : undefined;

    const system = buildStructuredPersona(this.opts, currentTimeContext, memoryContext, skillSection, historySection);

    // Set thinking reaction
    await this.setReaction(chatId, ctx.message!.message_id, "🤔");

    let result: StreamResult;

    try {
      result = await this.runClaudeQuery(system, userText, ctx, chatId, provider, sessionId, hasFiles);
    } catch (err) {
      console.error("[Telegram] AI error:", err);
      result = { text: "抱歉，处理您的消息时遇到了问题，请稍后再试。", draftMessageId: null };
    }

    const replyText = result.text;
    history.push({ role: "assistant", content: replyText });
    recordConversation(
      `\n## ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${userText}\n**${this.opts.assistantName}**: ${replyText}\n`,
      { assistantId: this.opts.assistantId, assistantName: this.opts.assistantName, channel: "Telegram" },
    );
    updateBotSessionTitle(sessionId, history, "[Telegram]").catch((e) => console.warn("[Telegram] Failed to update session title:", e));

    // Finalize: deliver the response
    await this.finalizeResponse(ctx, chatId, replyText, result.draftMessageId);
  }

  /** Edit the draft or send chunked final response */
  private async finalizeResponse(
    ctx: Context,
    chatId: string,
    replyText: string,
    draftMessageId: number | null,
  ): Promise<void> {
    const chatIdNum = Number(chatId);

    // Check if the reply contains any local-path images; if so use segment-based sending.
    const segments = parseReplySegments(replyText);
    const hasImages = segments.some((s) => s.kind === "image");

    if (hasImages) {
      // Delete streaming draft before segment-based multi-message send.
      if (draftMessageId) {
        try {
          await this.bot?.api.deleteMessage(chatIdNum, draftMessageId);
        } catch (e) {
          console.warn("[Telegram] Failed to delete draft message:", e);
        }
      }

      const { InputFile } = await import("grammy");
      const { readFileSync } = await import("fs");
      const { basename } = await import("path");

      for (const seg of segments) {
        if (seg.kind === "text") {
          const textContent = seg.content.trim();
          if (!textContent) continue;
          for (const chunk of chunkMessage(textContent)) {
            try {
              await ctx.reply(markdownToTelegramHtml(chunk), {
                parse_mode: "HTML",
                reply_to_message_id: ctx.message?.message_id,
              });
            } catch {
              try {
                await ctx.reply(chunk, { reply_to_message_id: ctx.message?.message_id });
              } catch (err2) {
                console.error("[Telegram] Text segment reply failed:", err2);
              }
            }
          }
        } else {
          // Image segment — send as photo
          try {
            const fileBuffer = readFileSync(seg.path);
            const fileName = basename(seg.path);
            const inputFile = new InputFile(fileBuffer, fileName);
            await ctx.replyWithPhoto(inputFile, {
              caption: seg.alt || undefined,
              reply_to_message_id: ctx.message?.message_id,
            });
          } catch (err) {
            console.error("[Telegram] Photo send failed:", err);
            // Fallback: mention the path in text
            try {
              await ctx.reply(`[图片: ${seg.path}]`, { reply_to_message_id: ctx.message?.message_id });
            } catch { /* ignore */ }
          }
        }
      }
      return;
    }

    // No images — original chunked send logic.
    const chunks = chunkMessage(replyText);

    if (draftMessageId && chunks.length === 1) {
      // Single chunk — edit the streaming draft to its final version
      const html = markdownToTelegramHtml(chunks[0]);
      try {
        await this.bot!.api.editMessageText(chatIdNum, draftMessageId, html, { parse_mode: "HTML" });
        return;
      } catch {
        try {
          await this.bot!.api.editMessageText(chatIdNum, draftMessageId, chunks[0]);
          return;
        } catch { /* fall through to chunked send */ }
      }
    }

    // Delete the streaming draft — we'll send properly chunked messages
    if (draftMessageId) {
      try {
        await this.bot?.api.deleteMessage(chatIdNum, draftMessageId);
      } catch (e) {
        console.warn("[Telegram] Failed to delete draft message:", e);
      }
    }

    for (const chunk of chunks) {
      try {
        await ctx.reply(markdownToTelegramHtml(chunk), {
          parse_mode: "HTML",
          reply_to_message_id: ctx.message?.message_id,
        });
      } catch {
        try {
          await ctx.reply(chunk, { reply_to_message_id: ctx.message?.message_id });
        } catch (err2) {
          console.error("[Telegram] Reply failed:", err2);
        }
      }
    }
  }

  /** Send a new streaming draft or edit the existing one */
  private async upsertDraft(
    ctx: Context,
    text: string,
    draftMessageId: number | null,
  ): Promise<number | null> {
    const preview = text.length > TG_MESSAGE_LIMIT - 20
      ? text.slice(0, TG_MESSAGE_LIMIT - 20) + DRAFT_SUFFIX
      : text + DRAFT_SUFFIX;

    if (!draftMessageId) {
      try {
        const sent = await ctx.reply(markdownToTelegramHtml(preview), {
          parse_mode: "HTML",
          reply_to_message_id: ctx.message?.message_id,
        });
        return sent.message_id;
      } catch {
        try {
          const sent = await ctx.reply(preview, { reply_to_message_id: ctx.message?.message_id });
          return sent.message_id;
        } catch { return null; }
      }
    }

    // Edit existing draft
    const chatId = Number(ctx.chat!.id);
    try {
      await this.bot!.api.editMessageText(chatId, draftMessageId, markdownToTelegramHtml(preview), {
        parse_mode: "HTML",
      });
    } catch {
      try {
        await this.bot!.api.editMessageText(chatId, draftMessageId, preview);
      } catch { /* MESSAGE_NOT_MODIFIED or other — ignore */ }
    }
    return draftMessageId;
  }

  /** Claude query() path via Agent SDK with shared MCP + per-session MCP + streaming preview */
  private async runClaudeQuery(
    system: string,
    userText: string,
    ctx: Context,
    chatId: string,
    provider: "claude" | "openai",
    sessionId: string,
    hasFiles?: boolean,
  ): Promise<StreamResult> {
    const sessionKey = `${this.opts.assistantId}:${chatId}`;
    const sessionMcp = this.createSessionMcp(ctx);
    const sharedMcp = createSharedMcpServer({ assistantId: this.opts.assistantId, sessionCwd: this.opts.defaultCwd });
    const claudeSessionId = hasFiles ? undefined : getBotClaudeSessionId(sessionKey);
    const claudeCodePath = getClaudeCodePath();

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch((e) => console.warn("[Telegram] Failed to send typing action:", e));
    }, 4000);

    let finalText = "";
    let accumulatedText = "";
    let draftMessageId: number | null = null;
    let lastEditTime = 0;
    let bufferedAssistant: StreamMessage | null = null;
    const assistantConfig = loadAssistantsConfig().assistants.find(a => a.id === this.opts.assistantId);
    const persistStreamMessage = (streamMessage: StreamMessage) => sessionStore?.recordMessage(sessionId, streamMessage);

    try {
      const q = await runAgent(userText, {
        systemPrompt: system,
        resume: claudeSessionId,
        cwd: this.opts.defaultCwd ?? homedir(),
        mcpServers: { "vk-shared": sharedMcp, "tg-session": sessionMcp, ...loadMcporterServers() },
        pathToClaudeCodeExecutable: claudeCodePath,
        provider,
        ...(provider === "claude" && { env: buildQueryEnv(assistantConfig) }),
        ...(provider === "openai" && { openaiOverrides: buildOpenAIOverrides(assistantConfig, this.opts.model) }),
      });

      for await (const message of q) {
        bufferedAssistant = bufferPersistedBotMessage(
          message as StreamMessage,
          bufferedAssistant,
          persistStreamMessage,
        );
        const msg = message as Record<string, unknown>;
        if (msg.type === "result" && msg.subtype === "success") {
          finalText = msg.result as string;
          setBotClaudeSessionId(sessionKey, msg.session_id as string);
          continue;
        }

        const partial = extractPartialText(msg);
        if (partial && partial.length > accumulatedText.length) {
          accumulatedText = partial;
          const now = Date.now();
          if (now - lastEditTime >= DRAFT_THROTTLE_MS) {
            draftMessageId = await this.upsertDraft(ctx, accumulatedText, draftMessageId);
            lastEditTime = now;
          }
        }
      }

      flushBufferedBotAssistantMessage(bufferedAssistant, persistStreamMessage);
    } finally {
      clearInterval(typingInterval);
    }

    return {
      text: finalText || accumulatedText || "抱歉，无法生成回复。",
      draftMessageId,
    };
  }

  /** Per-session MCP server with send_message + send_file tools */
  private createSessionMcp(ctx: Context) {
    const self = this;

    const sendMessageTool = tool(
      "send_message",
      "向当前 Telegram 对话立即发送一条消息。适合在执行长任务时告知用户进度。",
      { text: z.string().describe("要发送的消息内容（支持 Markdown）") },
      async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return { content: [{ type: "text" as const, text: "消息内容为空" }] };
        const chunks = chunkMessage(text);
        for (const chunk of chunks) {
          try {
            await ctx.reply(markdownToTelegramHtml(chunk), { parse_mode: "HTML" });
          } catch {
            try {
              await ctx.reply(chunk);
            } catch (e) {
              console.warn("[Telegram] Failed to send message:", e);
            }
          }
        }
        return { content: [{ type: "text" as const, text: "消息已发送" }] };
      },
    );

    const sendFileTool = tool(
      "send_file",
      "通过 Telegram 将本地文件直接发送给当前对话的用户。支持所有文件类型：图片（jpg/png）、音频（mp3/m4a/wav/aac）、视频（mp4/mov）、文档（pdf/xlsx/docx）、压缩包等。生成任何文件后必须立即调用此工具发送，不要通过其他渠道发送。",
      { file_path: z.string().describe("要发送的文件的完整本地路径，例如 /tmp/voice.m4a") },
      async (input) => {
        const result = await self.doSendFile(String(input.file_path ?? ""), ctx);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    return createSdkMcpServer({ name: "telegram-session", tools: [sendMessageTool, sendFileTool] });
  }

  /** Send a file to the current chat */
  private async doSendFile(filePath: string, ctx: Context): Promise<string> {
    const fs = await import("fs");
    const path = await import("path");

    if (!filePath || !fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const fileName = path.basename(filePath);

    const isImage = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext);
    const isAudio = ["mp3", "m4a", "aac", "flac", "wav", "wma", "ogg"].includes(ext);
    const isVoice = ext === "oga";
    const isVideo = ["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv"].includes(ext);

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const { InputFile } = await import("grammy");
      const inputFile = new InputFile(fileBuffer, fileName);

      if (isImage) {
        await ctx.replyWithPhoto(inputFile);
      } else if (isVoice) {
        await ctx.replyWithVoice(inputFile);
      } else if (isAudio) {
        await ctx.replyWithAudio(inputFile);
      } else if (isVideo) {
        await ctx.replyWithVideo(inputFile);
      } else {
        // PDF, Excel, Word, zip, txt, etc.
        await ctx.replyWithDocument(inputFile);
      }
      return `文件已发送: ${fileName}`;
    } catch (err) {
      return `发送失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

}
