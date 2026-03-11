/**
 * DingTalk Stream Mode Bot Service
 *
 * Architecture (soimy/openclaw-channel-dingtalk inspired):
 * - Exponential backoff + jitter reconnection with configurable params
 * - AI Card streaming via Agent SDK (Claude tools + real-time card updates)
 * - AICardStatus state machine + token auto-refresh + 401 retry
 * - Card created BEFORE media download for immediate "思考中" feedback
 * - Per-session lock (prevents concurrent processing of same conversation)
 * - Inflight task registry for reconnect recovery
 * - Three-level fallback delivery: Card → sessionWebhook → Proactive API
 * - Active health check (5s interval, triggers reconnect on silent disconnect)
 * - Media handling: voice ASR passthrough, image download + vision, file description
 * - Access control: dmPolicy (open/allowlist), groupPolicy (open/allowlist), allowFrom
 * - Message deduplication by msgId (5-min TTL)
 */
import WebSocket from "ws";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EventEmitter } from "events";
import { networkInterfaces, homedir } from "os";
import { randomUUID } from "crypto";
import { loadUserSettings } from "./user-settings.js";
import { buildSmartMemoryContext, recordConversation } from "./memory-store.js";
import { patchAssistantBotOwnerIds, loadAssistantsConfig } from "./assistants-config.js";
import { getClaudeCodePath } from "./util.js";
import { promptOnce, runAgent } from "./agent-client.js";
import type { SessionStore } from "./session-store.js";
import { createSharedMcpServer } from "./shared-mcp.js";
import {
  type ConvMessage,
  FILE_PATH_RE,
  buildOpenAIOverrides,
  buildQueryEnv,
  buildStructuredPersona,
  buildHistoryContext,
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
  parseReplySegments,
  extractPartialText,
} from "./bot-base.js";
import { savePendingTask, removePendingTask, loadPendingTasks } from "./pending-tasks.js";

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.family === "IPv4") return iface.address;
    }
  }
  return "127.0.0.1";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type DingtalkBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface DingtalkBotOptions {
  // Core credentials
  appKey: string;
  appSecret: string;
  /** For Card API and media download — defaults to appKey */
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  // Identity
  assistantId: string;
  assistantName: string;
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  userContext?: string;
  // AI config
  provider?: "claude" | "openai";
  model?: string;
  defaultCwd?: string;
  // Reply mode
  messageType?: "markdown" | "card";
  cardTemplateId?: string;
  /** Card template content field key — defaults to "content" */
  cardTemplateKey?: string;
  // Access control
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  /** Allowlisted staff IDs (dmPolicy=allowlist) or conversationIds (groupPolicy=allowlist) */
  allowFrom?: string[];
  // Connection robustness
  /** Max reconnect attempts after initial connection (default: 10) */
  maxConnectionAttempts?: number;
  /** Initial reconnect delay in ms (default: 1000) */
  initialReconnectDelay?: number;
  /** Max reconnect delay in ms (default: 60000) */
  maxReconnectDelay?: number;
  /** Jitter factor 0–1 (default: 0.3) */
  reconnectJitter?: number;
  /**
   * Owner staff ID(s) for proactive push messages.
   * Used by sendProactiveDingtalkMessage() — e.g. notify yourself after a task completes.
   */
  ownerStaffIds?: string[];
}

interface StreamFrame {
  specVersion: string;
  type: string;
  headers: Record<string, string>;
  data: string;
}

/** Full DingTalk inbound message (Stream mode) */
interface DingtalkMessage {
  msgId?: string;
  msgtype: string;
  createAt?: number;
  conversationType: string;  // "1" = private, "2" = group
  conversationId?: string;
  conversationTitle?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime?: number;
  // Text
  text?: { content: string };
  // Media / rich content
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;  // Voice ASR result
    richText?: Array<{
      type: string;
      text?: string;
      atName?: string;
      downloadCode?: string;
    }>;
  };
}


/** Card lifecycle state — mirrors Openclaw AICardStatus */
export enum AICardStatus {
  PROCESSING = "PROCESSING",  // Created, waiting for first content
  INPUTING   = "INPUTING",    // Streaming in progress
  FINISHED   = "FINISHED",    // Finalized (isFinalize=true sent)
  FAILED     = "FAILED",      // Error, do not attempt further updates
}

interface AICardInstance {
  outTrackId: string;
  cardInstanceId: string;
  templateKey: string;
  /** Current access token — refreshed automatically when near expiry */
  accessToken: string;
  /** Fetches a fresh access token (closure over credentials — avoids storing appSecret) */
  refreshToken: () => Promise<string>;
  /** Conversation ID for proactive fallback delivery */
  conversationId: string;
  isGroup: boolean;
  createdAt: number;
  lastUpdated: number;
  state: AICardStatus;
  /** Last successfully streamed content — used for reconnect recovery */
  lastStreamedContent?: string;
}

// ─── DingTalk API helpers ─────────────────────────────────────────────────────

const DINGTALK_API = "https://api.dingtalk.com";

/** V2 access token cache (for api.dingtalk.com/v1.0/* endpoints) */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const resp = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey, appSecret, grantType: "client_credentials" }),
  });
  if (!resp.ok) throw new Error(`DingTalk token fetch failed: HTTP ${resp.status}`);

  const data = (await resp.json()) as { accessToken?: string; expireIn?: number };
  if (!data.accessToken) throw new Error("DingTalk token response missing accessToken");

  tokenCache.set(appKey, {
    token: data.accessToken,
    expiresAt: Date.now() + (data.expireIn ?? 7200) * 1000,
  });
  return data.accessToken;
}

/** V1 access token cache (for oapi.dingtalk.com/* endpoints, e.g. media/upload) */
const tokenCacheV1 = new Map<string, { token: string; expiresAt: number }>();

async function getAccessTokenV1(appKey: string, appSecret: string): Promise<string> {
  const cached = tokenCacheV1.get(appKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const resp = await fetch(
    `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`,
  );
  if (!resp.ok) throw new Error(`DingTalk V1 token fetch failed: HTTP ${resp.status}`);

  const data = (await resp.json()) as { errcode?: number; access_token?: string; expires_in?: number };
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`DingTalk V1 token error: ${JSON.stringify(data)}`);
  }

  tokenCacheV1.set(appKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  });
  return data.access_token;
}

/**
 * Upload a file to DingTalk's media server using the old V1 API.
 * Returns media_id on success, null on failure.
 */
async function uploadMediaV1(
  appKey: string,
  appSecret: string,
  filePath: string,
  mediaType: "image" | "voice" | "video" | "file",
): Promise<string | null> {
  const fs = await import("fs");
  const path = await import("path");

  try {
    const token = await getAccessTokenV1(appKey, appSecret);
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileName = path.basename(filePath);
    const fileExt = path.extname(fileName).toLowerCase();
    const mimeByExt: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".amr": "audio/amr",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
    };
    const contentType = mimeByExt[fileExt] ?? "application/octet-stream";
    const boundary = `----DT${Date.now()}`;
    const CRLF = "\r\n";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="media"; filename="${fileName}"${CRLF}` +
        `Content-Type: ${contentType}${CRLF}${CRLF}`,
      ),
      fileBuffer,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
    ]);

    const resp = await fetch(
      `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      },
    );

    const data = (await resp.json()) as { errcode?: number; media_id?: string; errmsg?: string };
    if (data.errcode !== 0 || !data.media_id) {
      console.error(`[DingTalk] Media upload V1 failed: ${JSON.stringify(data)}`);
      return null;
    }
    console.log(`[DingTalk] Media uploaded (V1): ${data.media_id}`);
    return data.media_id;
  } catch (err) {
    console.error("[DingTalk] Media upload V1 error:", err);
    return null;
  }
}

// ─── Card content formatting ──────────────────────────────────────────────────

const THINKING_TRUNCATE = 500;

function formatThinkingForCard(thinking: string): string {
  const tail = thinking.length > THINKING_TRUNCATE
    ? thinking.slice(-THINKING_TRUNCATE)
    : thinking;
  const quoted = tail.split("\n").map((l) => `> ${l}`).join("\n");
  return `**正在思考...**\n${quoted}`;
}

// ─── Web utilities ────────────────────────────────────────────────────────────

async function createAICard(
  refreshTokenFn: () => Promise<string>,
  accessToken: string,
  robotCode: string,
  templateId: string,
  templateKey: string,
  msg: DingtalkMessage,
  initialContent: string,
): Promise<AICardInstance> {
  const outTrackId = randomUUID();
  const isGroup = msg.conversationType === "2";
  const conversationId = isGroup
    ? (msg.conversationId ?? "")
    : (msg.senderStaffId ?? msg.senderId ?? "");

  const openSpaceId = isGroup
    ? `dtv1.card//IM_GROUP.${conversationId}`
    : `dtv1.card//IM_ROBOT.${conversationId}`;

  const payload = {
    cardTemplateId: templateId,
    outTrackId,
    openSpaceId,
    callbackType: "STREAM",
    imGroupOpenSpaceModel: { supportForward: true },
    imRobotOpenSpaceModel: { supportForward: true },
    imGroupOpenDeliverModel: isGroup
      ? { robotCode }
      : undefined,
    imRobotOpenDeliverModel: !isGroup
      ? { spaceType: "IM_ROBOT", robotCode }
      : undefined,
    cardData: { cardParamMap: { [templateKey]: initialContent } },
    userIdType: 1,
  };

  const resp = await fetch(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Card create failed HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return {
    outTrackId,
    cardInstanceId: outTrackId,
    templateKey,
    accessToken,
    refreshToken: refreshTokenFn,
    conversationId,
    isGroup,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    state: AICardStatus.PROCESSING,
  };
}

/** Token age threshold before proactive refresh (90 minutes, matching Openclaw) */
const CARD_TOKEN_REFRESH_THRESHOLD_MS = 90 * 60 * 1000;

async function streamAICard(
  card: AICardInstance,
  content: string,
  isFinalize: boolean,
): Promise<void> {
  // Skip if already in terminal state
  if (card.state === AICardStatus.FINISHED || card.state === AICardStatus.FAILED) {
    return;
  }

  // Proactively refresh token if it's near expiry (90-minute threshold)
  if (Date.now() - card.createdAt > CARD_TOKEN_REFRESH_THRESHOLD_MS) {
    try {
      card.accessToken = await card.refreshToken();
      card.createdAt = Date.now();
    } catch (e) {
      console.warn("[DingTalk] Card token refresh failed:", (e as Error).message);
    }
  }

  const body = JSON.stringify({
    outTrackId: card.outTrackId,
    guid: randomUUID(),
    key: card.templateKey,
    content,
    isFull: true,
    isFinalize,
    isError: false,
  });

  const doRequest = async (token: string): Promise<Response> =>
    fetch(`${DINGTALK_API}/v1.0/card/streaming`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
      body,
    });

  let resp = await doRequest(card.accessToken);

  // 401: refresh token and retry once (Openclaw pattern)
  if (resp.status === 401) {
    console.warn("[DingTalk] Card stream 401, refreshing token and retrying...");
    try {
      card.accessToken = await card.refreshToken();
      resp = await doRequest(card.accessToken);
    } catch (e) {
      console.error("[DingTalk] Card token refresh after 401 failed:", (e as Error).message);
      card.state = AICardStatus.FAILED;
      card.lastUpdated = Date.now();
      throw e;
    }
  }

  const respBody = await resp.text().catch(() => "");
  if (!resp.ok) {
    card.state = AICardStatus.FAILED;
    card.lastUpdated = Date.now();
    throw new Error(`Card stream update failed HTTP ${resp.status}: ${respBody.slice(0, 200)}`);
  }

  // Check response body for silent errors
  try {
    const parsed = JSON.parse(respBody);
    if (parsed.errcode && parsed.errcode !== 0) {
      console.warn(`[DingTalk] Card stream accepted but errcode=${parsed.errcode}: ${parsed.errmsg ?? respBody.slice(0, 200)}`);
    }
  } catch { /* non-JSON body is fine */ }

  if (isFinalize) {
    console.log(`[DingTalk] Card finalized: ${card.outTrackId} (${content.length} chars)`);
  }

  card.lastStreamedContent = content;
  card.lastUpdated = Date.now();
  if (isFinalize) {
    card.state = AICardStatus.FINISHED;
  } else if (card.state === AICardStatus.PROCESSING) {
    card.state = AICardStatus.INPUTING;
  }
}

// ─── Inflight task registry ───────────────────────────────────────────────────

/**
 * Tracks an in-progress AI generation so it can be recovered after a WebSocket
 * reconnect. Stored per-connection, keyed by msgId.
 */
interface InflightTask {
  /** Pre-created card instance (null for markdown mode) */
  card: AICardInstance | null;
  /** Accumulated AI content so far — updated during streaming */
  accumulatedContent: string;
  /** Original DingTalk message for fallback webhook / proactive delivery */
  msg: DingtalkMessage;
  startedAt: number;
}

/** Download a media file from DingTalk and save to a temp file; returns the local path */
async function downloadMediaToTempFile(
  appKey: string,
  appSecret: string,
  robotCode: string,
  downloadCode: string,
  originalName?: string,
): Promise<string | null> {
  try {
    const token = await getAccessToken(appKey, appSecret);
    const infoResp = await fetch(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      {
        method: "POST",
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ downloadCode, robotCode }),
      },
    );
    if (!infoResp.ok) {
      const body = await infoResp.text().catch(() => "");
      console.error(`[DingTalk] Image download info failed: HTTP ${infoResp.status} — ${body.slice(0, 200)}`);
      return null;
    }

    const info = (await infoResp.json()) as { downloadUrl?: string };
    const url = info.downloadUrl;
    if (!url) {
      console.error(`[DingTalk] Image download info returned no downloadUrl:`, JSON.stringify(info).slice(0, 200));
      return null;
    }

    const fileResp = await fetch(url);
    if (!fileResp.ok) {
      console.error(`[DingTalk] Image file fetch failed: HTTP ${fileResp.status}`);
      return null;
    }

    const buffer = Buffer.from(await fileResp.arrayBuffer());

    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    let fileName: string;
    if (originalName) {
      const safeName = originalName.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
      fileName = `vk-dt-${Date.now()}-${safeName}`;
    } else {
      const contentType = fileResp.headers.get("content-type") ?? "image/jpeg";
      const ext = contentType.split(";")[0].trim().split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
      fileName = `vk-dt-${Date.now()}.${ext}`;
    }

    const tmpPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[DingTalk] File saved to temp file: ${tmpPath} (${(buffer.length / 1024).toFixed(1)}KB)`);
    return tmpPath;
  } catch (err) {
    console.error(`[DingTalk] Image download exception:`, err);
    return null;
  }
}

// ─── Conversation history context (delegated to bot-base, with DingTalk file-path strip) ───

/** DingTalk: enable stripUserFilePaths to clean temp paths from user message history. */
function buildHistoryContextDt(history: ConvMessage[], assistantId?: string): string {
  return buildHistoryContext(history, assistantId, true);
}

// ─── Message deduplication ────────────────────────────────────────────────────

const processedMsgs = new Map<string, number>();

function isDuplicate(key: string): boolean { return isDuplicateMsg(key, processedMsgs); }
function markProcessed(key: string): void { markProcessedMsg(key, processedMsgs); }

// ─── Peer-ID registry ────────────────────────────────────────────────────────
// DingTalk conversationIds are base64-encoded and case-sensitive.
// The framework may lowercase session keys internally, so we preserve originals.

const peerIdMap = new Map<string, string>();

function registerPeerId(originalId: string): void {
  if (!originalId) return;
  peerIdMap.set(originalId.toLowerCase(), originalId);
}

function resolveOriginalPeerId(id: string): string {
  if (!id) return id;
  return peerIdMap.get(id.toLowerCase()) ?? id;
}

// ─── Last-seen conversations ──────────────────────────────────────────────────
// Tracks every conversation (private or group) that has interacted with each bot.
// Used as automatic fallback targets for proactive sends (scenario 2).

interface LastSeenEntry {
  target: string;       // staffId (private) or conversationId (group)
  isGroup: boolean;
  lastSeenAt: number;
}

// key: assistantId → Map<target, entry>
const lastSeenConversations = new Map<string, Map<string, LastSeenEntry>>();

function recordLastSeen(assistantId: string, target: string, isGroup: boolean): void {
  if (!assistantId || !target) return;
  let byAssistant = lastSeenConversations.get(assistantId);
  if (!byAssistant) {
    byAssistant = new Map();
    lastSeenConversations.set(assistantId, byAssistant);
  }
  byAssistant.set(target, { target, isGroup, lastSeenAt: Date.now() });
}

/** Return all targets that have ever chatted with this bot, newest first */
export function getLastSeenTargets(assistantId: string): LastSeenEntry[] {
  const byAssistant = lastSeenConversations.get(assistantId);
  if (!byAssistant) return [];
  return Array.from(byAssistant.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// ─── Proactive-risk registry ──────────────────────────────────────────────────
// Tracks targets where proactive send failed with a permission error.
// High-risk targets are skipped for 7 days to avoid repeated failure noise.

type ProactiveRiskLevel = "low" | "medium" | "high";

interface ProactiveRiskEntry {
  level: ProactiveRiskLevel;
  reason: string;
  observedAtMs: number;
}

const PROACTIVE_RISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const proactiveRiskStore = new Map<string, ProactiveRiskEntry>();

function proactiveRiskKey(accountId: string, targetId: string): string {
  return `${accountId}:${targetId.trim()}`;
}

function recordProactiveRisk(accountId: string, targetId: string, reason: string): void {
  if (!accountId || !targetId.trim()) return;
  proactiveRiskStore.set(proactiveRiskKey(accountId, targetId), {
    level: "high",
    reason,
    observedAtMs: Date.now(),
  });
}

function getProactiveRisk(accountId: string, targetId: string): ProactiveRiskEntry | null {
  if (!accountId || !targetId.trim()) return null;
  const key = proactiveRiskKey(accountId, targetId);
  const entry = proactiveRiskStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.observedAtMs > PROACTIVE_RISK_TTL_MS) {
    proactiveRiskStore.delete(key);
    return null;
  }
  return entry;
}

function clearProactiveRisk(accountId: string, targetId: string): void {
  proactiveRiskStore.delete(proactiveRiskKey(accountId, targetId));
}

function isProactivePermissionError(code: string | null): boolean {
  if (!code) return false;
  return (
    code.startsWith("Forbidden.AccessDenied") ||
    code === "invalidParameter.userIds.invalid" ||
    code === "invalidParameter.userIds.empty" ||
    code === "invalidParameter.openConversationId.invalid" ||
    code === "invalidParameter.robotCode.empty"
  );
}

function extractErrorCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.code === "string" && d.code.trim()) return d.code.trim();
  if (typeof d.subCode === "string" && d.subCode.trim()) return d.subCode.trim();
  return null;
}

// ─── Access control ───────────────────────────────────────────────────────────

function isAllowed(msg: DingtalkMessage, opts: DingtalkBotOptions): boolean {
  const isGroup = msg.conversationType === "2";

  if (isGroup) {
    if ((opts.groupPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      if (!msg.conversationId || !allowed.includes(msg.conversationId)) {
        console.log(`[DingTalk] Group ${msg.conversationId} blocked by groupPolicy=allowlist`);
        return false;
      }
    }
  } else {
    if ((opts.dmPolicy ?? "open") === "allowlist") {
      const allowed = opts.allowFrom ?? [];
      const uid = msg.senderStaffId ?? msg.senderId;
      if (!uid || !allowed.includes(uid)) {
        console.log(`[DingTalk] User ${uid} blocked by dmPolicy=allowlist`);
        return false;
      }
    }
  }
  return true;
}

// ─── Message content extraction ───────────────────────────────────────────────

async function extractContent(
  msg: DingtalkMessage,
  opts: DingtalkBotOptions,
): Promise<{ text: string; filePaths?: string[] }> {
  const rc = opts.robotCode ?? opts.appKey;

  /** Download helper — logs a warn on missing inputs instead of silently skipping */
  async function tryDownload(dc: string | undefined, label: string): Promise<string | null> {
    if (!dc) {
      console.warn(`[DingTalk] ${label}: missing downloadCode`);
      return null;
    }
    if (!rc) {
      console.warn(`[DingTalk] ${label}: robotCode is empty (appKey=${opts.appKey})`);
      return null;
    }
    return downloadMediaToTempFile(opts.appKey, opts.appSecret, rc, dc);
  }

  if (msg.msgtype === "text") {
    // Strip @bot mention prefix in group chats
    const raw = msg.text?.content ?? "";
    const clean = raw.replace(/^@\S+\s*/, "").trim();
    return { text: clean || "[空消息]" };
  }

  if (msg.msgtype === "voice" || msg.msgtype === "audio") {
    const asr = msg.content?.recognition;
    const tmpPath = await tryDownload(msg.content?.downloadCode, "voice");
    if (tmpPath) {
      const textPart = asr ? `[语音] ${asr}` : "用户发来了一条语音消息";
      return { text: textPart, filePaths: [tmpPath] };
    }
    return { text: asr ? `[语音] ${asr}` : "[语音消息（无识别文本）]" };
  }

  if (msg.msgtype === "picture" || msg.msgtype === "image") {
    const tmpPath = await tryDownload(msg.content?.downloadCode, "picture");
    if (tmpPath) {
      return { text: "用户发来了一张图片", filePaths: [tmpPath] };
    }
    return { text: "[图片消息]" };
  }

  if (msg.msgtype === "file") {
    const fileName = msg.content?.fileName ?? "未知文件";
    const dc = msg.content?.downloadCode;
    const tmpPath = dc && rc
      ? await downloadMediaToTempFile(opts.appKey, opts.appSecret, rc, dc, fileName)
      : null;
    if (tmpPath) {
      return { text: `用户发来了一个文件：${fileName}`, filePaths: [tmpPath] };
    }
    return { text: `[文件: ${fileName}]` };
  }

  if (msg.msgtype === "video") {
    const tmpPath = await tryDownload(msg.content?.downloadCode, "video");
    if (tmpPath) {
      return { text: "用户发来了一段视频", filePaths: [tmpPath] };
    }
    return { text: "[视频消息]" };
  }

  if (msg.msgtype === "richText" && msg.content?.richText) {
    const parts: string[] = [];
    const filePaths: string[] = [];
    for (const part of msg.content.richText) {
      if (part.type === "text" && part.text) {
        parts.push(part.text);
      } else if (part.type === "picture" && rc) {
        const tmpPath = await tryDownload(part.downloadCode, "richText.picture");
        if (tmpPath) {
          filePaths.push(tmpPath);
        } else {
          parts.push("[图片下载失败]");
        }
      } else if (part.type === "at" && part.atName) {
        // skip @mentions
      }
    }
    return { text: parts.join("").trim() || "[富文本消息]", filePaths: filePaths.length > 0 ? filePaths : undefined };
  }

  // Fallback
  const raw = msg.text?.content ?? "";
  return { text: raw.trim() || `[${msg.msgtype} 消息]` };
}

// ─── Status emitter ───────────────────────────────────────────────────────────

const statusEmitter = new EventEmitter();

export function onDingtalkBotStatusChange(
  cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", cb);
  return () => statusEmitter.off("status", cb);
}

function emit(assistantId: string, status: DingtalkBotStatus, detail?: string) {
  statusEmitter.emit("status", assistantId, status, detail);
}

// ─── Session update emitter ───────────────────────────────────────────────────

const sessionUpdateEmitter = new EventEmitter();

/** Subscribe to session title/status updates from the DingTalk bot. */
export function onDingtalkSessionUpdate(
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

export function setSessionStore(store: SessionStore): void {
  sessionStore = store;
}

// ─── Connection pool ──────────────────────────────────────────────────────────

const pool = new Map<string, DingtalkConnection>();

export async function startDingtalkBot(opts: DingtalkBotOptions): Promise<void> {
  stopDingtalkBot(opts.assistantId);
  const conn = new DingtalkConnection(opts);
  pool.set(opts.assistantId, conn);
  await conn.start();
}

export function stopDingtalkBot(assistantId: string): void {
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
  emit(assistantId, "disconnected");
}

export function getDingtalkBotStatus(assistantId: string): DingtalkBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

/** Returns the first assistantId that has a connected DingTalk bot, or null. */
export function getAnyConnectedDingtalkAssistantId(): string | null {
  for (const [id, conn] of pool.entries()) {
    if (conn.status === "connected") return id;
  }
  return null;
}

/** Update runtime config of a running bot without restarting the connection. */
export function updateDingtalkBotConfig(
  assistantId: string,
  updates: Partial<Pick<DingtalkBotOptions, "provider" | "model" | "persona" | "coreValues" | "relationship" | "cognitiveStyle" | "operatingGuidelines" | "userContext" | "assistantName" | "defaultCwd" | "messageType" | "cardTemplateId" | "cardTemplateKey" | "dmPolicy" | "groupPolicy" | "allowFrom">>,
): void {
  const conn = pool.get(assistantId);
  if (!conn) return;
  Object.assign(conn.opts, updates);
  console.log(`[DingTalk] Config updated for assistant=${assistantId}:`, updates);
}

// ─── Proactive (outbound) messaging ──────────────────────────────────────────

export interface SendProactiveOptions {
  /**
   * Explicit target(s) to send to. Supports:
   *  - staffId / userId  → private message (oToMessages/batchSend)
   *  - conversationId starting with "cid" → group message (groupMessages/send)
   *  - "user:<staffId>" or "group:<conversationId>" prefix to force type
   * Falls back to ownerStaffIds from bot config when omitted.
   */
  targets?: string[];
  title?: string;
}

export interface SendProactiveMediaOptions extends SendProactiveOptions {
  mediaType?: "image" | "voice" | "video" | "file";
}

/** @internal strip user:/group: prefix and detect explicit type */
function stripTargetPrefix(target: string): { targetId: string; isExplicitUser: boolean } {
  if (target.startsWith("user:")) return { targetId: target.slice(5), isExplicitUser: true };
  if (target.startsWith("group:")) return { targetId: target.slice(6), isExplicitUser: false };
  return { targetId: target, isExplicitUser: false };
}

/** @internal detect markdown by content heuristics (same as soimy) */
function isMarkdownText(text: string): boolean {
  return /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
}

/** @internal core proactive send for a single resolved target */
async function sendProactiveToTarget(
  botOpts: DingtalkBotOptions,
  target: string,
  text: string,
  title: string,
): Promise<void> {
  const token = await getAccessToken(botOpts.appKey, botOpts.appSecret);
  const robotCode = botOpts.robotCode ?? botOpts.appKey;
  const { targetId: rawId, isExplicitUser } = stripTargetPrefix(target);
  const targetId = resolveOriginalPeerId(rawId);
  const isGroup = !isExplicitUser && targetId.startsWith("cid");

  const useMarkdown = isMarkdownText(text);
  const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
  const msgParam = useMarkdown
    ? JSON.stringify({ title, text })
    : JSON.stringify({ content: text });

  const url = isGroup
    ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
    : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

  const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
  if (isGroup) {
    payload.openConversationId = targetId;
  } else {
    payload.userIds = [targetId];
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let errData: unknown;
    try { errData = JSON.parse(errText); } catch { errData = null; }
    const errCode = extractErrorCode(errData);

    if (isProactivePermissionError(errCode)) {
      recordProactiveRisk(botOpts.assistantId, targetId, errCode ?? "permission-error");
    }
    throw new Error(`HTTP ${resp.status} code=${errCode ?? "?"}: ${errText.slice(0, 200)}`);
  }

  clearProactiveRisk(botOpts.assistantId, targetId);
  console.log(`[DingTalk] Proactive send OK → ${isGroup ? "group" : "user"} ${targetId}`);
}

/**
 * Proactively send a text/markdown message to DingTalk.
 *
 * Target resolution priority:
 *  1. opts.targets — explicit list (staffId, conversationId, or user:/group: prefix)
 *  2. ownerStaffIds — configured on the bot
 *
 * Targets flagged as "high risk" (past permission failures) are skipped to avoid
 * log spam, similar to soimy's proactive-risk-registry behaviour.
 */
export async function sendProactiveDingtalkMessage(
  assistantId: string,
  text: string,
  opts?: SendProactiveOptions,
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `钉钉 Bot (${assistantId}) 未连接` };
  }

  const botOpts = conn.getOptions();

  let rawTargets: string[];
  if (opts?.targets?.length) {
    rawTargets = opts.targets;
  } else if (botOpts.ownerStaffIds?.length) {
    rawTargets = botOpts.ownerStaffIds;
  } else {
    // Scenario 2: fall back to every conversation that has chatted with this bot
    const lastSeen = getLastSeenTargets(assistantId);
    if (lastSeen.length === 0) {
      return {
        ok: false,
        error:
          "未指定接收者，也未配置 ownerStaffIds，且该 Bot 尚未收到过任何消息。" +
          "请先让对方发一条消息，或在配置中填写 ownerStaffIds。",
      };
    }
    rawTargets = lastSeen.map((e) => e.target);
    console.log(
      `[DingTalk] Proactive: auto-targeting ${rawTargets.length} last-seen conversation(s): ${rawTargets.join(", ")}`,
    );
  }

  const titleFallback = opts?.title ?? botOpts.assistantName;
  const title = isMarkdownText(text)
    ? text.split("\n")[0].replace(/^[#*\s>-]+/, "").slice(0, 20) || titleFallback
    : titleFallback;

  const errors: string[] = [];
  for (const target of rawTargets) {
    const { targetId: rawId } = stripTargetPrefix(target);
    const resolvedId = resolveOriginalPeerId(rawId);
    const risk = getProactiveRisk(assistantId, resolvedId);
    if (risk?.level === "high") {
      console.warn(`[DingTalk] Skipping high-risk target ${resolvedId}: ${risk.reason}`);
      errors.push(`${resolvedId}: skipped (high-risk: ${risk.reason})`);
      continue;
    }

    try {
      await sendProactiveToTarget(botOpts, target, text, title);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[DingTalk] Proactive send failed for ${target}: ${msg}`);
      errors.push(`${target}: ${msg}`);
    }
  }

  if (errors.length === rawTargets.length) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true };
}

/**
 * Upload a local file to DingTalk's media server and then send it proactively.
 * Supports image / voice / video / file (doc, pdf, etc.).
 *
 * Uses the old V1 upload API (oapi.dingtalk.com/media/upload) which returns a
 * media_id that can then be embedded in a proactive message.
 */
export async function sendProactiveMediaDingtalk(
  assistantId: string,
  filePath: string,
  opts?: SendProactiveMediaOptions,
): Promise<{ ok: boolean; error?: string }> {
  const conn = pool.get(assistantId);
  if (!conn) {
    return { ok: false, error: `钉钉 Bot (${assistantId}) 未连接` };
  }

  const botOpts = conn.getOptions();

  let rawTargets: string[];
  if (opts?.targets?.length) {
    rawTargets = opts.targets;
  } else if (botOpts.ownerStaffIds?.length) {
    rawTargets = botOpts.ownerStaffIds;
  } else {
    const lastSeen = getLastSeenTargets(assistantId);
    if (lastSeen.length === 0) {
      return {
        ok: false,
        error: "未指定接收者，也未配置 ownerStaffIds，且该 Bot 尚未收到过任何消息。",
      };
    }
    rawTargets = lastSeen.map((e) => e.target);
  }

  // Detect media type from extension if not specified
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const detectedType: "image" | "voice" | "video" | "file" =
    opts?.mediaType ??
    (["jpg", "jpeg", "png", "gif", "bmp"].includes(ext)
      ? "image"
      : ["mp3", "amr", "wav"].includes(ext)
      ? "voice"
      : ["mp4", "avi", "mov"].includes(ext)
      ? "video"
      : "file");

  const SIZE_LIMITS: Record<string, number> = {
    image: 20 * 1024 * 1024,
    voice: 2 * 1024 * 1024,
    video: 20 * 1024 * 1024,
    file: 20 * 1024 * 1024,
  };

  // Check file size before uploading
  const fs = await import("fs");
  const path = await import("path");

  let fileSize: number;
  try {
    const stat = await fs.promises.stat(filePath);
    fileSize = stat.size;
  } catch {
    return { ok: false, error: `文件不存在或无权访问: ${filePath}` };
  }

  if (fileSize > SIZE_LIMITS[detectedType]) {
    return {
      ok: false,
      error: `文件过大: ${(fileSize / 1024 / 1024).toFixed(1)}MB 超过 ${detectedType} 限制`,
    };
  }

  // Upload to DingTalk media server (must use V1 token for oapi.dingtalk.com)
  const mediaId = await uploadMediaV1(botOpts.appKey, botOpts.appSecret, filePath, detectedType);
  if (!mediaId) {
    return { ok: false, error: "媒体上传失败，请检查应用权限（oapi.dingtalk.com/media/upload）" };
  }

  // Send to each target
  const robotCode = botOpts.robotCode ?? botOpts.appKey;
  const errors: string[] = [];

  for (const target of rawTargets) {
    const { targetId: rawId, isExplicitUser } = stripTargetPrefix(target);
    const targetId = resolveOriginalPeerId(rawId);
    const isGroup = !isExplicitUser && targetId.startsWith("cid");

    const url = isGroup
      ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
      : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

    // soimy pattern: for sampleImageMsg, pass mediaId directly as photoURL.
    // DingTalk V2 proactive API accepts media_id (@lA...) in photoURL field.
    let msgKey: string;
    let msgParam: string;
    const fileName2 = filePath.split("/").pop() ?? "file";
    if (detectedType === "voice") {
      msgKey = "sampleAudio";
      msgParam = JSON.stringify({ mediaId, duration: "0" });
    } else if (detectedType === "image") {
      msgKey = "sampleImageMsg";
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else {
      const fileExt = ext || (detectedType === "video" ? "mp4" : "bin");
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName: fileName2, fileType: fileExt });
    }

    const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
    if (isGroup) {
      payload.openConversationId = targetId;
    } else {
      payload.userIds = [targetId];
    }

    try {
      const token = await getAccessToken(botOpts.appKey, botOpts.appSecret);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[DingTalk] Proactive send fail (${resp.status}) msgKey=${msgKey}: ${errText.slice(0, 200)}`);
      }

      if (!resp.ok) {
        const errText = await resp.text();
        let errData: unknown;
        try { errData = JSON.parse(errText); } catch { errData = null; }
        const errCode = extractErrorCode(errData);
        if (isProactivePermissionError(errCode)) {
          recordProactiveRisk(botOpts.assistantId, targetId, errCode ?? "permission-error");
        }
        throw new Error(`HTTP ${resp.status} code=${errCode ?? "?"}: ${errText.slice(0, 200)}`);
      }
      clearProactiveRisk(botOpts.assistantId, targetId);
      console.log(`[DingTalk] Proactive media sent → ${isGroup ? "group" : "user"} ${targetId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${target}: ${msg}`);
    }
  }

  if (errors.length === rawTargets.length) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true };
}

/**
 * Broadcast a message to the owner of every connected bot.
 * Useful for app-level notifications (e.g. task completed).
 */
export async function broadcastDingtalkMessage(
  text: string,
  opts?: SendProactiveOptions,
): Promise<void> {
  for (const [assistantId] of pool) {
    await sendProactiveDingtalkMessage(assistantId, text, opts).catch((err) =>
      console.error(`[DingTalk] Broadcast failed for ${assistantId}:`, err),
    );
  }
}

// ─── Conversation history & session management ────────────────────────────────

const histories = new Map<string, ConvMessage[]>();
const MAX_TURNS = 10;
const botSessionIds = new Map<string, string>();
/** sessionId → number of times the title has been (re)generated */
const titledSessions = new Map<string, number>();

function getHistory(assistantId: string): ConvMessage[] {
  if (!histories.has(assistantId)) histories.set(assistantId, []);
  return histories.get(assistantId)!;
}

function getBotSession(
  assistantId: string,
  assistantName: string,
  provider: "claude" | "openai",
  model: string | undefined,
  cwd: string | undefined,
): string {
  if (!sessionStore) throw new Error("[DingTalk] SessionStore not injected");
  const existingId = botSessionIds.get(assistantId);
  if (existingId && sessionStore.getSession(existingId)) return existingId;
  const session = sessionStore.createSession({
    title: `[钉钉] ${assistantName}`,
    assistantId,
    provider,
    model,
    cwd,
  });
  botSessionIds.set(assistantId, session.id);
  return session.id;
}

/**
 * Asynchronously generate and update a session title using Agent SDK.
 * Re-runs on turn 1 and turn 3 so the title improves as context grows.
 * @param sessionId  - DB session ID
 * @param history    - current full conversation history (user + assistant turns)
 * @param prefix     - channel prefix, e.g. "[钉钉]"
 */
async function updateBotSessionTitle(
  sessionId: string,
  history: ConvMessage[],
  prefix = "[钉钉]",
): Promise<void> {
  const turns = Math.floor(history.length / 2); // each turn = user + assistant
  const prevCount = titledSessions.get(sessionId) ?? 0;

  // Update on turn 1 (after first exchange) and turn 3 (with richer context)
  const shouldUpdate = turns === 1 || (turns === 3 && prevCount < 2);
  if (!shouldUpdate) return;
  titledSessions.set(sessionId, prevCount + 1);

  // Build a compact context from the last 3 turns for the prompt
  const recentTurns = history.slice(-6); // up to 3 user+assistant pairs
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
    console.log(`[DingTalk] Session title updated (turn ${turns}): "${title}"`);
  } catch (err) {
    console.warn(`[DingTalk] Title generation failed:`, err);
    if (prevCount === 0) {
      emitSessionUpdate(sessionId, { title: `${prefix} ${fallback}` });
    }
  }
}

// (Anthropic client cache removed — Card mode now uses Agent SDK via runClaudeCard)

// ─── Claude session ID registry (for query() resume) ─────────────────────────

/** Maps assistantId → Claude SDK session ID for conversation resume */
const botClaudeSessionIds = new Map<string, string>();

function getBotClaudeSessionId(assistantId: string): string | undefined {
  return botClaudeSessionIds.get(assistantId);
}

function setBotClaudeSessionId(assistantId: string, claudeSessionId: string): void {
  botClaudeSessionIds.set(assistantId, claudeSessionId);
  const appSessionId = botSessionIds.get(assistantId);
  if (appSessionId && sessionStore) {
    sessionStore.updateSession(appSessionId, { claudeSessionId });
  }
}

// ─── DingtalkConnection ───────────────────────────────────────────────────────

class DingtalkConnection {
  status: DingtalkBotStatus = "disconnected";
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private everConnected = false;
  private reconnectAttempts = 0;

  /** In-flight message IDs (per-instance) — prevents parallel processing of the same message */
  private inflight = new Set<string>();
  /** Inbound message counters for observability */
  private inboundStats = { received: 0, processed: 0, skipped: 0 };

  /** Active health check interval — detects silent disconnects */
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private consecutiveUnhealthy = 0;
  /** Timestamp of last received WebSocket frame (PING/CALLBACK/pong). */
  private lastFrameTime = 0;
  /** Client-side keepalive timer — sends WebSocket pings to prevent NAT/proxy timeout */
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  /** Maps sessionKey → pending lock promise for per-conversation serialization */
  private sessionLocks = new Map<string, Promise<void>>();

  /** In-progress AI tasks — enables reconnect recovery */
  private inflightTasks = new Map<string, InflightTask>();

  /** True after the first successful connect has recovered persisted tasks */
  private hasRecoveredPersistedTasks = false;

  constructor(public opts: DingtalkBotOptions) {}

  getOptions(): DingtalkBotOptions {
    return this.opts;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.everConnected = false;
    this.reconnectAttempts = 0;
    try {
      await this.connect();
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
    this.stopHealthCheck();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.status = "disconnected";
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    this.status = "connecting";
    emit(this.opts.assistantId, "connecting");

    const resp = await fetch(`${DINGTALK_API}/v1.0/gateway/connections/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.opts.appKey,
        clientSecret: this.opts.appSecret,
        subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }],
        ua: "dingtalk-stream-sdk-nodejs/1.1.0",
        localIp: getLocalIp(),
      }),
    });

    const bodyText = await resp.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(`网关返回非 JSON 响应 (HTTP ${resp.status}): ${bodyText.slice(0, 200)}`);
    }

    if (!resp.ok || body.code || !body.endpoint) {
      const code = (body.code as string | undefined) ?? resp.status;
      const msg =
        (body.message as string | undefined) ??
        (body.errmsg as string | undefined) ??
        bodyText.slice(0, 200);
      throw new Error(
        `网关连接失败 [${code}]: ${msg}\n提示：请确认钉钉应用已开启「机器人」能力并选择「Stream 模式」。`,
      );
    }

    const { endpoint, ticket } = body as { endpoint: string; ticket: string };
    console.log(`[DingTalk] Gateway OK, endpoint=${endpoint}`);

    const wsUrl = endpoint.includes("?")
      ? `${endpoint}&ticket=${encodeURIComponent(ticket)}`
      : `${endpoint}?ticket=${encodeURIComponent(ticket)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { ticket },
        perMessageDeflate: false,
        followRedirects: true,
      });
      this.ws = ws;

      const onOpen = () => {
        ws.off("error", onError);
        this.everConnected = true;
        this.reconnectAttempts = 0;
        this.status = "connected";
        emit(this.opts.assistantId, "connected");
        console.log(`[DingTalk] Connected: assistant=${this.opts.assistantId}`);

        // Pre-warm access token for Card API
        getAccessToken(this.opts.appKey, this.opts.appSecret)
          .catch((e) => console.warn("[DingTalk] Token pre-warm failed:", (e as Error).message));

        // Start active health check
        this.startHealthCheck();

        // Drain any tasks that were pending before reconnect
        this.drainInflightTasks().catch((e) =>
          console.warn("[DingTalk] Drain inflight failed:", (e as Error).message),
        );

        // On first connect after app start, recover persisted pending tasks
        if (!this.hasRecoveredPersistedTasks) {
          this.hasRecoveredPersistedTasks = true;
          this.recoverPersistedTasks().catch((e) =>
            console.warn("[DingTalk] Persisted task recovery failed:", (e as Error).message),
          );
        }

        resolve();
      };

      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(new Error(`WebSocket 握手失败: ${err.message}`));
      };

      ws.once("open", onOpen);
      ws.once("error", onError);

      ws.on("message", async (raw: Buffer | string) => {
        try {
          await this.handleFrame(raw.toString());
        } catch (err) {
          console.error("[DingTalk] Frame handling error:", err);
        }
      });

      // DingTalk may use WebSocket-level ping frames for keepalive;
      // update lastFrameTime so health check doesn't false-trigger.
      ws.on("ping", () => { this.lastFrameTime = Date.now(); });
      ws.on("pong", () => { this.lastFrameTime = Date.now(); });

      ws.on("close", (code: number) => {
        console.log(`[DingTalk] WebSocket closed (code=${code})`);
        this.stopHealthCheck();
        this.ws = null;
        if (!this.stopped && this.everConnected) {
          this.status = "error";
          emit(this.opts.assistantId, "error", `连接断开 (code=${code})，正在重连…`);
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err: Error) => {
        if (this.status === "connected") {
          console.error("[DingTalk] WebSocket error:", err.message);
          this.status = "error";
          emit(this.opts.assistantId, "error", err.message);
        }
      });
    });
  }

  // ── Exponential backoff reconnect ────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const maxAttempts = this.opts.maxConnectionAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.status = "error";
      emit(
        this.opts.assistantId,
        "error",
        `已达最大重连次数 (${maxAttempts})，请手动重新连接`,
      );
      return;
    }

    const initialDelay = this.opts.initialReconnectDelay ?? 1000;
    const maxDelay = this.opts.maxReconnectDelay ?? 60_000;
    const jitter = this.opts.reconnectJitter ?? 0.3;

    const base = Math.min(initialDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    const jitterRange = base * jitter;
    const delay = Math.round(base + (Math.random() * 2 - 1) * jitterRange);

    this.reconnectAttempts++;
    console.log(
      `[DingTalk] Reconnect attempt ${this.reconnectAttempts}/${maxAttempts} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[DingTalk] Reconnect failed:", err.message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Health check ─────────────────────────────────────────────────────────────

  /** DingTalk PING intervals vary (30-60s+); 90s silence is a safe threshold. */
  private static readonly FRAME_SILENCE_THRESHOLD_MS = 90_000;

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.consecutiveUnhealthy = 0;
    this.lastFrameTime = Date.now();

    // Client-side keepalive: send WebSocket ping every 30s to prevent NAT/proxy timeout.
    // DingTalk server may not send application-level PINGs frequently;
    // pong responses update lastFrameTime so health check stays green.
    this.keepaliveInterval = setInterval(() => {
      if (this.stopped) return;
      try {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      } catch { /* ignore */ }
    }, 30_000);

    this.healthCheckInterval = setInterval(() => {
      if (this.stopped) return;

      const wsOpen = this.ws?.readyState === WebSocket.OPEN;
      const frameFresh = this.lastFrameTime > 0
        && (Date.now() - this.lastFrameTime) < DingtalkConnection.FRAME_SILENCE_THRESHOLD_MS;

      if (!wsOpen || !frameFresh) {
        this.consecutiveUnhealthy++;
        const reason = !wsOpen ? "WebSocket not open" : `no frame for 90s (silent disconnect)`;
        console.warn(`[DingTalk] Health check unhealthy: ${reason} (${this.consecutiveUnhealthy}/3)`);
        if (this.consecutiveUnhealthy >= 3) {
          console.warn("[DingTalk] Health check failed — triggering reconnect");
          this.stopHealthCheck();
          const ws = this.ws;
          this.ws = null;
          try { ws?.terminate(); } catch { /* ignore */ }
          if (this.status !== "error") {
            this.status = "error";
            emit(this.opts.assistantId, "error", "连接健康检查失败，正在重连…");
          }
          this.scheduleReconnect();
        }
      } else {
        this.consecutiveUnhealthy = 0;
      }
    }, 15_000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    this.consecutiveUnhealthy = 0;
  }

  // ── Reconnect-recovery: drain pending inflight tasks ─────────────────────────

  private async drainInflightTasks(): Promise<void> {
    if (this.inflightTasks.size === 0) return;
    console.log(`[DingTalk] Draining ${this.inflightTasks.size} inflight task(s) after reconnect`);

    // Pre-refresh token so card / proactive delivery has a valid token
    try {
      await getAccessToken(this.opts.appKey, this.opts.appSecret);
    } catch (e) {
      console.warn("[DingTalk] Drain: token pre-refresh failed:", (e as Error).message);
    }

    for (const [key, task] of this.inflightTasks) {
      if (!task.accumulatedContent) continue;
      // Refresh card's token if card exists (it may have expired during disconnect)
      if (task.card && task.card.state !== AICardStatus.FINISHED && task.card.state !== AICardStatus.FAILED) {
        try {
          task.card.accessToken = await task.card.refreshToken();
        } catch {
          task.card.state = AICardStatus.FAILED;
        }
      }
      try {
        await this.deliverWithFallback(task.accumulatedContent, task.msg, task.card);
        this.inflightTasks.delete(key);
        console.log(`[DingTalk] Inflight task ${key} delivered after reconnect`);
      } catch (err) {
        console.error(`[DingTalk] Failed to drain inflight task ${key}:`, (err as Error).message);
      }
    }
  }

  // ── Restart-recovery: re-process persisted pending tasks ─────────────────────

  private async recoverPersistedTasks(): Promise<void> {
    const tasks = loadPendingTasks("dingtalk", this.opts.assistantId);
    if (tasks.length === 0) return;
    console.log(`[DingTalk] Recovering ${tasks.length} persisted pending task(s) for ${this.opts.assistantName}`);

    for (const task of tasks) {
      const msg = task.msg as DingtalkMessage;
      const age = Date.now() - task.createdAt;
      console.log(`[DingTalk] Recovering task ${task.id} (age=${Math.round(age / 1000)}s, text=${task.userText.slice(0, 60)})`);

      try {
        // Card mode unavailable after restart — always use markdown fallback
        await this.generateAndDeliver(msg, task.userText, task.hasFiles, null);
        console.log(`[DingTalk] Recovered task ${task.id} successfully`);
      } catch (err) {
        console.error(`[DingTalk] Recovery failed for task ${task.id}:`, (err as Error).message);
        const errorText = "抱歉，应用重启期间您的消息处理中断，重新处理时遇到了问题。请重新发送。";
        await this.deliverWithFallback(errorText, msg, null)
          .catch((e) => console.warn("[DingTalk] Failed to send recovery error:", (e as Error).message));
      } finally {
        removePendingTask(task.id);
      }
    }
  }

  // ── Per-session serialization lock ───────────────────────────────────────────

  private static readonly SESSION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

  private async acquireSessionLock(key: string): Promise<() => void> {
    const deadline = Date.now() + DingtalkConnection.SESSION_LOCK_TIMEOUT_MS;
    while (this.sessionLocks.has(key)) {
      if (Date.now() > deadline) {
        console.warn(`[DingTalk] Session lock timeout for ${key}, force-releasing stale lock`);
        this.sessionLocks.delete(key);
        break;
      }
      const raceTimeout = new Promise<void>((r) => setTimeout(r, 30_000));
      await Promise.race([this.sessionLocks.get(key), raceTimeout]);
    }
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    this.sessionLocks.set(key, promise);
    return () => {
      this.sessionLocks.delete(key);
      release();
    };
  }

  // ── Frame handling ───────────────────────────────────────────────────────────

  private async handleFrame(raw: string): Promise<void> {
    this.lastFrameTime = Date.now();

    let frame: StreamFrame;
    try {
      frame = JSON.parse(raw) as StreamFrame;
    } catch {
      return;
    }

    if (frame.type === "PING") {
      this.ack(frame.headers.messageId, frame.headers.topic ?? "");
      return;
    }

    if (frame.type !== "CALLBACK") return;

    const topic = frame.headers.topic;
    if (topic !== "/v1.0/im/bot/messages/get") return;

    this.ack(frame.headers.messageId, topic);

    let msg: DingtalkMessage;
    try {
      msg = JSON.parse(frame.data) as DingtalkMessage;
    } catch {
      return;
    }

    // ── Register peer IDs for proactive reply (soimy pattern) ─────────────────
    // Preserve original case-sensitive conversationId & senderId for later use.
    if (msg.conversationId) registerPeerId(msg.conversationId);
    const senderId = msg.senderStaffId ?? msg.senderId;
    if (senderId) registerPeerId(senderId);

    // ── Record last-seen conversation for automatic proactive targeting ─────────
    const isGroup = msg.conversationType === "2";
    const proactiveTarget = isGroup
      ? (msg.conversationId ?? null)
      : (msg.senderStaffId ?? msg.senderId ?? null);
    if (proactiveTarget) {
      recordLastSeen(this.opts.assistantId, proactiveTarget, isGroup);
    }

    this.inboundStats.received++;

    // ── Deduplication (persistent TTL + in-flight lock) ────────────────────────
    const dedupKey = msg.msgId
      ? `${this.opts.assistantId}:${msg.msgId}`
      : null;

    if (dedupKey) {
      if (isDuplicate(dedupKey)) {
        console.log(`[DingTalk][${this.opts.assistantName}] Dup TTL skip: ${msg.msgId}`);
        this.inboundStats.skipped++;
        return;
      }
      if (this.inflight.has(dedupKey)) {
        console.log(`[DingTalk][${this.opts.assistantName}] In-flight skip: ${msg.msgId}`);
        this.inboundStats.skipped++;
        return;
      }
      markProcessed(dedupKey);
      this.inflight.add(dedupKey);
    }

    // ── Access control ─────────────────────────────────────────────────────────
    if (!isAllowed(msg, this.opts)) {
      if (dedupKey) this.inflight.delete(dedupKey);
      return;
    }

    // Auto-populate ownerStaffIds on first private message
    if (!isGroup && !(this.opts.ownerStaffIds?.length)) {
      const staffId = msg.senderStaffId ?? msg.senderId;
      if (staffId) {
        const updated = patchAssistantBotOwnerIds(this.opts.assistantId, "dingtalk", staffId);
        if (updated) {
          this.opts.ownerStaffIds = [staffId];
        }
      }
    }

    // ── sessionWebhook expiry check ────────────────────────────────────────────
    if (
      msg.sessionWebhookExpiredTime &&
      Date.now() > msg.sessionWebhookExpiredTime
    ) {
      console.warn("[DingTalk] sessionWebhook expired, skipping message");
      if (dedupKey) this.inflight.delete(dedupKey);
      return;
    }

    // ── Create card BEFORE extractContent for immediate "思考中" feedback ──────
    // Only in card mode (messageType="card" + cardTemplateId configured).
    // Markdown mode: no card, no interim "思考中" (cleaner than a permanent garbage msg).
    const useCardMode = this.opts.messageType === "card" && !!this.opts.cardTemplateId;
    let preCreatedCard: AICardInstance | null = null;
    if (useCardMode) {
      try {
        const refreshTokenFn = () => getAccessToken(this.opts.appKey, this.opts.appSecret);
        const token = await refreshTokenFn();
        preCreatedCard = await createAICard(
          refreshTokenFn,
          token,
          this.opts.robotCode ?? this.opts.appKey,
          this.opts.cardTemplateId!,
          this.opts.cardTemplateKey ?? "content",
          msg,
          "🤔 正在思考…",
        );
      } catch (err) {
        console.warn("[DingTalk] Early card creation failed:", (err as Error).message);
      }
    }

    // ── Extract text/media content ─────────────────────────────────────────────
    let extracted: { text: string; filePaths?: string[] };
    try {
      extracted = await extractContent(msg, this.opts);
    } catch (err) {
      console.error("[DingTalk] Content extraction error:", err);
      extracted = { text: "[消息处理失败]" };
    }

    if (!extracted.text) {
      if (preCreatedCard) {
        streamAICard(preCreatedCard, "（无法处理此消息）", true).catch(() => {});
      }
      if (dedupKey) this.inflight.delete(dedupKey);
      return;
    }

    // Append file paths and reading instruction so Claude knows to use read_document tool.
    if (extracted.filePaths && extracted.filePaths.length > 0) {
      const pathsNote = extracted.filePaths.map((p: string) => `文件路径: ${p}`).join("\n");
      extracted = { ...extracted, text: `${extracted.text}\n\n${pathsNote}\n⚠️ 这是一个新文件。如果是文档（PDF/Word/Excel 等），请立即调用 read_document 工具读取文件内容，再基于工具返回的实际内容回复，不得凭训练数据猜测文件内容。` };
    }

    console.log(`[DingTalk] Message (${msg.msgtype}): ${extracted.text.slice(0, 100)}`);

    // ── Built-in /myid command (only exact-match commands stay hardcoded) ──────
    const cmdText = extracted.text.trim();

    if (cmdText === "/myid" || cmdText === "/我的id" || cmdText === "/我的ID") {
      const staffId = msg.senderStaffId ?? msg.senderId ?? "（未知）";
      const convId = msg.conversationId ?? "（未知）";
      const isGroupCmd = msg.conversationType === "2";
      const reply = [
        "**你的钉钉 ID 信息**",
        "",
        `- **staffId**（填入 ownerStaffIds）：\`${staffId}\``,
        isGroupCmd ? `- **群 conversationId**（群推送用）：\`${convId}\`` : "",
        "",
        "复制上方 ID 填入 Bot 配置 → 高级设置 → 我的 StaffId，即可接收主动推送。",
      ].filter((l) => l !== undefined && !(isGroupCmd === false && l.includes("群"))).join("\n");
      await this.sendMarkdown(msg.sessionWebhook, reply, msg).catch((e) => console.warn("[DingTalk] Failed to send markdown:", e));
      if (dedupKey) this.inflight.delete(dedupKey);
      return;
    }

    // In markdown mode there is no "thinking" card, so send an immediate ack
    // to let the user know the bot has received the message.
    if (!useCardMode) {
      await this.sendMarkdownRaw(msg.sessionWebhook, "✅ 已收到，正在处理，请稍等…")
        .catch((e) => console.warn("[DingTalk] Failed to send quick ack:", e));
    }

    // ── Acquire per-session lock (serializes concurrent messages in same conversation) ──
    const sessionKey = isGroup
      ? `${this.opts.assistantId}:${msg.conversationId}`
      : `${this.opts.assistantId}:${msg.senderStaffId ?? msg.senderId}`;
    const releaseSessionLock = await this.acquireSessionLock(sessionKey);

    // ── Generate and deliver reply ─────────────────────────────────────────────
    this.inboundStats.processed++;
    console.log(
      `[DingTalk][${this.opts.assistantName}] Processing (rcv=${this.inboundStats.received} proc=${this.inboundStats.processed} skip=${this.inboundStats.skipped})`,
    );
    const hasFiles = (extracted.filePaths?.length ?? 0) > 0;

    // Persist task to WAL so it survives an app crash / restart
    const pendingId = msg.msgId ?? `dt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    savePendingTask({
      id: pendingId,
      platform: "dingtalk",
      assistantId: this.opts.assistantId,
      msg,
      userText: extracted.text,
      hasFiles,
      createdAt: Date.now(),
    });

    try {
      await this.generateAndDeliver(msg, extracted.text, hasFiles, preCreatedCard);
    } catch (err) {
      console.error("[DingTalk] Reply generation error:", err);
      const errorText = "抱歉，处理您的消息时遇到了问题，请稍后再试。";
      await this.deliverWithFallback(errorText, msg, preCreatedCard)
        .catch((e) => console.warn("[DingTalk] Failed to send error message:", e));
    } finally {
      removePendingTask(pendingId);
      releaseSessionLock();
      if (dedupKey) this.inflight.delete(dedupKey);
    }
  }

  private ack(messageId: string, topic: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        code: 200,
        headers: { messageId, topic, contentType: "application/json" },
        message: "OK",
        data: "",
      }),
    );
  }

  // ── Generate reply and deliver (card or markdown) ────────────────────────────

  private async generateAndDeliver(
    msg: DingtalkMessage,
    userText: string,
    hasFiles: boolean,
    preCreatedCard: AICardInstance | null,
  ): Promise<void> {
    const history = getHistory(this.opts.assistantId);
    const provider = this.opts.provider ?? "claude";
    const useCard = this.opts.messageType === "card" && !!this.opts.cardTemplateId && !!preCreatedCard;

    const sessionId = getBotSession(
      this.opts.assistantId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
    );

    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userText });

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = await buildSmartMemoryContext(userText, this.opts.assistantId, this.opts.defaultCwd);

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const msgNow = msg.createAt ?? Date.now();
    const nowStr = new Date(msgNow).toLocaleString("zh-CN", { timeZone: tz, hour12: false });
    const currentTimeContext = `## 当前时间\n消息发送时间：${nowStr}（时区：${tz}）\n创建定时任务时，若需要相对时间（如"X分钟后"），请使用 delay_minutes 参数，服务器会自动计算。`;

    // File messages must not resume previous session context
    const historySection = (!hasFiles && history.length > 1)
      ? buildHistoryContextDt(history.slice(0, -1), this.opts.assistantId)
      : undefined;

    const system = buildStructuredPersona(this.opts, currentTimeContext, memoryContext, historySection);

    // Register inflight task for reconnect recovery
    const inflightKey = msg.msgId ?? `${Date.now()}-${Math.random()}`;
    const inflightTask: InflightTask = { card: preCreatedCard, accumulatedContent: "", msg, startedAt: Date.now() };
    this.inflightTasks.set(inflightKey, inflightTask);

    try {
      let replyText: string;
      let cardDelivered = false;

      if (provider === "openai") {
        replyText = await this.runClaudeQuery(system, userText, msg, provider, hasFiles);
      } else if (useCard && preCreatedCard) {
        const result = await this.runClaudeCard(system, userText, msg, preCreatedCard, inflightTask, provider, hasFiles);
        if (result === "__CARD_DELIVERED__") {
          cardDelivered = true;
          replyText = inflightTask.accumulatedContent;
        } else {
          replyText = result;
        }
      } else {
        replyText = await this.runClaudeQuery(system, userText, msg, provider, hasFiles);
      }

      // Update inflight with final content
      inflightTask.accumulatedContent = replyText || inflightTask.accumulatedContent;

      history.push({ role: "assistant", content: inflightTask.accumulatedContent });
      this.persistReply(sessionId, inflightTask.accumulatedContent, userText);
      updateBotSessionTitle(sessionId, history, `[钉钉]`).catch((e) => console.warn("[DingTalk] Failed to update session title:", e));

      // Deliver via fallback chain unless card already self-delivered
      if (!cardDelivered) {
        await this.deliverWithFallback(inflightTask.accumulatedContent, msg, preCreatedCard);
      }
    } finally {
      this.inflightTasks.delete(inflightKey);
    }
  }

  /** Claude query() path via Agent SDK with shared MCP + per-session MCP */
  private async runClaudeQuery(
    system: string,
    userText: string,
    msg: DingtalkMessage,
    provider: "claude" | "openai",
    hasFiles?: boolean,
  ): Promise<string> {
    const sessionMcp = this.createSessionMcp(msg);
    const sharedMcp = createSharedMcpServer({ assistantId: this.opts.assistantId, sessionCwd: this.opts.defaultCwd });
    const claudeSessionId = hasFiles ? undefined : getBotClaudeSessionId(this.opts.assistantId);
    const claudeCodePath = getClaudeCodePath();
    const assistantConfig = loadAssistantsConfig().assistants.find(a => a.id === this.opts.assistantId);

    let finalText = "";
    const q = await runAgent(userText, {
      systemPrompt: system,
      resume: claudeSessionId,
      cwd: this.opts.defaultCwd ?? homedir(),
      mcpServers: { "vk-shared": sharedMcp, "dt-session": sessionMcp },
      pathToClaudeCodeExecutable: claudeCodePath,
      provider,
      ...(provider === "claude" && { env: buildQueryEnv(assistantConfig) }),
      ...(provider === "openai" && { openaiOverrides: buildOpenAIOverrides(assistantConfig, this.opts.model) }),
    });

    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        finalText = message.result;
        setBotClaudeSessionId(this.opts.assistantId, message.session_id);
      }
    }

    return finalText || "抱歉，无法生成回复。";
  }

  /** Per-session MCP server with send_message + send_file tools bound to current msg context */
  private createSessionMcp(msg: DingtalkMessage) {
    // Capture opts reference for use in tool closures
    const self = this;

    const sendMessageTool = tool(
      "send_message",
      "向当前钉钉对话立即发送一条文本/Markdown 消息。适合在执行长任务时告知用户进度，" +
        "或在最终回复前推送中间结果。注意：你的最终文字回复也会自动发送，请勿重复内容。",
      { text: z.string().describe("要发送的消息内容（支持 Markdown）") },
      async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return { content: [{ type: "text" as const, text: "消息内容为空" }] };
        await self.sendMarkdown(msg.sessionWebhook, text, msg).catch((e) => console.warn("[DingTalk] Failed to send markdown:", e));
        return { content: [{ type: "text" as const, text: "消息已发送" }] };
      },
    );

    const sendFileTool = tool(
      "send_file",
      "通过钉钉将本地文件发送给当前对话的用户。支持图片（png/jpg）、PDF、文档、视频等。" +
        "file_path 必须是本机可读取的完整路径。" +
        "超出大小限制时会自动处理：图片自动压缩（macOS sips），其他文件自动 zip 压缩。",
      { file_path: z.string().describe("要发送的文件的完整本地路径") },
      async (input) => {
        const result = await self.doSendFile(String(input.file_path ?? ""), msg);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );

    return createSdkMcpServer({ name: "dingtalk-session", tools: [sendMessageTool, sendFileTool] });
  }

  /**
   * Card streaming mode — Agent SDK + shared MCP tools + real-time card updates.
   * Mirrors Telegram's runClaudeQuery streaming pattern.
   * Returns "__CARD_DELIVERED__" when card was fully finalized, or plain text for fallback.
   */
  private async runClaudeCard(
    system: string,
    userText: string,
    msg: DingtalkMessage,
    card: AICardInstance,
    inflightTask: InflightTask,
    provider: "claude" | "openai",
    hasFiles?: boolean,
  ): Promise<string> {
    const sessionMcp = this.createSessionMcp(msg);
    const sharedMcp = createSharedMcpServer({ assistantId: this.opts.assistantId, sessionCwd: this.opts.defaultCwd });
    const claudeSessionId = hasFiles ? undefined : getBotClaudeSessionId(this.opts.assistantId);
    const claudeCodePath = getClaudeCodePath();
    const assistantConfig = loadAssistantsConfig().assistants.find(a => a.id === this.opts.assistantId);

    let finalText = "";
    let accum = "";
    let lastUpdate = 0;
    const THROTTLE_MS = 500;

    const q = await runAgent(userText, {
      systemPrompt: system,
      resume: claudeSessionId,
      cwd: this.opts.defaultCwd ?? homedir(),
      mcpServers: { "vk-shared": sharedMcp, "dt-session": sessionMcp },
      pathToClaudeCodeExecutable: claudeCodePath,
      provider,
      ...(provider === "claude" && { env: buildQueryEnv(assistantConfig) }),
      ...(provider === "openai" && { openaiOverrides: buildOpenAIOverrides(assistantConfig, this.opts.model) }),
    });

    try {
      let thinkingAccum = "";
      let thinkingRevealed = 0;
      let isThinking = false;
      let revealTimer: ReturnType<typeof setTimeout> | null = null;

      const REVEAL_INTERVAL = 400;
      const REVEAL_CHARS = 40;

      const revealTick = () => {
        revealTimer = null;
        if (!isThinking || thinkingRevealed >= thinkingAccum.length) return;
        thinkingRevealed = Math.min(thinkingRevealed + REVEAL_CHARS, thinkingAccum.length);
        lastUpdate = Date.now();
        streamAICard(card, formatThinkingForCard(thinkingAccum.slice(0, thinkingRevealed)), false).catch((e) =>
          console.warn("[DingTalk] Card thinking update failed:", (e as Error).message),
        );
        if (thinkingRevealed < thinkingAccum.length) {
          revealTimer = setTimeout(revealTick, REVEAL_INTERVAL);
        }
      };

      const stopReveal = () => {
        if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      };

      for await (const message of q) {
        const msgData = message as Record<string, unknown>;
        if (msgData.type === "result" && msgData.subtype === "success") {
          finalText = msgData.result as string;
          setBotClaudeSessionId(this.opts.assistantId, msgData.session_id as string);
          stopReveal();
          continue;
        }

        // Thinking phase: progressive reveal of thinking content on the card
        if (msgData.type === "stream_event") {
          const event = (msgData as any).event;
          if (event?.type === "content_block_start") {
            if (event.content_block?.type === "thinking") {
              isThinking = true;
              thinkingAccum = "";
              thinkingRevealed = 0;
              stopReveal();
            } else if (event.content_block?.type === "text") {
              isThinking = false;
              stopReveal();
            }
          }
          if (event?.type === "content_block_delta" && isThinking && event.delta?.type === "thinking_delta") {
            thinkingAccum += event.delta.thinking ?? "";
            if (!revealTimer) {
              revealTimer = setTimeout(revealTick, REVEAL_INTERVAL);
            }
          }
          if (event?.type === "content_block_stop" && isThinking) {
            isThinking = false;
            stopReveal();
          }
          continue;
        }

        // Text phase: extract accumulated text from assistant messages
        const partial = extractPartialText(msgData);
        if (partial && partial.length > accum.length) {
          accum = partial;
          inflightTask.accumulatedContent = accum;
          const now = Date.now();
          if (now - lastUpdate >= THROTTLE_MS) {
            lastUpdate = now;
            streamAICard(card, accum, false).catch((e) =>
              console.warn("[DingTalk] Card stream update failed:", (e as Error).message),
            );
          }
        }
      }

      const text = (finalText || accum).trim() || "抱歉，无法生成回复。";
      inflightTask.accumulatedContent = text;

      // Final card update
      await streamAICard(card, text, true).catch((e) =>
        console.warn("[DingTalk] Card finalize failed:", (e as Error).message),
      );

      return "__CARD_DELIVERED__";
    } catch (err) {
      console.error("[DingTalk] Card mode (Agent SDK) failed:", (err as Error).message);
      const text = (finalText || accum).trim() || "抱歉，无法生成回复。";
      inflightTask.accumulatedContent = text;
      return text; // Caller (generateAndDeliver) will use deliverWithFallback
    }
  }

  /**
   * Three-level fallback delivery chain (Openclaw pattern):
   *   1. Card streaming finalize (if card exists and not terminal)
   *   2. sessionWebhook (if not expired)
   *   3. Proactive API (last resort)
   */
  private async deliverWithFallback(
    text: string,
    msg: DingtalkMessage,
    card: AICardInstance | null,
  ): Promise<void> {
    // 1. Try card finalize
    if (card && card.state !== AICardStatus.FINISHED && card.state !== AICardStatus.FAILED) {
      try {
        await streamAICard(card, text, true);
        return;
      } catch (err) {
        console.warn("[DingTalk] Card delivery failed, falling back:", (err as Error).message);
        card.state = AICardStatus.FAILED;
      }
    }

    // 2. Try sessionWebhook
    const webhookExpired = msg.sessionWebhookExpiredTime && Date.now() > msg.sessionWebhookExpiredTime;
    if (!webhookExpired && msg.sessionWebhook) {
      try {
        await this.sendMarkdown(msg.sessionWebhook, text, msg);
        return;
      } catch (err) {
        console.warn("[DingTalk] sessionWebhook fallback failed:", (err as Error).message);
      }
    }

    // 3. Try proactive API
    const isGroup = msg.conversationType === "2";
    const target = isGroup
      ? (msg.conversationId ?? "")
      : (msg.senderStaffId ?? msg.senderId ?? "");
    if (target) {
      try {
        await sendProactiveToTarget(this.opts, target, text, this.opts.assistantName);
      } catch (err) {
        console.error("[DingTalk] All delivery methods failed:", (err as Error).message);
      }
    }
  }

  /** File upload and send via DingTalk — extracted from old ToolRegistry send_file */
  private async doSendFile(filePath: string, msg: DingtalkMessage): Promise<string> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const path = await import("path");
    const fs = await import("fs");

    if (!filePath || !fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const mediaType: "image" | "voice" | "video" | "file" =
      ["jpg", "jpeg", "png", "gif", "bmp"].includes(ext) ? "image" :
      ["mp3", "amr", "wav"].includes(ext) ? "voice" :
      ["mp4", "avi", "mov"].includes(ext) ? "video" : "file";

    const SIZE_LIMITS: Record<string, number> = {
      image: 20 * 1024 * 1024,
      voice: 2 * 1024 * 1024,
      video: 20 * 1024 * 1024,
      file: 20 * 1024 * 1024,
    };

    const tempFiles: string[] = [];
    const cleanup = () => {
      const toDelete = filePath.includes("vk-shot-") ? [filePath, ...tempFiles] : tempFiles;
      for (const f of toDelete) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
      }
    };

    let sendPath = filePath;
    const stat = fs.statSync(filePath);
    const limit = SIZE_LIMITS[mediaType];

    if (stat.size > limit) {
      const os2 = await import("os");
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

      if (mediaType === "image") {
        const compressedPath = path.join(os2.tmpdir(), `vk-compressed-${Date.now()}.jpg`);
        tempFiles.push(compressedPath);
        try {
          if (process.platform === "darwin") {
            await execAsync(`sips -s format jpeg -s formatOptions 70 -Z 2000 "${filePath}" --out "${compressedPath}"`);
          } else {
            await execAsync(`convert "${filePath}" -resize 2000x2000> -quality 70 "${compressedPath}"`);
          }
          const newStat = fs.statSync(compressedPath);
          if (newStat.size <= limit) {
            console.log(`[DingTalk] Image compressed: ${sizeMB}MB → ${(newStat.size / 1024 / 1024).toFixed(1)}MB`);
            sendPath = compressedPath;
          } else {
            cleanup();
            return `图片压缩后仍超过 20MB（${(newStat.size / 1024 / 1024).toFixed(1)}MB），建议先裁剪或降低分辨率。`;
          }
        } catch {
          cleanup();
          return `图片 ${sizeMB}MB 超过 20MB 限制，压缩失败，请先手动压缩。`;
        }
      } else if (mediaType === "voice") {
        cleanup();
        return `语音文件 ${sizeMB}MB 超过 2MB 限制，请裁剪后再发。`;
      } else {
        const zipPath = path.join(
          (await import("os")).tmpdir(),
          `vk-${path.basename(filePath)}-${Date.now()}.zip`,
        );
        tempFiles.push(zipPath);
        try {
          await execAsync(`cd "${path.dirname(filePath)}" && zip "${zipPath}" "${path.basename(filePath)}"`);
          const zipStat = fs.statSync(zipPath);
          if (zipStat.size <= SIZE_LIMITS.file) {
            console.log(`[DingTalk] File zipped: ${sizeMB}MB → ${(zipStat.size / 1024 / 1024).toFixed(1)}MB`);
            sendPath = zipPath;
          } else {
            cleanup();
            return `文件 ${sizeMB}MB 压缩后仍超过 20MB，建议用网盘分享链接代替，或通过 bash 上传 OSS 后发链接。`;
          }
        } catch {
          cleanup();
          return `文件 ${sizeMB}MB 超过 20MB 限制，且 zip 压缩失败，建议改用网盘分享。`;
        }
      }
    }

    // Upload to DingTalk media server (V1 API — requires V1 token)
    const sendExt = sendPath.split(".").pop()?.toLowerCase() ?? ext;
    const sendMediaType: "image" | "voice" | "video" | "file" =
      ["jpg", "jpeg", "png", "gif", "bmp"].includes(sendExt) ? "image" :
      ["mp3", "amr", "wav"].includes(sendExt) ? "voice" :
      ["mp4", "avi", "mov"].includes(sendExt) ? "video" : "file";

    const mediaId = await uploadMediaV1(this.opts.appKey, this.opts.appSecret, sendPath, sendMediaType);
    if (!mediaId) {
      cleanup();
      return `媒体上传失败，请检查应用权限（oapi.dingtalk.com）`;
    }

    // sessionWebhook only supports text/markdown — file/image/voice/video must use Proactive API
    // (DingTalk returns HTTP 200 but silently drops unsupported msgtype through webhook)
    const robotCode = this.opts.robotCode ?? this.opts.appKey;
    const sender = msg.senderStaffId ?? msg.senderId ?? "";
    const isGroup = msg.conversationType === "2";
    const resolvedTarget = resolveOriginalPeerId(sender || msg.conversationId || "");
    const apiUrl = isGroup
      ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
      : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

    const fileName = path.basename(filePath);
    const fileExt = ext || "bin";
    let msgKey: string;
    let msgParam: string;
    if (sendMediaType === "voice") {
      msgKey = "sampleAudio";
      msgParam = JSON.stringify({ mediaId, duration: "1" });
    } else if (sendMediaType === "image") {
      msgKey = "sampleImageMsg";
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else {
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName, fileType: fileExt });
    }

    const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
    if (isGroup) payload.openConversationId = resolvedTarget;
    else payload.userIds = [resolvedTarget];

    try {
      const token = await getAccessToken(this.opts.appKey, this.opts.appSecret);
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
        body: JSON.stringify(payload),
      });
      const respText = await resp.text();
      cleanup();
      if (resp.ok) {
        console.log(`[DingTalk][send_file] proactive API ok: ${path.basename(sendPath)} → ${isGroup ? "group" : "user"}:${resolvedTarget}`);
        return `文件已发送: ${path.basename(sendPath)}`;
      }
      console.error(`[DingTalk][send_file] proactive API fail (${resp.status}): ${respText.slice(0, 300)}`);
      return `发送失败 (HTTP ${resp.status}): ${respText.slice(0, 200)}`;
    } catch (err) {
      cleanup();
      console.error(`[DingTalk][send_file] proactive API error:`, err instanceof Error ? err.message : err);
      return `发送异常: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Persist reply ────────────────────────────────────────────────────────────

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
      // Strip file path instructions before logging — temp paths must not appear in
      // conversation history, otherwise the next file message will inherit stale
      // "read this file" instructions and Claude will read the wrong file.
      const logUserText = userText.replace(/\n\n文件路径:[\s\S]*$/, "").trim();
      recordConversation(
        `\n## ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${logUserText}\n**${this.opts.assistantName}**: ${replyText}\n`,
        { assistantId: this.opts.assistantId, assistantName: this.opts.assistantName, channel: "钉钉" },
      );
    }
  }

  // ── Send markdown via sessionWebhook ─────────────────────────────────────────

  private async sendMarkdownRaw(webhook: string, text: string): Promise<void> {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: this.opts.assistantName,
          text,
        },
      }),
    });

    const respBody = await resp.text();
    if (!resp.ok) {
      console.error(`[DingTalk] Reply failed: HTTP ${resp.status} ${respBody}`);
    } else {
      try {
        const parsed = JSON.parse(respBody);
        if (parsed.errcode && parsed.errcode !== 0) {
          console.warn(`[DingTalk] Reply accepted but errcode=${parsed.errcode}: ${parsed.errmsg ?? respBody}`);
        }
      } catch { /* non-JSON body is fine */ }
    }
  }

  /**
   * Send a reply that may contain inline images (![alt](localPath)).
   * Images are uploaded to DingTalk media server and sent as separate image messages;
   * surrounding text is sent as Markdown.  Falls back to plain Markdown if no local images found.
   */
  private async sendMarkdown(webhook: string, text: string, msg?: DingtalkMessage): Promise<void> {
    const segments = parseReplySegments(text);
    const hasImages = segments.some((s) => s.kind === "image");

    if (!hasImages) {
      return this.sendMarkdownRaw(webhook, text);
    }

    for (const seg of segments) {
      if (seg.kind === "text") {
        const trimmed = seg.content.trim();
        if (!trimmed) continue;
        await this.sendMarkdownRaw(webhook, trimmed).catch((e) =>
          console.warn("[DingTalk] Text segment send failed:", e),
        );
      } else if (msg) {
        // sessionWebhook only supports text/markdown — images must use Proactive API
        await this.doSendFile(seg.path, msg).catch((err) => {
          console.error("[DingTalk] Image segment send error:", err);
          this.sendMarkdownRaw(webhook, `[图片: ${seg.path}]`).catch(() => {});
        });
      } else {
        console.warn("[DingTalk] Cannot send image without msg context, skipping:", seg.path);
        await this.sendMarkdownRaw(webhook, `[图片: ${seg.path}]`).catch(() => {});
      }
    }
  }
}
