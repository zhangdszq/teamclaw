/**
 * QQ Bot Service
 *
 * Uses the official QQ Bot Open Platform API:
 * - Token via POST https://bots.qq.com/app/getAppAccessToken
 * - WebSocket gateway for receiving messages
 * - REST API at https://api.sgroup.qq.com for sending messages
 *
 * Supports: C2C private chat, group @messages, text + image, proactive push.
 * Follows the same architecture as telegram-bot.ts / dingtalk-bot.ts / feishu-bot.ts.
 */
import WebSocket from "ws";
import { EventEmitter } from "events";
import { homedir } from "os";
import { readFileSync } from "fs";
import { basename } from "path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { promptOnce, runAgent } from "./agent-client.js";
import { buildSmartMemoryContext } from "./memory-store.js";
import { patchAssistantBotOwnerIds, loadAssistantsConfig } from "./assistants-config.js";
import { getClaudeCodePath } from "./util.js";
import type { SessionStore } from "./session-store.js";
import type { StreamMessage } from "../types.js";
import { createSharedMcpServer, type SharedMcpSensitiveTurnState } from "./shared-mcp.js";
import { loadMcporterServers } from "./mcporter-loader.js";
import {
  type ConvMessage,
  type BaseBotOptions,
  FILE_SEND_RULE,
  PRIVATE_WHITELIST_RULE,
  buildOpenAIOverrides,
  buildQueryEnv,
  buildStructuredPersona as buildStructuredPersonaBase,
  prepareVisibleArtifact,
  buildHistoryContext,
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
  parseReplySegments,
  extractPartialText,
  bufferPersistedBotMessage,
  flushBufferedBotAssistantMessage,
  scheduleBotPostResponseTasks,
} from "./bot-base.js";
import {
  buildActivatedSkillSection,
  resolveSkillPromptContext,
} from "./skill-context.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type QQBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface QQBotOptions extends BaseBotOptions {
  appId: string;
  clientSecret: string;
  provider?: "claude" | "openai";
  model?: string;
  defaultCwd?: string;
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  ownerOpenIds?: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";
const QQ_MSG_CHAR_LIMIT = 2000;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const HEARTBEAT_SAFETY_MARGIN_MS = 5_000;

const INTENTS = 1 << 25; // C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE

// ─── Persona builder ──────────────────────────────────────────────────────────

function buildStructuredPersona(
  opts: QQBotOptions,
  ...extras: (string | undefined | null)[]
): string {
  return buildStructuredPersonaBase(opts, FILE_SEND_RULE, ...extras);
}

// ─── Message deduplication ────────────────────────────────────────────────────

const processedMsgs = new Map<string, number>();

function isDuplicate(key: string): boolean { return isDuplicateMsg(key, processedMsgs); }
function markProcessed(key: string): void { markProcessedMsg(key, processedMsgs); }

// ─── Access control ───────────────────────────────────────────────────────────

function isAllowed(
  senderId: string,
  chatId: string,
  isGroup: boolean,
  opts: QQBotOptions,
): boolean {
  if (isGroup) {
    if ((opts.groupPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      if (!allowed.includes(chatId) && !allowed.includes(senderId)) {
        console.log(`[QQBot] Group ${chatId} / user ${senderId} blocked by groupPolicy=allowlist`);
        return false;
      }
    }
  } else {
    if ((opts.dmPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      if (!senderId || !allowed.includes(senderId)) {
        console.log(`[QQBot] User ${senderId} blocked by dmPolicy=allowlist`);
        return false;
      }
    }
  }
  return true;
}

// ─── Message chunking ─────────────────────────────────────────────────────────

function chunkMessage(text: string): string[] {
  if (text.length <= QQ_MSG_CHAR_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= QQ_MSG_CHAR_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", QQ_MSG_CHAR_LIMIT);
    if (splitAt < QQ_MSG_CHAR_LIMIT * 0.3) {
      splitAt = remaining.lastIndexOf(" ", QQ_MSG_CHAR_LIMIT);
    }
    if (splitAt < QQ_MSG_CHAR_LIMIT * 0.3) {
      splitAt = QQ_MSG_CHAR_LIMIT;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

// ─── Msg seq generator ────────────────────────────────────────────────────────

function getNextMsgSeq(): number {
  const timePart = Date.now() % 100000000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

// ─── Status emitter ───────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onQQBotStatusChange(
  cb: (assistantId: string, status: QQBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emitStatus(assistantId: string, status: QQBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Session update emitter ───────────────────────────────────────────────────

const sessionUpdateEmitter = new EventEmitter();

export function onQQBotSessionUpdate(
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

export function setQQBotSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Token management ─────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCacheMap = new Map<string, TokenCache>();
const tokenFetchPromises = new Map<string, Promise<string>>();

async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cached = tokenCacheMap.get(appId);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  let fetchPromise = tokenFetchPromises.get(appId);
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const resp = await fetch(QQ_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, clientSecret }),
      });
      const data = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
      }
      const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
      tokenCacheMap.set(appId, { token: data.access_token, expiresAt });
      console.log(`[QQBot:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`);
      return data.access_token;
    } finally {
      tokenFetchPromises.delete(appId);
    }
  })();

  tokenFetchPromises.set(appId, fetchPromise);
  return fetchPromise;
}

// ─── QQ API helpers ───────────────────────────────────────────────────────────

async function qqApiRequest<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${QQ_API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const rawText = await res.text();
  let data: T;
  try {
    data = JSON.parse(rawText) as T;
  } catch {
    throw new Error(`Failed to parse QQ API response [${path}]: ${rawText.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err = data as { message?: string; code?: number };
    throw new Error(`QQ API Error [${path}]: ${err.message ?? rawText.slice(0, 200)}`);
  }

  return data;
}

async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
): Promise<void> {
  const msgSeq = getNextMsgSeq();
  await qqApiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
): Promise<void> {
  const msgSeq = getNextMsgSeq();
  await qqApiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
): Promise<void> {
  const msgSeq = getNextMsgSeq();
  try {
    await qqApiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_seq: msgSeq,
      ...(msgId ? { msg_id: msgId } : {}),
    });
  } catch {
    // Typing indicator is best-effort
  }
}

async function sendC2CImageMessage(
  accessToken: string,
  openid: string,
  imageBase64: string,
  msgId?: string,
): Promise<void> {
  const uploadResult = await qqApiRequest<{ file_info: string }>(
    accessToken, "POST", `/v2/users/${openid}/files`,
    { file_type: 1, file_data: imageBase64, srv_send_msg: false },
  );
  const msgSeq = getNextMsgSeq();
  await qqApiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
    msg_type: 7,
    media: { file_info: uploadResult.file_info },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

async function sendGroupImageMessage(
  accessToken: string,
  groupOpenid: string,
  imageBase64: string,
  msgId?: string,
): Promise<void> {
  const uploadResult = await qqApiRequest<{ file_info: string }>(
    accessToken, "POST", `/v2/groups/${groupOpenid}/files`,
    { file_type: 1, file_data: imageBase64, srv_send_msg: false },
  );
  const msgSeq = getNextMsgSeq();
  await qqApiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7,
    media: { file_info: uploadResult.file_info },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

// ─── Connection pool ──────────────────────────────────────────────────────────

const pool = new Map<string, QQBotConnection>();

export async function startQQBot(opts: QQBotOptions): Promise<void> {
  stopQQBot(opts.assistantId);

  const existingAppId = findAssistantByAppId(opts.appId, opts.assistantId);
  if (existingAppId) {
    console.warn(`[QQBot] Duplicate appId detected: stopping assistant=${existingAppId}`);
    stopQQBot(existingAppId);
  }

  const conn = new QQBotConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start();
}

export function stopQQBot(assistantId: string): void {
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
  emitStatus(assistantId, "disconnected");
}

export function getQQBotStatus(assistantId: string): QQBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

export function getAnyConnectedQQBotAssistantId(): string | null {
  for (const [id, conn] of pool.entries()) {
    if (conn.status === "connected") return id;
  }
  return null;
}

export function updateQQBotConfig(
  assistantId: string,
  updates: Partial<Pick<QQBotOptions, "provider" | "model" | "persona" | "coreValues" | "relationship" | "cognitiveStyle" | "operatingGuidelines" | "userContext" | "assistantName" | "defaultCwd" | "skillNames">>,
): void {
  const conn = pool.get(assistantId);
  if (!conn) return;
  Object.assign(conn.opts, updates);
  console.log(`[QQBot] Config updated for assistant=${assistantId}:`, Object.keys(updates));
}

function findAssistantByAppId(appId: string, excludeAssistantId?: string): string | null {
  for (const [id, conn] of pool.entries()) {
    if (id === excludeAssistantId) continue;
    if (conn.opts.appId === appId) return id;
  }
  return null;
}

// ─── Proactive messaging ──────────────────────────────────────────────────────

export async function sendProactiveQQMessage(
  assistantId: string,
  text: string,
  opts?: { targets?: string[] },
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `QQ Bot (${assistantId}) 未连接` };
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
  if (!sessionStore) throw new Error("[QQBot] SessionStore not injected");
  const existingId = botSessionIds.get(key);
  if (existingId && sessionStore.getSession(existingId)) return existingId;
  const session = sessionStore.createSession({
    title: `[QQ] ${assistantName}`,
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
  prefix = "[QQ]",
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
  } catch (err) {
    console.warn(`[QQBot] Title generation failed:`, err);
    if (prevCount === 0) {
      emitSessionUpdate(sessionId, { title: `${prefix} ${fallback}` });
    }
  }
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

// ─── QQBotConnection ──────────────────────────────────────────────────────────

class QQBotConnection {
  status: QQBotStatus = "disconnected";
  opts: QQBotOptions;
  private ws: WebSocket | null = null;
  private stopped = false;
  private inflight = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeqNum: number | null = null;
  private sessionId: string | null = null;
  private heartbeatIntervalMs = 41250;

  constructor(opts: QQBotOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.clearTimers();
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting");

    try {
      const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
      const gatewayData = await qqApiRequest<{ url: string }>(token, "GET", "/gateway");
      const gatewayUrl = gatewayData.url;

      console.log(`[QQBot] Connecting to gateway: ${gatewayUrl}`);
      this.connectWebSocket(gatewayUrl, token);
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
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.status = "disconnected";
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private connectWebSocket(gatewayUrl: string, token: string): void {
    const ws = new WebSocket(gatewayUrl);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[QQBot] WebSocket connected`);
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const payload = JSON.parse(data.toString()) as {
          op: number;
          d?: any;
          s?: number;
          t?: string;
        };

        if (payload.s != null) this.lastSeqNum = payload.s;

        switch (payload.op) {
          case 10: // Hello
            this.heartbeatIntervalMs = payload.d?.heartbeat_interval ?? 41250;
            this.sendIdentify(ws, token);
            this.startHeartbeat(ws);
            break;

          case 0: // Dispatch
            this.handleDispatch(payload.t ?? "", payload.d);
            break;

          case 11: // Heartbeat ACK
            break;

          case 7: // Reconnect
            console.log(`[QQBot] Server requested reconnect`);
            this.scheduleReconnect();
            break;

          case 9: // Invalid Session
            console.warn(`[QQBot] Invalid session, re-identifying`);
            this.sessionId = null;
            this.sendIdentify(ws, token);
            break;

          default:
            break;
        }
      } catch (err) {
        console.error(`[QQBot] Failed to parse WS message:`, err);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[QQBot] WebSocket closed: ${code} ${reason?.toString()}`);
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      console.error(`[QQBot] WebSocket error:`, err.message);
      if (!this.stopped) {
        this.status = "error";
        emitStatus(this.opts.assistantId, "error", err.message);
      }
    });
  }

  private sendIdentify(ws: WebSocket, token: string): void {
    if (this.sessionId && this.lastSeqNum !== null) {
      ws.send(JSON.stringify({
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.lastSeqNum,
        },
      }));
    } else {
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: INTENTS,
          shard: [0, 1],
        },
      }));
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    const intervalMs = Math.max(this.heartbeatIntervalMs - HEARTBEAT_SAFETY_MARGIN_MS, 10000);
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ op: 1, d: this.lastSeqNum }));
    }, intervalMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.clearTimers();
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.status = "error";
      emitStatus(this.opts.assistantId, "error", `超过最大重连次数 (${MAX_RECONNECT_ATTEMPTS})`);
      return;
    }

    const jitter = Math.random() * 0.3;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts) * (1 + jitter), RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    console.log(`[QQBot] Scheduling reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting", `重连中 (${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        await this.start();
      } catch (err) {
        console.error("[QQBot] Reconnect failed:", err instanceof Error ? err.message : err);
        if (!this.stopped) this.scheduleReconnect();
      }
    }, delay);
  }

  // ── Dispatch handler ─────────────────────────────────────────────────────────

  private handleDispatch(eventType: string, data: any): void {
    console.log(`[QQBot] Dispatch event: ${eventType}`);
    switch (eventType) {
      case "READY": {
        this.sessionId = data?.session_id ?? null;
        const user = data?.user;
        console.log(`[QQBot] Ready: bot=${user?.username ?? user?.id ?? "?"}, session=${this.sessionId}`);
        this.reconnectAttempts = 0;
        this.status = "connected";
        emitStatus(this.opts.assistantId, "connected");
        break;
      }

      case "RESUMED":
        console.log(`[QQBot] Session resumed`);
        this.reconnectAttempts = 0;
        this.status = "connected";
        emitStatus(this.opts.assistantId, "connected");
        break;

      case "C2C_MESSAGE_CREATE":
        this.handleC2CMessage(data).catch((err) =>
          console.error("[QQBot] C2C message error:", err),
        );
        break;

      case "GROUP_AT_MESSAGE_CREATE":
        this.handleGroupMessage(data).catch((err) =>
          console.error("[QQBot] Group message error:", err),
        );
        break;

      default:
        break;
    }
  }

  // ── C2C message handling ────────────────────────────────────────────────────

  private async handleC2CMessage(event: any): Promise<void> {
    const userOpenId = event?.author?.user_openid ?? event?.author?.id;
    const msgId = event?.id;
    const content = (event?.content ?? "").trim();

    if (!userOpenId || !msgId) return;

    const dedupKey = `qq:${this.opts.assistantId}:c2c:${msgId}`;
    if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) return;
    markProcessed(dedupKey);
    this.inflight.add(dedupKey);

    try {
      if (!isAllowed(userOpenId, userOpenId, false, this.opts)) return;

      // Auto-populate ownerOpenIds
      if (!(this.opts.ownerOpenIds?.length)) {
        const updated = patchAssistantBotOwnerIds(this.opts.assistantId, "qqbot", userOpenId);
        if (updated) {
          this.opts.ownerOpenIds = [userOpenId];
        }
      }

      // /myid command
      if (content === "/myid" || content === "/我的id" || content === "/我的ID") {
        const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
        await sendC2CMessage(token, userOpenId,
          `你的 QQ 用户 OpenID：${userOpenId}\n\n复制此 ID 填入 Bot 配置 → 高级设置 → 我的 OpenID，即可接收主动推送。`,
          msgId,
        );
        return;
      }

      // /new command
      if (content === "/new" || content === "/reset" || content === "/重置") {
        const historyKey = `${this.opts.assistantId}:c2c:${userOpenId}`;
        histories.delete(historyKey);
        botClaudeSessionIds.delete(historyKey);
        botSessionIds.delete(historyKey);
        const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
        await sendC2CMessage(token, userOpenId, "对话已重置，开始新的对话吧！", msgId);
        return;
      }

      if (!content) return;

      console.log(`[QQBot] C2C from ${userOpenId}: ${content.slice(0, 100)}`);

      // Typing indicator
      const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
      await sendC2CInputNotify(token, userOpenId, msgId);

      await this.generateAndDeliver(content, `c2c:${userOpenId}`, false, userOpenId, undefined, msgId);
    } finally {
      this.inflight.delete(dedupKey);
    }
  }

  // ── Group message handling ──────────────────────────────────────────────────

  private async handleGroupMessage(event: any): Promise<void> {
    const memberOpenId = event?.author?.member_openid ?? event?.author?.id;
    const groupOpenId = event?.group_openid ?? event?.group_id;
    const msgId = event?.id;
    let content = (event?.content ?? "").trim();

    if (!groupOpenId || !msgId) return;

    const dedupKey = `qq:${this.opts.assistantId}:group:${msgId}`;
    if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) return;
    markProcessed(dedupKey);
    this.inflight.add(dedupKey);

    try {
      if (!isAllowed(memberOpenId ?? "", groupOpenId, true, this.opts)) return;

      // Strip @mention content (QQ strips the mention text but may leave leading whitespace)
      content = content.replace(/^\/?\s*/, "").trim();

      if (!content) return;

      console.log(`[QQBot] Group ${groupOpenId} from ${memberOpenId}: ${content.slice(0, 100)}`);

      await this.generateAndDeliver(content, `group:${groupOpenId}`, true, undefined, groupOpenId, msgId);
    } finally {
      this.inflight.delete(dedupKey);
    }
  }

  // ── Generate reply and deliver ─────────────────────────────────────────────

  private async generateAndDeliver(
    userText: string,
    chatKey: string,
    isGroup: boolean,
    c2cOpenId?: string,
    groupOpenId?: string,
    msgId?: string,
  ): Promise<void> {
    const skillContext = resolveSkillPromptContext(userText, this.opts.skillNames);
    const effectiveUserText = skillContext?.userText ?? userText;
    const historyKey = `${this.opts.assistantId}:${chatKey}`;
    const history = getHistory(historyKey);
    const provider = this.opts.provider ?? "claude";
    const isOwner = !isGroup && Boolean(c2cOpenId && this.opts.ownerOpenIds?.includes(c2cOpenId));
    const sensitiveTurnState: SharedMcpSensitiveTurnState = { active: false };
    const persistedMessages: StreamMessage[] = [];

    const sessionId = getBotSession(
      this.opts.assistantId,
      chatKey,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
      this.opts.skillNames,
    );
    const historyLengthBeforeTurn = history.length;
    history.push({ role: "user", content: effectiveUserText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = await buildSmartMemoryContext(
      effectiveUserText,
      this.opts.assistantId,
      this.opts.defaultCwd,
    );

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowStr = new Date().toLocaleString("zh-CN", { timeZone: tz, hour12: false });
    const currentTimeContext = `## 当前时间\n消息发送时间：${nowStr}（时区：${tz}）`;

    const historySection = history.length > 1
      ? buildHistoryContext(history.slice(0, -1), this.opts.assistantId)
      : undefined;

    const skillSection = buildActivatedSkillSection(skillContext?.skillContent);
    const privateWhitelistSection = isOwner ? PRIVATE_WHITELIST_RULE : undefined;
    const system = buildStructuredPersona(this.opts, currentTimeContext, memoryContext, skillSection, historySection, privateWhitelistSection);

    let replyText: string;
    try {
      replyText = await this.runClaudeQuery(
        system,
        effectiveUserText,
        chatKey,
        provider,
        sessionId,
        isGroup,
        isOwner,
        sensitiveTurnState,
        persistedMessages,
        c2cOpenId,
        groupOpenId,
        msgId,
      );
    } catch (err) {
      console.error("[QQBot] AI error:", err);
      replyText = "抱歉，处理您的消息时遇到了问题，请稍后再试。";
    }

    const shouldPersistTurn = !sensitiveTurnState.active;
    if (shouldPersistTurn) {
      sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: effectiveUserText });
      for (const message of persistedMessages) {
        sessionStore?.recordMessage(sessionId, message);
      }
      history.push({ role: "assistant", content: replyText });
    } else {
      history.length = historyLengthBeforeTurn;
    }
    emitSessionUpdate(sessionId, { status: "idle" });
    const historySnapshot = history.slice();

    // Deliver response
    await this.deliverReply(replyText, isGroup, c2cOpenId, groupOpenId, msgId);
    if (shouldPersistTurn) {
      scheduleBotPostResponseTasks({
        logEntry: `\n## ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${effectiveUserText}\n**${this.opts.assistantName}**: ${replyText}\n`,
        recordOpts: { assistantId: this.opts.assistantId, assistantName: this.opts.assistantName, channel: "QQ" },
        updateTitle: () => updateBotSessionTitle(sessionId, historySnapshot, "[QQ]"),
        onError: (phase, error) => {
          if (phase === "updateTitle") {
            console.warn("[QQBot] Failed to update session title:", error);
            return;
          }
          console.warn("[QQBot] Failed to persist conversation:", error);
        },
      });
    }
  }

  private async runClaudeQuery(
    system: string,
    userText: string,
    chatKey: string,
    provider: "claude" | "openai",
    sessionId: string,
    isGroup: boolean,
    isOwner: boolean,
    sensitiveTurnState: SharedMcpSensitiveTurnState,
    persistedMessages: StreamMessage[],
    c2cOpenId?: string,
    groupOpenId?: string,
    msgId?: string,
  ): Promise<string> {
    const historyKey = `${this.opts.assistantId}:${chatKey}`;
    const claudeSessionId = getBotClaudeSessionId(historyKey);

    const assistantConfig = (() => {
      const cfg = loadAssistantsConfig();
      return cfg.assistants.find((a) => a.id === this.opts.assistantId);
    })();

    const env = buildQueryEnv(assistantConfig);
    const sharedMcp = createSharedMcpServer({
      assistantId: this.opts.assistantId,
      sessionCwd: this.opts.defaultCwd,
      isOwner,
      sensitiveTurnState,
    });

    // Per-session MCP with send_file tool
    const self = this;
    const sendFileTool = tool(
      "send_file",
      "发送文件给用户。支持图片（png/jpg/gif）等。发送前系统会自动将最终成品归档到助理的 outputs 目录。",
      { file_path: z.string().describe("本地文件绝对路径") },
      async (input: { file_path: string }) => {
        try {
          const token = await getAccessToken(self.opts.appId, self.opts.clientSecret);
          const prepared = prepareVisibleArtifact(String(input.file_path ?? ""), {
            defaultCwd: self.opts.defaultCwd,
            assistantName: self.opts.assistantName,
            assistantId: self.opts.assistantId,
          });
          if (prepared.error) {
            return { content: [{ type: "text" as const, text: prepared.error }] };
          }

          const sendPath = prepared.filePath;
          const ext = sendPath.split(".").pop()?.toLowerCase() ?? "";
          const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext);

          if (isImage) {
            const fileBuffer = readFileSync(sendPath);
            const base64 = fileBuffer.toString("base64");
            if (isGroup && groupOpenId) {
              await sendGroupImageMessage(token, groupOpenId, base64, msgId);
            } else if (c2cOpenId) {
              await sendC2CImageMessage(token, c2cOpenId, base64, msgId);
            }
            return { content: [{ type: "text" as const, text: `已发送图片: ${basename(sendPath)}` }] };
          }

          return { content: [{ type: "text" as const, text: `QQ Bot 暂不支持发送此类文件: ${ext}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `发送失败: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );

    const sessionMcp = createSdkMcpServer({ name: "qq-session", tools: [sendFileTool] });

    const cwd = this.opts.defaultCwd || homedir();
    const claudeCodePath = getClaudeCodePath();

    const q = await runAgent(userText, {
      systemPrompt: system,
      resume: claudeSessionId,
      cwd,
      ...(provider === "claude" && { env }),
      ...(provider === "openai" && { openaiOverrides: buildOpenAIOverrides(assistantConfig, this.opts.model) }),
      pathToClaudeCodeExecutable: claudeCodePath,
      provider,
      mcpServers: { "vk-shared": sharedMcp, "qq-session": sessionMcp, ...loadMcporterServers() },
    });

    let finalText = "";
    let bufferedAssistant: StreamMessage | null = null;
    const persistStreamMessage = (streamMessage: StreamMessage) => {
      persistedMessages.push(streamMessage);
    };
    for await (const msg of q) {
      bufferedAssistant = bufferPersistedBotMessage(
        msg as StreamMessage,
        bufferedAssistant,
        persistStreamMessage,
      );
      const m = msg as Record<string, unknown>;
      if (m.type === "result" && m.subtype === "success") {
        finalText = m.result as string;
        if (!sensitiveTurnState.active) {
          setBotClaudeSessionId(historyKey, m.session_id as string);
        }
      } else {
        const partial = extractPartialText(m);
        if (partial) finalText = partial;
      }
    }

    flushBufferedBotAssistantMessage(bufferedAssistant, persistStreamMessage);

    return finalText || "（无回复）";
  }

  private async deliverReply(
    replyText: string,
    isGroup: boolean,
    c2cOpenId?: string,
    groupOpenId?: string,
    msgId?: string,
  ): Promise<void> {
    const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);

    const segments = parseReplySegments(replyText);
    const hasImages = segments.some((s) => s.kind === "image");

    if (hasImages) {
      for (const seg of segments) {
        if (seg.kind === "text") {
          const text = seg.content.trim();
          if (!text) continue;
          for (const chunk of chunkMessage(text)) {
            try {
              if (isGroup && groupOpenId) {
                await sendGroupMessage(token, groupOpenId, chunk, msgId);
              } else if (c2cOpenId) {
                await sendC2CMessage(token, c2cOpenId, chunk, msgId);
              }
            } catch (err) {
              console.error("[QQBot] Text segment send failed:", err);
            }
          }
        } else {
          try {
            const fileBuffer = readFileSync(seg.path);
            const base64 = fileBuffer.toString("base64");
            if (isGroup && groupOpenId) {
              await sendGroupImageMessage(token, groupOpenId, base64, msgId);
            } else if (c2cOpenId) {
              await sendC2CImageMessage(token, c2cOpenId, base64, msgId);
            }
          } catch (err) {
            console.error("[QQBot] Image send failed:", err);
            const fallback = `[图片: ${seg.path}]`;
            try {
              if (isGroup && groupOpenId) {
                await sendGroupMessage(token, groupOpenId, fallback, msgId);
              } else if (c2cOpenId) {
                await sendC2CMessage(token, c2cOpenId, fallback, msgId);
              }
            } catch { /* ignore */ }
          }
        }
      }
      return;
    }

    // Pure text response
    const chunks = chunkMessage(replyText);
    for (const chunk of chunks) {
      try {
        if (isGroup && groupOpenId) {
          await sendGroupMessage(token, groupOpenId, chunk, msgId);
        } else if (c2cOpenId) {
          await sendC2CMessage(token, c2cOpenId, chunk, msgId);
        }
      } catch (err) {
        console.error("[QQBot] Reply send failed:", err);
      }
    }
  }

  // ── Proactive messaging ─────────────────────────────────────────────────────

  async sendProactive(text: string, targets?: string[]): Promise<{ ok: boolean; error?: string }> {
    const openIds = targets?.length ? targets : (this.opts.ownerOpenIds ?? []);
    if (openIds.length === 0) {
      return { ok: false, error: "未指定接收者，请在配置中填写 ownerOpenIds，或先给机器人发一条消息" };
    }

    const errors: string[] = [];
    for (const openId of openIds) {
      try {
        const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
        const chunks = chunkMessage(text);
        for (const chunk of chunks) {
          // Proactive messages (no msg_id) use different API path format
          await qqApiRequest(token, "POST", `/v2/users/${openId}/messages`, {
            content: chunk,
            msg_type: 0,
          });
        }
      } catch (err) {
        errors.push(`${openId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === openIds.length) {
      return { ok: false, error: errors.join("; ") };
    }
    return { ok: true };
  }

}
