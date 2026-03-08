/**
 * Feishu (Lark) Bot Service
 *
 * Features:
 * - WebSocket (long-polling) and Webhook connection modes
 * - Inbound media: downloads images/files and passes them to AI as base64/text
 * - Rich-text (post) with embedded images
 * - Quoted/replied message context
 * - Group events: bot-added / bot-removed
 * - Group policy: requireMention, dmPolicy, groupPolicy with allowlist/pairing
 * - Pairing approval flow for DM access control
 * - Outbound: card rendering (Markdown→interactive card), typing indicator (emoji reaction), @-forwarding
 * - Permission error auto-notification
 * - Feishu ecosystem MCP tools: doc, wiki, drive, bitable, task, chat, urgent
 * - Webhook mode with encryptKey / verificationToken support
 * - Custom domain for private deployments
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { runAgent } from "./agent-client.js";
import { z } from "zod";
import { EventEmitter } from "events";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { loadUserSettings } from "./user-settings.js";
import { buildSmartMemoryContext, recordConversation } from "./memory-store.js";
import { getClaudeCodePath } from "./util.js";
import type { SessionStore } from "./session-store.js";
import { createSharedMcpServer } from "./shared-mcp.js";
import {
  type ConvMessage,
  buildOpenAIOverrides,
  buildQueryEnv,
  buildStructuredPersona,
  buildHistoryContext,
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
  parseReplySegments,
} from "./bot-base.js";
import { loadAssistantsConfig, patchAssistantBotOwnerIds } from "./assistants-config.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FeishuBotStatus = "disconnected" | "connecting" | "connected" | "error";

/** DM access policy */
export type FeishuDmPolicy = "open" | "allowlist" | "pairing";
/** Group access policy */
export type FeishuGroupPolicy = "open" | "allowlist" | "disabled";
/** Card render mode */
export type FeishuRenderMode = "auto" | "raw" | "card";

export interface FeishuBotOptions {
  appId: string;
  appSecret: string;
  /** "feishu" (default), "lark", or custom base URL for private deployment */
  domain?: "feishu" | "lark" | string;
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
  /** Max reconnect attempts (default: 10) */
  maxConnectionAttempts?: number;
  /** Connection mode: "websocket" (default) or "webhook" */
  connectionMode?: "websocket" | "webhook";
  /** Webhook server port (default: 3000) */
  webhookPort?: number;
  /** Webhook event path (default: "/feishu/events") */
  webhookPath?: string;
  /** Webhook encrypt key */
  encryptKey?: string;
  /** Webhook verification token */
  verificationToken?: string;
  /** DM access policy (default: "open") */
  dmPolicy?: FeishuDmPolicy;
  /** Allowlisted user open_ids (for dmPolicy="allowlist"/"pairing") */
  allowFrom?: string[];
  /** Group access policy (default: "open") */
  groupPolicy?: FeishuGroupPolicy;
  /** Require @mention in groups (default: true) */
  requireMention?: boolean;
  /** Reply render mode (default: "auto") */
  renderMode?: FeishuRenderMode;
  /** Owner open_ids for proactive messaging */
  ownerOpenIds?: string[];
}

// ─── Pairing store ─────────────────────────────────────────────────────────────

/** In-memory pairing codes: code → openId */
const pairingCodes = new Map<string, { openId: string; assistantId: string; ts: number }>();
/** Approved DM users per assistant */
const approvedUsers = new Map<string, Set<string>>(); // assistantId → Set<openId>

function generatePairingCode(): string {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function isUserApproved(assistantId: string, openId: string, opts: FeishuBotOptions): boolean {
  const policy = opts.dmPolicy ?? "open";
  if (policy === "open") return true;
  const from = opts.allowFrom ?? [];
  if (from.includes("*") || from.includes(openId)) return true;
  if (policy === "allowlist") return false;
  // pairing
  return approvedUsers.get(assistantId)?.has(openId) ?? false;
}

/** Approve a pairing code and add the user to the approved set. Returns open_id or null. */
export function approvePairingCode(code: string): string | null {
  const entry = pairingCodes.get(code);
  if (!entry) return null;
  if (Date.now() - entry.ts > 10 * 60 * 1000) {
    pairingCodes.delete(code);
    return null;
  }
  let approved = approvedUsers.get(entry.assistantId);
  if (!approved) { approved = new Set(); approvedUsers.set(entry.assistantId, approved); }
  approved.add(entry.openId);
  pairingCodes.delete(code);
  return entry.openId;
}

// ─── Message deduplication ─────────────────────────────────────────────────────

const processedMsgs = new Map<string, number>();

function isDuplicate(key: string): boolean { return isDuplicateMsg(key, processedMsgs); }
function markProcessed(key: string): void { markProcessedMsg(key, processedMsgs); }

// ─── Status emitter ────────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onFeishuBotStatusChange(
  cb: (assistantId: string, status: FeishuBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emit(assistantId: string, status: FeishuBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Injected session store ────────────────────────────────────────────────────

let sessionStore: SessionStore | null = null;

export function setFeishuSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Connection pool ───────────────────────────────────────────────────────────

const pool = new Map<string, FeishuConnection>();

export async function startFeishuBot(opts: FeishuBotOptions): Promise<void> {
  stopFeishuBot(opts.assistantId);
  const conn = new FeishuConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start();
}

export function stopFeishuBot(assistantId: string): void {
  const conn = pool.get(assistantId);
  if (conn) {
    conn.stop();
    pool.delete(assistantId);
  }
  const keysToClean = Array.from(histories.keys()).filter(k => k.startsWith(assistantId));
  for (const key of keysToClean) {
    histories.delete(key);
    botSessionIds.delete(key);
  }
  emit(assistantId, "disconnected");
}

export function updateFeishuBotConfig(
  assistantId: string,
  updates: Partial<Pick<FeishuBotOptions,
    "provider" | "model" | "persona" | "coreValues" | "relationship" |
    "cognitiveStyle" | "operatingGuidelines" | "userContext" | "assistantName" | "defaultCwd"
  >>,
): void {
  const conn = pool.get(assistantId);
  if (!conn) return;
  Object.assign(conn["opts"], updates);
  console.log(`[Feishu] Config updated for assistant=${assistantId}:`, Object.keys(updates));
}

export function getFeishuBotStatus(assistantId: string): FeishuBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

export function getAnyConnectedFeishuAssistantId(): string | null {
  for (const [id, conn] of pool.entries()) {
    if (conn.status === "connected") return id;
  }
  return null;
}

// ─── Proactive messaging ───────────────────────────────────────────────────────

const lastSeenChatIds = new Map<string, string>(); // assistantId → chatId

function recordLastSeenChat(assistantId: string, chatId: string): void {
  if (chatId) lastSeenChatIds.set(assistantId, chatId);
}

export async function sendProactiveFeishuMessage(
  assistantId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) return { ok: false, error: `飞书 Bot (${assistantId}) 未连接` };
  const chatId = lastSeenChatIds.get(assistantId);
  if (!chatId) return { ok: false, error: "飞书无活跃会话（尚未收到任何消息）" };
  return conn.sendProactive(chatId, text);
}

// ─── Conversation history & session management ─────────────────────────────────

const histories = new Map<string, ConvMessage[]>();
const MAX_TURNS = 10;
const botSessionIds = new Map<string, string>();
const titledSessions = new Set<string>();

function getHistory(key: string): ConvMessage[] {
  if (!histories.has(key)) histories.set(key, []);
  return histories.get(key)!;
}

function getBotSession(
  assistantId: string,
  assistantName: string,
  provider: "claude" | "openai",
  model: string | undefined,
  cwd: string | undefined,
  sessionKey?: string,
): string {
  if (!sessionStore) throw new Error("[Feishu] SessionStore not injected");
  const key = sessionKey ?? assistantId;
  const existingId = botSessionIds.get(key);
  if (existingId && sessionStore.getSession(existingId)) return existingId;
  const session = sessionStore.createSession({
    title: `[飞书] ${assistantName}`,
    assistantId,
    provider,
    model,
    cwd,
  });
  botSessionIds.set(key, session.id);
  return session.id;
}

async function updateBotSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
  if (titledSessions.has(sessionId)) return;
  titledSessions.add(sessionId);
  const fallback = firstMessage.slice(0, 40).trim() + (firstMessage.length > 40 ? "…" : "");
  let title = fallback;
  try {
    const { generateSessionTitle } = await import("../api/services/runner.js");
    const generated = await generateSessionTitle(
      `请根据以下对话内容，生成一个简短的中文标题（10字以内，不加引号），直接输出标题：\n${firstMessage}`,
    );
    if (generated && generated !== "New Session") title = generated;
  } catch {
    // keep fallback
  }
  sessionStore?.updateSession(sessionId, { title: `[飞书] ${title}` });
}

// ─── Claude session ID registry ───────────────────────────────────────────────

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

// ─── Feishu domain helper ─────────────────────────────────────────────────────

function resolveDomain(domain?: string): lark.Domain | string {
  if (!domain || domain === "feishu") return lark.Domain.Feishu;
  if (domain === "lark") return lark.Domain.Lark;
  return domain; // custom URL
}

// ─── Markdown to Feishu card ──────────────────────────────────────────────────

function buildCardContent(markdown: string): string {
  return JSON.stringify({
    schema: "2.0",
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdown,
          text_align: "left",
        },
      ],
    },
    // No header — cleaner look for chat replies
  });
}

function shouldUseCard(text: string, renderMode: FeishuRenderMode): boolean {
  if (renderMode === "card") return true;
  if (renderMode === "raw") return false;
  // auto: use card whenever markdown formatting is detected
  return /```|^\|.*\||\*\*|^#{1,6}\s|^[-*+]\s|^\d+\.\s/m.test(text);
}

// ─── Media download helper ────────────────────────────────────────────────────

async function downloadMedia(
  client: InstanceType<typeof lark.Client>,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
): Promise<Buffer | null> {
  try {
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    if (!resp) return null;
    // resp is a readable stream or buffer depending on SDK version
    if (Buffer.isBuffer(resp)) return resp;
    if (resp && typeof (resp as any).pipe === "function") {
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        (resp as any).on("data", (c: Buffer) => chunks.push(c));
        (resp as any).on("end", () => resolve(Buffer.concat(chunks)));
        (resp as any).on("error", reject);
      });
    }
    return null;
  } catch (err) {
    console.error("[Feishu] Media download error:", err);
    return null;
  }
}

// ─── FeishuConnection ──────────────────────────────────────────────────────────

class FeishuConnection {
  status: FeishuBotStatus = "disconnected";
  private wsClient: InstanceType<typeof lark.WSClient> | null = null;
  private webhookServer: import("http").Server | null = null;
  readonly feishuClient: InstanceType<typeof lark.Client>;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Set<string>();

  constructor(private opts: FeishuBotOptions) {
    const domain = resolveDomain(opts.domain);
    this.feishuClient = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: domain as lark.Domain,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.status = "connecting";
    emit(this.opts.assistantId, "connecting");

    try {
      if (this.opts.connectionMode === "webhook") {
        await this.startWebhook();
      } else {
        await this.connectWebSocket();
      }
    } catch (err) {
      this.stopped = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      pool.delete(this.opts.assistantId);
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.wsClient?.close(); } catch { /* ignore */ }
    this.wsClient = null;
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
    this.status = "disconnected";
  }

  // ── WebSocket mode ────────────────────────────────────────────────────────────

  private buildDispatcher(): InstanceType<typeof lark.EventDispatcher> {
    return new lark.EventDispatcher({
      encryptKey: this.opts.encryptKey ?? "",
    }).register({
      "im.message.receive_v1": async (data: Record<string, unknown>) => {
        try { await this.handleMessage(data); } catch (err) {
          console.error("[Feishu] Message handling error:", err);
        }
      },
      "im.message.message_read_v1": async (data: Record<string, unknown>) => {
        console.log(`[Feishu] Message read event: assistant=${this.opts.assistantId}`, data);
      },
      "im.chat.member.bot.added_v1": async (data: Record<string, unknown>) => {
        const chatId = (data as any).chat_id ?? "";
        console.log(`[Feishu] Bot added to chat: ${chatId}, assistant=${this.opts.assistantId}`);
        recordLastSeenChat(this.opts.assistantId, String(chatId));
      },
      "im.chat.member.bot.deleted_v1": async (data: Record<string, unknown>) => {
        const chatId = (data as any).chat_id ?? "";
        console.log(`[Feishu] Bot removed from chat: ${chatId}, assistant=${this.opts.assistantId}`);
      },
    });
  }

  private async connectWebSocket(): Promise<void> {
    const domain = resolveDomain(this.opts.domain);
    const dispatcher = this.buildDispatcher();

    const wsClient = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: domain as lark.Domain,
      loggerLevel: lark.LoggerLevel.warn,
    });
    this.wsClient = wsClient;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const connectTimeout = setTimeout(() => {
        if (this.status === "connecting") {
          this.status = "connected";
          emit(this.opts.assistantId, "connected");
          this.reconnectAttempts = 0;
          console.log(`[Feishu] Connected (WebSocket): assistant=${this.opts.assistantId}`);
          settle();
        }
      }, 10_000);

      wsClient.start({ eventDispatcher: dispatcher }).then(() => {
        clearTimeout(connectTimeout);
        if (!this.stopped) {
          this.status = "connected";
          emit(this.opts.assistantId, "connected");
          this.reconnectAttempts = 0;
          console.log(`[Feishu] Connected (WebSocket): assistant=${this.opts.assistantId}`);
          settle();
        }
      }).catch((err: Error) => {
        clearTimeout(connectTimeout);
        console.error("[Feishu] WSClient.start() failed:", err.message);
        this.status = "error";
        emit(this.opts.assistantId, "error", err.message);
        if (!this.stopped) settle(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const maxAttempts = this.opts.maxConnectionAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.status = "error";
      emit(this.opts.assistantId, "error", `已达最大重连次数 (${maxAttempts})，请手动重新连接`);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts++;
    console.log(`[Feishu] Reconnect attempt ${this.reconnectAttempts}/${maxAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket().catch((err) => {
        console.error("[Feishu] Reconnect failed:", err.message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Webhook mode ──────────────────────────────────────────────────────────────

  private async startWebhook(): Promise<void> {
    const http = await import("http");
    const port = this.opts.webhookPort ?? 3000;
    const path = this.opts.webhookPath ?? "/feishu/events";

    return new Promise<void>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== path) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            // Challenge verification
            if (body.challenge) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ challenge: body.challenge }));
              return;
            }
            res.writeHead(200);
            res.end("ok");
            // Handle event
            const event = body.event ?? {};
            const header = body.header ?? {};
            const eventType: string = header.event_type ?? body.type ?? "";
            if (eventType === "im.message.receive_v1") {
              await this.handleMessage(event).catch((e) =>
                console.error("[Feishu/Webhook] Message error:", e));
            }
          } catch (err) {
            console.error("[Feishu/Webhook] Parse error:", err);
            res.writeHead(400);
            res.end("Bad request");
          }
        });
      });

      server.listen(port, () => {
        this.webhookServer = server;
        this.status = "connected";
        emit(this.opts.assistantId, "connected");
        console.log(`[Feishu] Connected (Webhook) on port ${port}${path}: assistant=${this.opts.assistantId}`);
        resolve();
      });

      server.on("error", (err) => {
        console.error("[Feishu/Webhook] Server error:", err);
        this.status = "error";
        emit(this.opts.assistantId, "error", err.message);
        reject(err);
      });
    });
  }

  // ── Message handling ──────────────────────────────────────────────────────────

  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    const message = data.message as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;
    if (!message || !sender) return;

    const messageId = String(message.message_id ?? "");
    const msgType = String(message.message_type ?? "text");
    const chatId = String(message.chat_id ?? "");
    const chatType = String(message.chat_type ?? "p2p"); // "p2p" or "group"
    const senderId = String((sender.sender_id as Record<string, unknown>)?.open_id ?? "");

    // Skip bot's own messages
    if (String(sender.sender_type ?? "") === "app") return;

    recordLastSeenChat(this.opts.assistantId, chatId);

    // ── Access control ─────────────────────────────────────────────────────────
    if (chatType === "p2p") {
      const policy = this.opts.dmPolicy ?? "open";
      if (policy !== "open") {
        if (!isUserApproved(this.opts.assistantId, senderId, this.opts)) {
          if (policy === "pairing") {
            const code = generatePairingCode();
            pairingCodes.set(code, { openId: senderId, assistantId: this.opts.assistantId, ts: Date.now() });
            await this.sendReply(messageId, chatId, `您好！请将以下配对码告知管理员以获得访问权限：\`${code}\``);
          }
          return;
        }
      }

      // Auto-populate ownerOpenIds on first private message
      if (!(this.opts.ownerOpenIds?.length) && senderId) {
        const updated = patchAssistantBotOwnerIds(this.opts.assistantId, "feishu", senderId);
        if (updated) {
          this.opts.ownerOpenIds = [senderId];
        }
      }
    } else if (chatType === "group") {
      const gp = this.opts.groupPolicy ?? "open";
      if (gp === "disabled") return;
      if (gp === "allowlist") {
        const from = this.opts.allowFrom ?? [];
        if (!from.includes("*") && !from.includes(chatId) && !from.includes(senderId)) return;
      }
    }

    // ── Group @mention filter ──────────────────────────────────────────────────
    const requireMention = this.opts.requireMention ?? (chatType === "group");
    if (chatType === "group" && requireMention) {
      const mentions = (message.mentions as Array<{ key: string; id: Record<string, string> }> | undefined) ?? [];
      const hasBotMention = mentions.some((m) => m.id?.open_id === this.opts.appId || m.key === "@_user_1");
      if (!hasBotMention) return;
    }

    // ── Deduplication ──────────────────────────────────────────────────────────
    const dedupKey = messageId ? `feishu:${this.opts.assistantId}:${messageId}` : null;
    if (dedupKey) {
      if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) {
        console.log(`[Feishu][${this.opts.assistantName}] Dup/in-flight skip: ${messageId}`);
        return;
      }
      markProcessed(dedupKey);
      this.inflight.add(dedupKey);
    }

    try {
      // ── Extract mentions to forward ────────────────────────────────────────
      const mentions = (message.mentions as Array<{ key: string; id: Record<string, string>; name?: string }> | undefined) ?? [];
      const forwardMentions = mentions.filter((m) => m.id?.open_id && m.id.open_id !== this.opts.appId);

      // ── Extract text + media ───────────────────────────────────────────────
      const extracted = await this.extractContent(message, msgType, messageId);
      if (!extracted) return;

      const { text, mediaInfo } = extracted;
      console.log(`[Feishu] Message (${msgType}): ${text.slice(0, 100)}`);

      // ── Quoted/reply context ───────────────────────────────────────────────
      const quoteContext = await this.extractQuoteContext(message);

      const finalText = quoteContext
        ? `[引用消息]\n${quoteContext}\n---\n${text}`
        : text;

      // ── Session key for per-user isolation in groups ───────────────────────
      const sessionKey = `${this.opts.assistantId}:${chatType === "group" ? chatId : senderId}`;

      await this.generateAndDeliver(finalText, senderId, chatId, messageId, sessionKey, mediaInfo, forwardMentions);
    } finally {
      if (dedupKey) this.inflight.delete(dedupKey);
    }
  }

  // ── Content extraction (text + media) ────────────────────────────────────────

  private async extractContent(
    message: Record<string, unknown>,
    msgType: string,
    messageId: string,
  ): Promise<{ text: string; mediaInfo?: { type: "image" | "file"; base64?: string; mimeType?: string; fileName?: string; text?: string } } | null> {
    try {
      const contentRaw = String(message.content ?? "{}");
      const content = JSON.parse(contentRaw) as Record<string, unknown>;

      if (msgType === "text") {
        const text = String(content.text ?? "").trim().replace(/@[^\s]+\s*/g, "").trim();
        return text ? { text } : null;
      }

      if (msgType === "post") {
        const parts: string[] = [];
        const imageKeys: string[] = [];
        const postContent = content as { content?: Array<Array<{ tag?: string; text?: string; image_key?: string; href?: { url?: { link?: string } }; file_key?: string }>> };
        for (const line of postContent.content ?? []) {
          for (const node of line) {
            if (node.tag === "text" && node.text) {
              parts.push(node.text.replace(/@[^\s]+\s*/g, "").trim());
            } else if (node.tag === "a" && node.href?.url?.link) {
              parts.push(`[链接: ${node.href.url.link}]`);
            } else if (node.tag === "img" && node.image_key) {
              imageKeys.push(node.image_key);
            }
          }
        }
        const textPart = parts.join("").trim() || "[富文本消息]";
        // Download first embedded image if present
        if (imageKeys.length > 0) {
          const buf = await downloadMedia(this.feishuClient, messageId, imageKeys[0], "image");
          if (buf) {
            const base64 = buf.toString("base64");
            return { text: textPart + (imageKeys.length > 1 ? `（含 ${imageKeys.length} 张图片，显示第1张）` : ""), mediaInfo: { type: "image", base64, mimeType: "image/jpeg" } };
          }
        }
        return { text: textPart };
      }

      if (msgType === "image") {
        const imageKey = String(content.image_key ?? "");
        if (imageKey) {
          const buf = await downloadMedia(this.feishuClient, messageId, imageKey, "image");
          if (buf) {
            return { text: "[图片消息]", mediaInfo: { type: "image", base64: buf.toString("base64"), mimeType: "image/jpeg" } };
          }
        }
        return { text: "[图片消息]" };
      }

      if (msgType === "file") {
        const fileKey = String(content.file_key ?? "");
        const fileName = String(content.file_name ?? "未知文件");
        if (fileKey) {
          const buf = await downloadMedia(this.feishuClient, messageId, fileKey, "file");
          if (buf) {
            // For text-like files, try to decode; for others, just pass filename
            const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
            const textExts = ["txt", "md", "json", "csv", "log", "yaml", "yml", "xml", "html", "js", "ts", "py"];
            if (textExts.includes(ext)) {
              const fileText = buf.toString("utf8").slice(0, 8000);
              return { text: `[文件: ${fileName}]\n文件内容如下：\n\`\`\`\n${fileText}\n\`\`\`` };
            }
            return { text: `[文件: ${fileName}]`, mediaInfo: { type: "file", fileName, base64: buf.toString("base64") } };
          }
        }
        return { text: `[文件: ${fileName}]` };
      }

      if (msgType === "audio") return { text: "[语音消息，暂不支持转录]" };
      if (msgType === "video") return { text: "[视频消息]" };
      if (msgType === "sticker") return { text: "[表情包]" };
      return { text: `[${msgType} 消息]` };
    } catch {
      return null;
    }
  }

  private async extractQuoteContext(message: Record<string, unknown>): Promise<string | null> {
    try {
      const parent = message.parent_id as string | undefined;
      if (!parent) return null;
      const resp = await this.feishuClient.im.message.get({ path: { message_id: parent } });
      const items = (resp as any)?.items as Array<Record<string, unknown>>;
      if (!items?.length) return null;
      const item = items[0];
      const body = JSON.parse(String(item.body ?? "{}")) as Record<string, unknown>;
      const contentStr = String(body.content ?? "{}");
      const c = JSON.parse(contentStr) as Record<string, unknown>;
      return String(c.text ?? "").replace(/@[^\s]+\s*/g, "").trim() || null;
    } catch {
      return null;
    }
  }

  // ── Generate reply and deliver ─────────────────────────────────────────────────

  private async generateAndDeliver(
    userText: string,
    senderId: string,
    chatId: string,
    messageId: string,
    sessionKey: string,
    mediaInfo?: { type: "image" | "file"; base64?: string; mimeType?: string; fileName?: string },
    forwardMentions?: Array<{ id: Record<string, string>; name?: string }>,
  ): Promise<void> {
    const history = getHistory(sessionKey);
    const provider = this.opts.provider ?? "claude";

    const sessionId = getBotSession(
      this.opts.assistantId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
      sessionKey,
    );

    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userText });
    updateBotSessionTitle(sessionId, userText).catch(() => {});

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = await buildSmartMemoryContext(userText, this.opts.assistantId, this.opts.defaultCwd);
    const historySection = history.length > 1
      ? buildHistoryContext(history.slice(0, -1), this.opts.assistantId)
      : undefined;
    const system = buildStructuredPersona(this.opts, memoryContext, historySection);

    // Add typing indicator (emoji reaction)
    await this.addTypingReaction(messageId).catch(() => {});

    let replyText: string;
    let streamedFinalText = "";

    try {
      const result = await this.runClaudeQuery(system, userText, messageId, chatId, provider, sessionKey, mediaInfo);
      replyText = result.text;
      streamedFinalText = result.streamedText;
    } catch (err) {
      // Detect permission errors and append help link
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("99991672") || errMsg.includes("permission") || errMsg.includes("Forbidden")) {
        replyText = `抱歉，机器人缺少相关权限。\n错误详情：${errMsg}\n请在飞书开放平台为应用添加所需权限：https://open.feishu.cn/app`;
      } else {
        console.error("[Feishu] AI error:", err);
        replyText = "抱歉，处理您的消息时遇到了问题，请稍后再试。";
      }
    }

    // Remove typing reaction
    await this.removeTypingReaction(messageId).catch(() => {});

    // If streaming sent the reply directly, use the accumulated text for history
    const isStreamed = replyText === "\x00feishu_streamed\x00";
    const persistText = isStreamed ? streamedFinalText : replyText;

    history.push({ role: "assistant", content: persistText });
    this.persistReply(sessionId, persistText, userText);

    // Build @-mention prefix for group replies
    const mentionPrefix = forwardMentions?.length
      ? forwardMentions.map((m) => `<at user_id="${m.id.open_id}">${m.name ?? ""}</at>`).join(" ") + " "
      : "";

    // If already streamed to a card, skip sendReply
    if (!isStreamed) {
      await this.sendReply(messageId, chatId, mentionPrefix + replyText);
    }
  }

  // ── Typing indicator ──────────────────────────────────────────────────────────

  private async addTypingReaction(messageId: string): Promise<void> {
    if (!messageId) return;
    try {
      await this.feishuClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "THUMBSUP" } },
      });
    } catch {
      // ignore — typing indicator is best-effort
    }
  }

  private async removeTypingReaction(messageId: string): Promise<void> {
    if (!messageId) return;
    try {
      const resp = await this.feishuClient.im.messageReaction.list({
        path: { message_id: messageId },
        params: { reaction_type: "THUMBSUP", page_size: 5 },
      });
      const items = (resp as any)?.items as Array<{ reaction_id?: string; operator?: { operator_type?: string } }> | undefined;
      for (const item of items ?? []) {
        if (item.operator?.operator_type === "app" && item.reaction_id) {
          await this.feishuClient.im.messageReaction.delete({
            path: { message_id: messageId, reaction_id: item.reaction_id },
          }).catch(() => {});
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  // ── Claude query with streaming ──────────────────────────────────────────────

  private async runClaudeQuery(
    system: string,
    userText: string,
    messageId: string,
    chatId: string,
    provider: "claude" | "openai",
    sessionKey: string,
    mediaInfo?: { type: "image" | "file"; base64?: string; mimeType?: string; fileName?: string },
  ): Promise<{ text: string; streamedText: string }> {
    const sessionMcp = this.createSessionMcp(messageId, chatId);
    const feishuMcp = this.createFeishuEcosystemMcp();
    const sharedMcp = createSharedMcpServer({ assistantId: this.opts.assistantId, sessionCwd: this.opts.defaultCwd });
    const claudeSessionId = mediaInfo ? undefined : getBotClaudeSessionId(sessionKey);
    const claudeCodePath = getClaudeCodePath();

    let prompt = userText;
    if (mediaInfo?.type === "image" && mediaInfo.base64) {
      prompt = `${userText}\n\n[图片内容已附加，请分析图片并结合文字消息回复]`;
    }

    const assistantConfig = loadAssistantsConfig().assistants.find(a => a.id === this.opts.assistantId);
    const q = await runAgent(prompt, {
      systemPrompt: system,
      resume: claudeSessionId,
      cwd: this.opts.defaultCwd ?? homedir(),
      mcpServers: {
        "vk-shared": sharedMcp,
        "fs-session": sessionMcp,
        "feishu-ecosystem": feishuMcp,
      },
      pathToClaudeCodeExecutable: claudeCodePath,
      provider,
      ...(provider !== "openai" && {
        env: buildQueryEnv(assistantConfig),
      }),
      ...(provider === "openai" && {
        openaiOverrides: buildOpenAIOverrides(assistantConfig, this.opts.model),
      }),
    });

    // Stream the response with incremental card updates
    let finalText = "";
    let streamingMsgId: string | null = null;
    let accumulatedText = "";
    let lastPatchLen = 0;
    // Minimum characters between patches to avoid rate limiting
    const PATCH_THRESHOLD = 80;
    let patchTimer: ReturnType<typeof setTimeout> | null = null;

    const doPatch = async (text: string, isFinal = false) => {
      if (patchTimer) { clearTimeout(patchTimer); patchTimer = null; }
      const displayText = isFinal ? text : text + " ▌";
      try {
        if (!streamingMsgId) {
          const resp = await this.feishuClient.im.message.reply({
            path: { message_id: messageId },
            data: { content: buildCardContent(displayText), msg_type: "interactive", reply_in_thread: false },
          }) as any;
          streamingMsgId = resp?.data?.message_id ?? null;
        } else {
          await this.feishuClient.im.message.patch({
            path: { message_id: streamingMsgId },
            data: { content: buildCardContent(displayText) },
          });
        }
        lastPatchLen = text.length;
      } catch (err) {
        console.warn("[Feishu] Stream patch failed:", err instanceof Error ? err.message : String(err));
      }
    };

    for await (const message of q) {
      if (message.type === "stream_event") {
        const evt = (message as any).event;
        if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          accumulatedText += evt.delta.text as string;
          const growth = accumulatedText.length - lastPatchLen;
          if (growth >= PATCH_THRESHOLD) {
            if (patchTimer) clearTimeout(patchTimer);
            patchTimer = setTimeout(() => { doPatch(accumulatedText).catch(() => {}); }, 300);
          }
        }
      }
      if (message.type === "result" && message.subtype === "success") {
        finalText = message.result;
        setBotClaudeSessionId(sessionKey, message.session_id);
      }
    }

    if (patchTimer) { clearTimeout(patchTimer); patchTimer = null; }

    // Final patch: remove cursor indicator, show complete text
    if (streamingMsgId && finalText) {
      await doPatch(finalText, true);
      return { text: "\x00feishu_streamed\x00", streamedText: finalText };
    }

    return { text: finalText || "抱歉，无法生成回复。", streamedText: "" };
  }

  // ── Per-session MCP ───────────────────────────────────────────────────────────

  private createSessionMcp(messageId: string, chatId: string) {
    const self = this;

    const sendMessageTool = tool(
      "send_message",
      "向当前飞书对话立即发送一条消息。适合在执行长任务时告知用户进度，或推送中间结果。",
      { text: z.string().describe("要发送的消息内容") },
      async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return { content: [{ type: "text" as const, text: "消息内容为空" }] };
        await self.sendReply(messageId, chatId, text).catch((e) => console.warn("[Feishu] Failed to send reply:", e));
        return { content: [{ type: "text" as const, text: "消息已发送" }] };
      },
    );

    const sendFileTool = tool(
      "send_file",
      "通过飞书将本地文件发送给当前对话的用户。支持图片（png/jpg）、PDF、文档等。",
      { file_path: z.string().describe("要发送的文件的完整本地路径") },
      async (input) => {
        const result = await self.doSendFile(String(input.file_path ?? ""), messageId, chatId);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    const sendUrgentTool = tool(
      "send_urgent",
      "向飞书用户发送加急通知（应用内buzz）。需要 im:message.urgent 权限。",
      {
        user_id: z.string().describe("接收方的 open_id"),
        message_id: z.string().optional().describe("要加急的消息 ID，留空则使用当前消息"),
        urgent_type: z.enum(["app", "sms", "phone"]).optional().describe("加急方式：app(应用内)/sms(短信)/phone(语音电话)，默认app"),
      },
      async (input) => {
        const result = await self.doSendUrgent(
          String(input.user_id ?? ""),
          String(input.message_id ?? messageId),
          (input.urgent_type ?? "app") as "app" | "sms" | "phone",
        );
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    return createSdkMcpServer({ name: "feishu-session", tools: [sendMessageTool, sendFileTool, sendUrgentTool] });
  }

  // ── Feishu ecosystem MCP ──────────────────────────────────────────────────────

  private createFeishuEcosystemMcp() {
    const client = this.feishuClient;

    // ── Doc tools ─────────────────────────────────────────────────────────────

    const docReadTool = tool(
      "feishu_doc_read",
      "读取飞书文档内容。需要 docx:document:readonly 权限，且文档已分享给机器人。",
      { document_id: z.string().describe("文档 ID（URL 中 /docx/XXX 部分）") },
      async (input) => {
        try {
          const resp = await client.docx.document.get({ path: { document_id: String(input.document_id) } });
          const blocks = await client.docx.documentBlock.listWithIterator({
            path: { document_id: String(input.document_id) },
            params: { page_size: 200 },
          });
          const texts: string[] = [];
          for await (const page of blocks) {
            for (const block of page?.items ?? []) {
              const b = block as any;
              if (b.text?.elements) {
                for (const el of b.text.elements) {
                  if (el.text_run?.content) texts.push(el.text_run.content);
                }
                texts.push("\n");
              }
            }
          }
          return { content: [{ type: "text" as const, text: texts.join("") || "文档内容为空" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `读取文档失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const docWriteTool = tool(
      "feishu_doc_write",
      "向飞书文档追加 Markdown 内容。需要 docx:document 和 docx:document.block:convert 权限。",
      {
        document_id: z.string().describe("文档 ID"),
        markdown: z.string().describe("要追加的 Markdown 内容"),
      },
      async (input) => {
        try {
          // Convert markdown to blocks using Feishu markdown API
          const convertResp = await (client as any).docx.document.rawContent?.get?.({ path: { document_id: String(input.document_id) } }) ?? {};
          // Append as raw text block using any cast to bypass SDK strict types
          await (client.docx.documentBlock as any).batchUpdate({
            path: { document_id: String(input.document_id) },
            data: {
              requests: [{
                insert_blocks: {
                  index: { zone_id: "0", index: 99999 },
                  payload: [{
                    block_type: 2,
                    text: { elements: [{ text_run: { content: String(input.markdown) } }], style: {} },
                  }],
                },
              }],
              revision_id: -1,
            },
          });
          return { content: [{ type: "text" as const, text: "内容已追加到文档" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `写入文档失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    // ── Wiki tools ────────────────────────────────────────────────────────────

    const wikiSearchTool = tool(
      "feishu_wiki_search",
      "搜索飞书知识库内容。需要 wiki:wiki:readonly 权限，且机器人已被添加为知识库成员。",
      {
        query: z.string().describe("搜索关键词"),
        space_id: z.string().optional().describe("限定搜索的知识库空间 ID（可选）"),
      },
      async (input) => {
        try {
          const resp = await (client.wiki.space as any).node?.search({
            data: {
              query: String(input.query),
              space_id: input.space_id ? String(input.space_id) : undefined,
            },
          }) as any;
          const items = resp?.items ?? [];
          if (!items.length) return { content: [{ type: "text" as const, text: "未找到相关内容" }] };
          const result = items.slice(0, 10).map((item: any) =>
            `- [${item.title ?? "无标题"}] node_token: ${item.node_token}, space_id: ${item.space_id}`
          ).join("\n");
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `搜索失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const wikiListSpacesTool = tool(
      "feishu_wiki_list_spaces",
      "列出机器人有权访问的飞书知识库空间列表。",
      {},
      async () => {
        try {
          const resp = await client.wiki.space.list({ params: { page_size: 20 } }) as any;
          const items = resp?.items ?? [];
          if (!items.length) return { content: [{ type: "text" as const, text: "暂无可访问的知识库空间" }] };
          const result = items.map((s: any) => `- [${s.name}] space_id: ${s.space_id}`).join("\n");
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `获取空间列表失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    // ── Drive tools ───────────────────────────────────────────────────────────

    const driveListTool = tool(
      "feishu_drive_list",
      "列出飞书云空间某个文件夹的内容。需要 drive:drive:readonly 权限，且文件夹已分享给机器人。",
      {
        folder_token: z.string().describe("文件夹 token（URL 中 /folder/XXX 部分）"),
        page_size: z.number().optional().describe("每页数量（默认20）"),
      },
      async (input) => {
        try {
          const resp = await client.drive.file.list({
            params: {
              folder_token: String(input.folder_token),
              page_size: Number(input.page_size ?? 20),
            },
          }) as any;
          const files = resp?.files ?? [];
          if (!files.length) return { content: [{ type: "text" as const, text: "文件夹为空" }] };
          const result = files.map((f: any) => `- [${f.type}] ${f.name} | token: ${f.token}`).join("\n");
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `获取文件列表失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const driveCreateFolderTool = tool(
      "feishu_drive_create_folder",
      "在飞书云空间创建文件夹。需要 drive:drive 权限，且父文件夹已分享给机器人。",
      {
        name: z.string().describe("文件夹名称"),
        parent_token: z.string().describe("父文件夹的 token"),
      },
      async (input) => {
        try {
          const resp = await client.drive.file.createFolder({
            data: { name: String(input.name), folder_token: String(input.parent_token) },
          }) as any;
          return { content: [{ type: "text" as const, text: `文件夹已创建，token: ${resp?.token ?? "未知"}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `创建文件夹失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    // ── Bitable tools ─────────────────────────────────────────────────────────

    const bitableReadTool = tool(
      "feishu_bitable_read",
      "读取飞书多维表格记录。需要 bitable:app:readonly 权限，且表格已分享给机器人。支持 /base/XXX?table=YYY 格式的 URL。",
      {
        app_token: z.string().describe("多维表格 app_token（URL 中 /base/XXX 部分的 XXX）"),
        table_id: z.string().describe("数据表 ID"),
        filter: z.string().optional().describe("筛选条件（JSON 格式的过滤条件）"),
        page_size: z.number().optional().describe("每页数量（最多100，默认20）"),
      },
      async (input) => {
        try {
          const resp = await client.bitable.appTableRecord.list({
            path: { app_token: String(input.app_token), table_id: String(input.table_id) },
            params: { page_size: Number(input.page_size ?? 20) },
          }) as any;
          const items = resp?.items ?? [];
          if (!items.length) return { content: [{ type: "text" as const, text: "表格中无记录" }] };
          const result = JSON.stringify(items.slice(0, 50), null, 2);
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `读取表格失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const bitableCreateRecordTool = tool(
      "feishu_bitable_create_record",
      "在飞书多维表格中创建记录。需要 bitable:app 权限。",
      {
        app_token: z.string().describe("多维表格 app_token"),
        table_id: z.string().describe("数据表 ID"),
        fields: z.record(z.string(), z.unknown()).describe("字段数据，key 为字段名，value 为字段值"),
      },
      async (input) => {
        try {
          const resp = await (client.bitable.appTableRecord as any).create({
            path: { app_token: String(input.app_token), table_id: String(input.table_id) },
            data: { fields: input.fields },
          }) as any;
          return { content: [{ type: "text" as const, text: `记录已创建，record_id: ${resp?.record?.record_id ?? "未知"}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `创建记录失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const bitableUpdateRecordTool = tool(
      "feishu_bitable_update_record",
      "更新飞书多维表格中的记录。需要 bitable:app 权限。",
      {
        app_token: z.string().describe("多维表格 app_token"),
        table_id: z.string().describe("数据表 ID"),
        record_id: z.string().describe("记录 ID"),
        fields: z.record(z.string(), z.unknown()).describe("要更新的字段数据"),
      },
      async (input) => {
        try {
          await (client.bitable.appTableRecord as any).update({
            path: { app_token: String(input.app_token), table_id: String(input.table_id), record_id: String(input.record_id) },
            data: { fields: input.fields },
          });
          return { content: [{ type: "text" as const, text: "记录已更新" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `更新记录失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const bitableDeleteRecordTool = tool(
      "feishu_bitable_delete_record",
      "删除飞书多维表格中的记录。需要 bitable:app 权限。",
      {
        app_token: z.string().describe("多维表格 app_token"),
        table_id: z.string().describe("数据表 ID"),
        record_id: z.string().describe("记录 ID"),
      },
      async (input) => {
        try {
          await client.bitable.appTableRecord.delete({
            path: { app_token: String(input.app_token), table_id: String(input.table_id), record_id: String(input.record_id) },
          });
          return { content: [{ type: "text" as const, text: "记录已删除" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `删除记录失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    // ── Task tools ────────────────────────────────────────────────────────────

    const taskCreateTool = tool(
      "feishu_task_create",
      "创建飞书任务（Task v2 API）。需要 task:task:write 权限。",
      {
        summary: z.string().describe("任务标题"),
        description: z.string().optional().describe("任务描述"),
        due_date: z.string().optional().describe("截止日期（ISO 8601 格式，如 2024-12-31T23:59:59+08:00）"),
        assignee_ids: z.array(z.string()).optional().describe("负责人 user_id 列表"),
        tasklist_guid: z.string().optional().describe("所属任务清单 GUID（可选）"),
      },
      async (input) => {
        try {
          const resp = await (client as any).task.task.create({
            data: {
              summary: String(input.summary),
              description: input.description ? String(input.description) : undefined,
              due: input.due_date ? { timestamp: String(new Date(String(input.due_date)).getTime()) } : undefined,
              members: input.assignee_ids?.map((id) => ({ id, type: "user", role: "assignee" })),
              tasklist_infos: input.tasklist_guid ? [{ tasklist_guid: String(input.tasklist_guid) }] : undefined,
            },
          });
          const task = (resp as any)?.task;
          return { content: [{ type: "text" as const, text: `任务已创建，guid: ${task?.guid ?? "未知"}，标题: ${task?.summary ?? input.summary}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `创建任务失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const taskGetTool = tool(
      "feishu_task_get",
      "获取飞书任务详情。需要 task:task:read 权限。",
      { task_guid: z.string().describe("任务 GUID") },
      async (input) => {
        try {
          const resp = await (client as any).task.task.get({
            path: { task_guid: String(input.task_guid) },
          });
          const task = (resp as any)?.task;
          return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `获取任务失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const taskUpdateTool = tool(
      "feishu_task_update",
      "更新飞书任务（标题、描述、状态等）。需要 task:task:write 权限。",
      {
        task_guid: z.string().describe("任务 GUID"),
        summary: z.string().optional().describe("新标题"),
        description: z.string().optional().describe("新描述"),
        completed: z.boolean().optional().describe("是否完成"),
      },
      async (input) => {
        try {
          const updateFields: string[] = [];
          const data: Record<string, unknown> = {};
          if (input.summary !== undefined) { data.summary = String(input.summary); updateFields.push("summary"); }
          if (input.description !== undefined) { data.description = String(input.description); updateFields.push("description"); }
          if (input.completed !== undefined) { data.completed_at = input.completed ? String(Date.now()) : "0"; updateFields.push("completed_at"); }
          await (client as any).task.task.patch({
            path: { task_guid: String(input.task_guid) },
            data: { task: data, update_fields: updateFields },
          });
          return { content: [{ type: "text" as const, text: "任务已更新" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `更新任务失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const taskDeleteTool = tool(
      "feishu_task_delete",
      "删除飞书任务。需要 task:task:write 权限。",
      { task_guid: z.string().describe("任务 GUID") },
      async (input) => {
        try {
          await (client as any).task.task.delete({ path: { task_guid: String(input.task_guid) } });
          return { content: [{ type: "text" as const, text: "任务已删除" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `删除任务失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    // ── Chat tools ────────────────────────────────────────────────────────────

    const chatGetTool = tool(
      "feishu_chat_get",
      "获取群聊信息（包括群公告）。需要 im:chat:readonly 权限。",
      { chat_id: z.string().describe("群聊 chat_id") },
      async (input) => {
        try {
          const resp = await client.im.chat.get({ path: { chat_id: String(input.chat_id) } });
          return { content: [{ type: "text" as const, text: JSON.stringify(resp, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `获取群聊信息失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const chatUpdateAnnouncementTool = tool(
      "feishu_chat_update_announcement",
      "更新群公告内容。需要 im:chat.announcement 权限。",
      {
        chat_id: z.string().describe("群聊 chat_id"),
        content: z.string().describe("公告内容（富文本 JSON 格式）"),
      },
      async (input) => {
        try {
          await (client.im.chatAnnouncement as any).patch({
            path: { chat_id: String(input.chat_id) },
            data: { content: String(input.content), revision_id: "0" },
          });
          return { content: [{ type: "text" as const, text: "群公告已更新" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `更新群公告失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const chatCreateTool = tool(
      "feishu_chat_create",
      "创建群聊。需要 im:chat 权限。",
      {
        name: z.string().describe("群名称"),
        member_ids: z.array(z.string()).optional().describe("初始成员 open_id 列表"),
      },
      async (input) => {
        try {
          const resp = await client.im.chat.create({
            data: {
              name: String(input.name),
              user_id_list: input.member_ids ?? [],
            },
          }) as any;
          return { content: [{ type: "text" as const, text: `群聊已创建，chat_id: ${resp?.chat_id ?? "未知"}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `创建群聊失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const chatAddMembersTool = tool(
      "feishu_chat_add_members",
      "向群聊添加成员。需要 im:chat.members 权限。",
      {
        chat_id: z.string().describe("群聊 chat_id"),
        member_ids: z.array(z.string()).describe("要添加的成员 open_id 列表"),
      },
      async (input) => {
        try {
          await client.im.chatMembers.create({
            path: { chat_id: String(input.chat_id) },
            data: { id_list: input.member_ids ?? [] },
            params: { member_id_type: "open_id" },
          });
          return { content: [{ type: "text" as const, text: "成员已添加" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `添加成员失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    return createSdkMcpServer({
      name: "feishu-ecosystem",
      tools: [
        docReadTool, docWriteTool,
        wikiSearchTool, wikiListSpacesTool,
        driveListTool, driveCreateFolderTool,
        bitableReadTool, bitableCreateRecordTool, bitableUpdateRecordTool, bitableDeleteRecordTool,
        taskCreateTool, taskGetTool, taskUpdateTool, taskDeleteTool,
        chatGetTool, chatUpdateAnnouncementTool, chatCreateTool, chatAddMembersTool,
      ],
    });
  }

  // ── Urgent notification ───────────────────────────────────────────────────────

  private async doSendUrgent(userId: string, msgId: string, urgentType: "app" | "sms" | "phone"): Promise<string> {
    try {
      await (this.feishuClient as any).im.message.urgentApp({
        path: { message_id: msgId },
        data: { user_id_list: [userId] },
        params: { user_id_type: "open_id" },
      });
      return `加急通知已发送 (${urgentType}) 给用户 ${userId}`;
    } catch (err) {
      return `发送加急失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── File upload and send ───────────────────────────────────────────────────────

  private async doSendFile(filePath: string, messageId: string, chatId: string): Promise<string> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const path = await import("path");
    const fs = await import("fs");
    const os2 = await import("os");

    if (!filePath || !fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const isImage = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext);
    const IMAGE_LIMIT = 20 * 1024 * 1024;

    const tempFiles: string[] = [];
    const cleanup = () => {
      for (const f of tempFiles) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
      }
    };

    let sendPath = filePath;
    const stat = fs.statSync(filePath);

    if (isImage && stat.size > IMAGE_LIMIT) {
      const compressedPath = path.join(os2.tmpdir(), `vk-compressed-${Date.now()}.jpg`);
      tempFiles.push(compressedPath);
      try {
        if (process.platform === "darwin") {
          await execAsync(`sips -s format jpeg -s formatOptions 70 -Z 2000 "${filePath}" --out "${compressedPath}"`);
        } else {
          await execAsync(`convert "${filePath}" -resize 2000x2000> -quality 70 "${compressedPath}"`);
        }
        const newStat = fs.statSync(compressedPath);
        if (newStat.size <= IMAGE_LIMIT) {
          sendPath = compressedPath;
        } else {
          cleanup();
          return "图片压缩后仍超过 20MB，建议先裁剪或降低分辨率。";
        }
      } catch {
        cleanup();
        return "图片超过 20MB 限制，压缩失败，请先手动压缩。";
      }
    }

    try {
      const sendExt = sendPath.split(".").pop()?.toLowerCase() ?? ext;
      const sendIsImage = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(sendExt);

      if (sendIsImage) {
        const imageBuffer = fs.readFileSync(sendPath);
        const uploadResp = await this.feishuClient.im.image.create({
          data: { image_type: "message", image: imageBuffer },
        });
        const imageKey = (uploadResp as Record<string, unknown>)?.image_key as string | undefined;
        if (!imageKey) { cleanup(); return "图片上传失败（无 image_key）"; }

        if (messageId) {
          await this.feishuClient.im.message.reply({
            path: { message_id: messageId },
            data: { content: JSON.stringify({ image_key: imageKey }), msg_type: "image", reply_in_thread: false },
          });
        } else if (chatId) {
          await this.feishuClient.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content: JSON.stringify({ image_key: imageKey }), msg_type: "image" },
          });
        }
        cleanup();
        return `图片已发送: ${path.basename(sendPath)}`;
      } else {
        const fileBuffer = fs.readFileSync(sendPath);
        const fileName = path.basename(sendPath);
        const uploadResp = await this.feishuClient.im.file.create({
          data: { file_type: "stream", file_name: fileName, file: fileBuffer },
        });
        const fileKey = (uploadResp as Record<string, unknown>)?.file_key as string | undefined;
        if (!fileKey) { cleanup(); return "文件上传失败（无 file_key）"; }

        if (messageId) {
          await this.feishuClient.im.message.reply({
            path: { message_id: messageId },
            data: { content: JSON.stringify({ file_key: fileKey }), msg_type: "file", reply_in_thread: false },
          });
        } else if (chatId) {
          await this.feishuClient.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content: JSON.stringify({ file_key: fileKey }), msg_type: "file" },
          });
        }
        cleanup();
        return `文件已发送: ${fileName}`;
      }
    } catch (err) {
      cleanup();
      return `发送失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Persist reply ─────────────────────────────────────────────────────────────

  private persistReply(sessionId: string, replyText: string, userText?: string): void {
    sessionStore?.recordMessage(sessionId, {
      type: "assistant",
      uuid: randomUUID(),
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        model: this.opts.model || "",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as unknown as import("../types.js").StreamMessage);

    if (userText) {
      recordConversation(
        `\n## ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${userText}\n**${this.opts.assistantName}**: ${replyText}\n`,
        { assistantId: this.opts.assistantId, assistantName: this.opts.assistantName, channel: "飞书" },
      );
    }
  }

  // ── Upload image for post ─────────────────────────────────────────────────────

  private async uploadImageForPost(filePath: string): Promise<string | null> {
    try {
      const fs = await import("fs");
      const imageBuffer = fs.readFileSync(filePath);
      const uploadResp = await this.feishuClient.im.image.create({
        data: { image_type: "message", image: imageBuffer },
      });
      return (uploadResp as Record<string, unknown>)?.image_key as string ?? null;
    } catch {
      return null;
    }
  }

  // ── Send reply ────────────────────────────────────────────────────────────────

  private async sendReply(messageId: string, chatId: string, text: string): Promise<void> {
    try {
      const renderMode = this.opts.renderMode ?? "auto";
      const segments = parseReplySegments(text);
      const hasImages = segments.some((s) => s.kind === "image");

      if (hasImages) {
        const paragraphs: Array<Array<{ tag: string; text?: string; image_key?: string }>> = [];
        for (const seg of segments) {
          if (seg.kind === "text") {
            const trimmed = seg.content.trim();
            if (!trimmed) continue;
            paragraphs.push([{ tag: "text", text: trimmed }]);
          } else {
            const imageKey = await this.uploadImageForPost(seg.path);
            if (imageKey) {
              paragraphs.push([{ tag: "img", image_key: imageKey }]);
            } else {
              paragraphs.push([{ tag: "text", text: `[图片: ${seg.path}]` }]);
            }
          }
        }
        const postContent = JSON.stringify({ zh_cn: { title: "", content: paragraphs } });
        if (messageId) {
          await this.feishuClient.im.message.reply({
            path: { message_id: messageId },
            data: { content: postContent, msg_type: "post", reply_in_thread: false },
          });
          return;
        }
        if (chatId) {
          await this.feishuClient.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content: postContent, msg_type: "post" },
          });
        }
        return;
      }

      // Card rendering
      if (shouldUseCard(text, renderMode)) {
        const cardContent = buildCardContent(text);
        if (messageId) {
          await this.feishuClient.im.message.reply({
            path: { message_id: messageId },
            data: { content: cardContent, msg_type: "interactive", reply_in_thread: false },
          });
          return;
        }
        if (chatId) {
          await this.feishuClient.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content: cardContent, msg_type: "interactive" },
          });
        }
        return;
      }

      // Plain text
      if (messageId) {
        await this.feishuClient.im.message.reply({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text }), msg_type: "text", reply_in_thread: false },
        });
        return;
      }
      if (chatId) {
        await this.feishuClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" },
        });
      }
    } catch (err) {
      // Detect permission error and notify
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("99991672") || errMsg.includes("Forbidden") || errMsg.includes("permission")) {
        console.error("[Feishu] Permission error when sending reply:", errMsg);
        // Try to send plain error notification
        try {
          const notice = `⚠️ 权限不足，无法发送消息。请在飞书开放平台为应用添加所需权限：https://open.feishu.cn/app\n错误：${errMsg}`;
          await this.feishuClient.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content: JSON.stringify({ text: notice }), msg_type: "text" },
          });
        } catch { /* ignore */ }
      } else {
        console.error("[Feishu] Send reply error:", err);
      }
    }
  }

  async sendProactive(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.feishuClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" },
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Feishu] Proactive send error:", msg);
      return { ok: false, error: msg };
    }
  }
}
