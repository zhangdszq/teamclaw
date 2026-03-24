/**
 * WeChat Bot Service
 *
 * Uses the ilink bot HTTP protocol with QR login + long polling.
 * Follows DinoClaw's existing bot architecture:
 * - shared session store
 * - Claude/OpenAI agent via agent-client
 * - shared MCP + per-session send_file tool
 * - per-chat history and session title sync
 */

import { EventEmitter } from "events";
import { basename, join } from "path";
import { homedir, tmpdir } from "os";
import { readFileSync, statSync, writeFileSync } from "fs";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { promptOnce, runAgent } from "./agent-client.js";
import { buildSmartMemoryContext } from "./memory-store.js";
import { loadAssistantsConfig, patchAssistantBotOwnerIds } from "./assistants-config.js";
import { getClaudeCodePath } from "./util.js";
import type { SessionStore } from "./session-store.js";
import type { StreamMessage } from "../types.js";
import { createSharedMcpServer, type SharedMcpSensitiveTurnState } from "./shared-mcp.js";
import { loadMcporterServers } from "./mcporter-loader.js";
import { trackAnalytics } from "./analytics.js";
import {
  type BaseBotOptions,
  type ConvMessage,
  FILE_SEND_RULE,
  PRIVATE_WHITELIST_RULE,
  buildOpenAIOverrides,
  buildQueryEnv,
  buildStructuredPersona as buildStructuredPersonaBase,
  buildHistoryContext,
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
  parseReplySegments,
  prepareVisibleArtifact,
  extractPartialText,
  bufferPersistedBotMessage,
  flushBufferedBotAssistantMessage,
  scheduleBotPostResponseTasks,
} from "./bot-base.js";
import {
  buildActivatedSkillSection,
  resolveSkillPromptContext,
  shouldIncludeCursorDelegation,
} from "./skill-context.js";
import {
  getWeixinAccount,
  getWeixinContextToken,
  getWeixinPollCursor,
  listWeixinAccounts,
  setWeixinPollCursor,
  upsertWeixinContextToken,
} from "./weixin-db.js";
import type { WeixinAccountRow } from "./weixin-db.js";
import {
  sendMessage,
  sendTextMessage,
  getUpdates,
  sendTyping as apiSendTyping,
  getConfig,
  startLoginQr,
} from "./weixin/weixin-api.js";
import { cancelQrLoginSession, pollQrLoginStatus, startQrLoginSession } from "./weixin/weixin-auth.js";
import { decodeWeixinChatId, encodeWeixinChatId } from "./weixin/weixin-ids.js";
import {
  downloadMediaFromItem,
  inferWeixinUploadMediaType,
  uploadMediaToCdn,
} from "./weixin/weixin-media.js";
import {
  MessageItemType,
  TypingStatus,
  UploadMediaType,
  ERRCODE_SESSION_EXPIRED,
  type MessageItem,
  type WeixinCredentials,
  type WeixinMessage,
} from "./weixin/weixin-types.js";
import { clearAllPauses, isPaused, setPaused } from "./weixin/weixin-session-guard.js";

export type WeixinBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface WeixinBotOptions extends BaseBotOptions {
  accountId: string;
  provider?: "claude" | "openai";
  model?: string;
  defaultCwd?: string;
  dmPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  ownerUserIds?: string[];
  /** Whether to download and forward media attachments. Default: true */
  mediaEnabled?: boolean;
}

type WeixinQrLoginResult = {
  sessionId: string;
  qrImage: string;
};

const WEIXIN_TEXT_LIMIT = 1800;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_TURNS = 10;

const statusEmitter = new EventEmitter();
const sessionUpdateEmitter = new EventEmitter();
const processedMsgs = new Map<string, number>();

const histories = new Map<string, ConvMessage[]>();
const botSessionIds = new Map<string, string>();
const titledSessions = new Map<string, number>();
const botClaudeSessionIds = new Map<string, string>();

let sessionStore: SessionStore | null = null;

function buildStructuredPersona(
  opts: WeixinBotOptions,
  ...extras: (string | undefined | null)[]
): string {
  return buildStructuredPersonaBase(opts, FILE_SEND_RULE, ...extras);
}

function isDuplicate(key: string): boolean {
  return isDuplicateMsg(key, processedMsgs);
}

function markProcessed(key: string): void {
  markProcessedMsg(key, processedMsgs);
}

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
  if (!sessionStore) throw new Error("[Weixin] SessionStore not injected");
  const existingId = botSessionIds.get(key);
  if (existingId && sessionStore.getSession(existingId)) return existingId;
  const session = sessionStore.createSession({
    title: `[WeChat] ${assistantName}`,
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
  prefix = "[WeChat]",
): Promise<void> {
  const turns = Math.floor(history.length / 2);
  const previousCount = titledSessions.get(sessionId) ?? 0;
  const shouldUpdate = turns === 1 || (turns === 3 && previousCount < 2);
  if (!shouldUpdate) return;
  titledSessions.set(sessionId, previousCount + 1);

  const recentTurns = history.slice(-6);
  const contextLines = recentTurns
    .map((message) => {
      const role = message.role === "user" ? "用户" : "助手";
      return `${role}：${String(message.content).slice(0, 200)}`;
    })
    .join("\n");
  const fallback = (recentTurns[0]?.content || "对话").slice(0, 30).trim();

  try {
    const generated = (
      await promptOnce(
        `请根据以下对话内容，生成一个简短的中文标题（不超过12字，不加引号，不加标点），直接输出标题，不输出其他内容：\n\n${contextLines}`,
      )
    )?.trim() || "";
    const title = generated && generated !== "New Session" ? generated : fallback;
    emitSessionUpdate(sessionId, { title: `${prefix} ${title}` });
  } catch (error) {
    console.warn("[Weixin] Title generation failed:", error);
    if (previousCount === 0) {
      emitSessionUpdate(sessionId, { title: `${prefix} ${fallback}` });
    }
  }
}

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

function emitStatus(assistantId: string, status: WeixinBotStatus, detail?: string): void {
  statusEmitter.emit("status", assistantId, status, detail);
}

function emitSessionUpdate(sessionId: string, updates: { title?: string; status?: string }): void {
  sessionStore?.updateSession(sessionId, updates as Parameters<SessionStore["updateSession"]>[1]);
  sessionUpdateEmitter.emit("update", sessionId, updates);
}

function chunkMessage(text: string): string[] {
  if (text.length <= WEIXIN_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= WEIXIN_TEXT_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", WEIXIN_TEXT_LIMIT);
    if (splitAt < WEIXIN_TEXT_LIMIT * 0.3) {
      splitAt = remaining.lastIndexOf(" ", WEIXIN_TEXT_LIMIT);
    }
    if (splitAt < WEIXIN_TEXT_LIMIT * 0.3) {
      splitAt = WEIXIN_TEXT_LIMIT;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function stripRichText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, ""),
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function sanitizeTmpName(fileName: string): string {
  return fileName.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
}

function isAllowed(peerUserId: string, opts: WeixinBotOptions): boolean {
  if ((opts.dmPolicy ?? "open") !== "allowlist") return true;
  const allowFrom = opts.allowFrom ?? [];
  return allowFrom.includes(peerUserId);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function buildOutboundMediaItem(
  mediaType: number,
  uploaded: { encryptQueryParam: string; aesKeyBase64: string; cipherSize: number },
  filePath: string,
  fileSize: number,
): MessageItem {
  const media = {
    encrypt_query_param: uploaded.encryptQueryParam,
    aes_key: uploaded.aesKeyBase64,
    encrypt_type: 1,
  };
  if (mediaType === UploadMediaType.IMAGE) {
    return { type: MessageItemType.IMAGE, image_item: { media, mid_size: uploaded.cipherSize } };
  }
  if (mediaType === UploadMediaType.VIDEO) {
    return { type: MessageItemType.VIDEO, video_item: { media, video_size: uploaded.cipherSize } };
  }
  if (mediaType === UploadMediaType.VOICE) {
    return { type: MessageItemType.VOICE, voice_item: { media } };
  }
  return {
    type: MessageItemType.FILE,
    file_item: {
      media,
      file_name: basename(filePath),
      len: String(fileSize),
    },
  };
}

const pool = new Map<string, WeixinConnection>();

function findAssistantByAccountId(accountId: string, excludeAssistantId?: string): string | null {
  for (const [assistantId, connection] of pool.entries()) {
    if (assistantId === excludeAssistantId) continue;
    if (connection.opts.accountId === accountId) {
      return assistantId;
    }
  }
  return null;
}

export function setWeixinSessionStore(store: SessionStore): void {
  sessionStore = store;
}

export function onWeixinBotStatusChange(
  callback: (assistantId: string, status: WeixinBotStatus, detail?: string) => void,
): () => void {
  statusEmitter.on("status", callback);
  return () => statusEmitter.off("status", callback);
}

export function onWeixinSessionUpdate(
  callback: (sessionId: string, updates: { title?: string; status?: string }) => void,
): () => void {
  sessionUpdateEmitter.on("update", callback);
  return () => sessionUpdateEmitter.off("update", callback);
}

export async function startWeixinBot(opts: WeixinBotOptions): Promise<void> {
  stopWeixinBot(opts.assistantId);

  const duplicateAssistantId = findAssistantByAccountId(opts.accountId, opts.assistantId);
  if (duplicateAssistantId) {
    stopWeixinBot(duplicateAssistantId);
  }

  const connection = new WeixinConnection(opts);
  pool.set(opts.assistantId, connection);
  await connection.start();
}

export function stopWeixinBot(assistantId: string): void {
  const connection = pool.get(assistantId);
  if (connection) {
    connection.stop();
    pool.delete(assistantId);
  }
  const keysToClean = Array.from(histories.keys()).filter((key) => key.startsWith(assistantId));
  for (const key of keysToClean) {
    histories.delete(key);
    botSessionIds.delete(key);
    botClaudeSessionIds.delete(key);
  }
  emitStatus(assistantId, "disconnected");
}

export function getWeixinBotStatus(assistantId: string): WeixinBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

export function updateWeixinBotConfig(
  assistantId: string,
  updates: Partial<
    Pick<
      WeixinBotOptions,
      | "provider"
      | "model"
      | "persona"
      | "coreValues"
      | "relationship"
      | "cognitiveStyle"
      | "operatingGuidelines"
      | "userContext"
      | "assistantName"
      | "defaultCwd"
      | "skillNames"
      | "dmPolicy"
      | "allowFrom"
      | "ownerUserIds"
      | "mediaEnabled"
    >
  >,
): void {
  const connection = pool.get(assistantId);
  if (!connection) return;
  connection.opts = { ...connection.opts, ...updates };
}

export async function beginWeixinQrLogin(): Promise<WeixinQrLoginResult> {
  return startQrLoginSession();
}

export async function waitWeixinQrLogin(sessionId: string) {
  return pollQrLoginStatus(sessionId);
}

export function abortWeixinQrLogin(sessionId: string): void {
  cancelQrLoginSession(sessionId);
}

class WeixinConnection {
  status: WeixinBotStatus = "disconnected";
  opts: WeixinBotOptions;

  private stopped = false;
  private abortController: AbortController | null = null;
  private inflight = new Set<string>();
  private typingTickets = new Map<string, string>();
  private consecutiveFailures = 0;

  constructor(opts: WeixinBotOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const account = getWeixinAccount(this.opts.accountId);
    if (!account) {
      throw new Error(`WeChat 账号不存在: ${this.opts.accountId}`);
    }
    if (!account.token) {
      throw new Error(`WeChat 账号无有效 token: ${this.opts.accountId}`);
    }

    this.stopped = false;
    this.abortController = new AbortController();
    this.status = "connecting";
    emitStatus(this.opts.assistantId, "connecting");
    clearAllPauses();

    void this.runPollLoop(this.abortController.signal);

    this.status = "connected";
    emitStatus(this.opts.assistantId, "connected");
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
    this.typingTickets.clear();
    this.inflight.clear();
    this.status = "disconnected";
  }

  private getActiveAccount(): WeixinAccountRow {
    const account = getWeixinAccount(this.opts.accountId);
    if (!account) {
      throw new Error(`WeChat 账号不存在: ${this.opts.accountId}`);
    }
    return account;
  }

  private getCredentials(): WeixinCredentials {
    const account = this.getActiveAccount();
    return {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url,
      cdnBaseUrl: account.cdn_base_url,
    };
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal.aborted) {
      try {
        const account = this.getActiveAccount();
        if (!account.enabled) {
          await sleep(5_000, signal);
          continue;
        }
        if (isPaused(account.account_id)) {
          await sleep(10_000, signal);
          continue;
        }

        const cursor = getWeixinPollCursor(account.account_id);
        const response = await getUpdates(this.getCredentials(), cursor);

        if (response.errcode === ERRCODE_SESSION_EXPIRED) {
          setPaused(account.account_id, "Session expired (errcode -14)");
          this.status = "error";
          emitStatus(this.opts.assistantId, "error", "微信会话已过期，请重新扫码登录");
          await sleep(10_000, signal);
          continue;
        }

        if (response.errcode && response.errcode !== 0) {
          throw new Error(`WeChat API error: ${response.errcode} ${response.errmsg || ""}`.trim());
        }

        const messages = response.msgs ?? [];
        for (const message of messages) {
          await this.handleIncomingMessage(message);
        }

        if (response.get_updates_buf) {
          setWeixinPollCursor(account.account_id, response.get_updates_buf);
        }

        if (this.status !== "connected") {
          this.status = "connected";
          emitStatus(this.opts.assistantId, "connected");
        }
        this.consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted || this.stopped) break;
        this.consecutiveFailures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        this.status = "error";
        emitStatus(this.opts.assistantId, "error", detail);
        const backoff = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
          BACKOFF_MAX_MS,
        );
        await sleep(backoff, signal);
      }
    }
  }

  private async handleIncomingMessage(message: WeixinMessage): Promise<void> {
    const peerUserId = message.from_user_id;
    if (!peerUserId) return;

    const dedupKey = `wx:${this.opts.assistantId}:${message.message_id || message.seq || Date.now()}`;
    if (isDuplicate(dedupKey) || this.inflight.has(dedupKey)) return;
    markProcessed(dedupKey);
    this.inflight.add(dedupKey);

    try {
      if (!isAllowed(peerUserId, this.opts)) return;

      if (!(this.opts.ownerUserIds?.length)) {
        const updated = patchAssistantBotOwnerIds(this.opts.assistantId, "weixin", peerUserId);
        if (updated) {
          this.opts.ownerUserIds = [peerUserId];
        }
      }

      if (message.context_token) {
        upsertWeixinContextToken(this.opts.accountId, peerUserId, message.context_token);
      }

      const extracted = await this.extractIncomingContent(message);
      if (!extracted.text) return;

      const commandText = extracted.text.trim();
      if (commandText === "/myid" || commandText === "/我的id" || commandText === "/我的ID") {
        await this.sendPlainText(peerUserId, `你的微信用户 ID：${peerUserId}`);
        return;
      }

      if (commandText === "/new" || commandText === "/reset" || commandText === "/重置") {
        const chatId = encodeWeixinChatId(this.opts.accountId, peerUserId);
        const historyKey = `${this.opts.assistantId}:${chatId}`;
        histories.delete(historyKey);
        botSessionIds.delete(historyKey);
        botClaudeSessionIds.delete(historyKey);
        await this.sendPlainText(peerUserId, "对话已重置，开始新的对话吧！");
        return;
      }

      await this.sendTypingIndicator(peerUserId, TypingStatus.TYPING);
      try {
        await this.generateAndDeliver(peerUserId, extracted.text);
      } finally {
        await this.sendTypingIndicator(peerUserId, TypingStatus.CANCEL);
      }
    } finally {
      this.inflight.delete(dedupKey);
    }
  }

  private async extractIncomingContent(message: WeixinMessage): Promise<{ text: string; filePaths?: string[] }> {
    let text = "";
    for (const item of message.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        text += item.text_item.text;
      }
    }

    if (message.ref_message) {
      const refParts = [message.ref_message.title, message.ref_message.content].filter(Boolean);
      if (refParts.length > 0) {
        text = `[引用: ${refParts.join(" | ")}]\n${text}`;
      }
    }

    const items = message.item_list ?? [];
    const mediaItemCount = items.filter(
      (item) =>
        item.type === MessageItemType.IMAGE ||
        item.type === MessageItemType.VOICE ||
        item.type === MessageItemType.FILE ||
        item.type === MessageItemType.VIDEO,
    ).length;

    const filePaths = await this.downloadMediaItems(items, this.opts.mediaEnabled !== false);
    let finalText = text.trim();
    if (!finalText && filePaths.length > 0) {
      finalText = filePaths.length > 1 ? `用户发送了 ${filePaths.length} 个附件` : "用户发送了一个附件";
    }
    if (mediaItemCount > 0 && filePaths.length === 0) {
      const hint =
        this.opts.mediaEnabled === false
          ? "（媒体下载已在设置中关闭，如需识别图片请开启「下载媒体附件」。）"
          : "（媒体已收到但下载失败，常见原因：CDN 链接过期、网络或微信 CDN 临时不可用；可让对方重发一次图片。）";
      finalText = finalText ? `${finalText}\n\n${hint}` : `用户发送了媒体消息。${hint}`;
    }
    if (filePaths.length > 0) {
      const pathsNote = filePaths.map((filePath) => `文件路径: ${filePath}`).join("\n");
      finalText = `${finalText}\n\n${pathsNote}\n⚠️ 这是一个新文件，请直接读取上述路径的文件内容，不要参考任何历史对话中出现过的文件内容。`;
    }

    return {
      text: finalText.trim(),
      filePaths: filePaths.length > 0 ? filePaths : undefined,
    };
  }

  private async downloadMediaItems(items: MessageItem[], enabled = true): Promise<string[]> {
    if (!enabled) return [];
    const filePaths: string[] = [];
    const creds = this.getCredentials();

    for (const item of items) {
      if (item.type === MessageItemType.TEXT) continue;
      try {
        const media = await downloadMediaFromItem(item, creds.cdnBaseUrl);
        if (!media) continue;
        const safeName = sanitizeTmpName(media.filename);
        const filePath = join(tmpdir(), `dinoclaw-weixin-${Date.now()}-${safeName}`);
        writeFileSync(filePath, media.data);
        filePaths.push(filePath);
      } catch (error) {
        console.warn("[Weixin] Failed to download media:", error);
      }
    }

    return filePaths;
  }

  private async generateAndDeliver(peerUserId: string, incomingText: string): Promise<void> {
    const skillContext = resolveSkillPromptContext(incomingText, this.opts.skillNames);
    const effectiveUserText = skillContext?.userText ?? incomingText;
    const chatId = encodeWeixinChatId(this.opts.accountId, peerUserId);
    const historyKey = `${this.opts.assistantId}:${chatId}`;
    const history = getHistory(historyKey);
    const provider = this.opts.provider ?? "claude";
    const isOwner = Boolean(peerUserId && this.opts.ownerUserIds?.includes(peerUserId));
    const sensitiveTurnState: SharedMcpSensitiveTurnState = { active: false };
    const persistedMessages: StreamMessage[] = [];

    const sessionId = getBotSession(
      this.opts.assistantId,
      chatId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
      this.opts.skillNames,
    );

    trackAnalytics("bot_claw_trigger", {
      source_type: "bot",
      source_channel: "weixin",
      assistant_id: this.opts.assistantId,
      session_id: sessionId,
      provider,
      prompt_length: effectiveUserText.length,
      is_group: false,
      is_owner: isOwner,
    });

    const historyLengthBeforeTurn = history.length;
    history.push({ role: "user", content: effectiveUserText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = await buildSmartMemoryContext(
      effectiveUserText,
      this.opts.assistantId,
      this.opts.defaultCwd,
    );
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowStr = new Date().toLocaleString("zh-CN", { timeZone: timezone, hour12: false });
    const currentTimeContext = `## 当前时间\n消息发送时间：${nowStr}（时区：${timezone}）`;
    const historySection =
      history.length > 1 ? buildHistoryContext(history.slice(0, -1), this.opts.assistantId) : undefined;
    const skillSection = buildActivatedSkillSection(skillContext?.skillContent);
    const privateWhitelistSection = isOwner ? PRIVATE_WHITELIST_RULE : undefined;
    const includeCursorDelegation = shouldIncludeCursorDelegation(
      effectiveUserText,
      skillContext?.skillName,
    );
    const system = buildStructuredPersona(
      this.opts,
      currentTimeContext,
      memoryContext,
      skillSection,
      historySection,
      privateWhitelistSection,
    );

    let replyText = "";
    try {
      replyText = await this.runClaudeQuery(
        system,
        effectiveUserText,
        historyKey,
        provider,
        sessionId,
        peerUserId,
        isOwner,
        sensitiveTurnState,
        persistedMessages,
        includeCursorDelegation,
      );
    } catch (error) {
      console.error("[Weixin] AI error:", error);
      replyText = "抱歉，处理你的消息时遇到了问题，请稍后再试。";
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

    await this.deliverReply(peerUserId, replyText);

    if (shouldPersistTurn) {
      scheduleBotPostResponseTasks({
        logEntry: `\n## ${new Date().toLocaleTimeString("zh-CN")}\n**我**: ${effectiveUserText}\n**${this.opts.assistantName}**: ${replyText}\n`,
        recordOpts: { assistantId: this.opts.assistantId, assistantName: this.opts.assistantName, channel: "WeChat" },
        updateTitle: () => updateBotSessionTitle(sessionId, historySnapshot),
        onError: (phase, error) => {
          if (phase === "updateTitle") {
            console.warn("[Weixin] Failed to update session title:", error);
          } else {
            console.warn("[Weixin] Failed to persist conversation:", error);
          }
        },
      });
    }
  }

  private async runClaudeQuery(
    system: string,
    userText: string,
    historyKey: string,
    provider: "claude" | "openai",
    sessionId: string,
    peerUserId: string,
    isOwner: boolean,
    sensitiveTurnState: SharedMcpSensitiveTurnState,
    persistedMessages: StreamMessage[],
    includeCursorDelegation: boolean,
  ): Promise<string> {
    const claudeSessionId = getBotClaudeSessionId(historyKey);
    const assistantConfig = (() => {
      const config = loadAssistantsConfig();
      return config.assistants.find((assistant) => assistant.id === this.opts.assistantId);
    })();

    const env = buildQueryEnv(assistantConfig);
    const sharedMcp = createSharedMcpServer({
      assistantId: this.opts.assistantId,
      sessionCwd: this.opts.defaultCwd,
      isOwner,
      sensitiveTurnState,
      includeCursorDelegation,
    });

    const sendFileTool = tool(
      "send_file",
      "发送文件给微信用户。支持图片、视频、语音和普通文件。",
      { file_path: z.string().describe("本地文件绝对路径") },
      async (input: { file_path: string }) => {
        try {
          const prepared = prepareVisibleArtifact(String(input.file_path ?? ""), {
            defaultCwd: this.opts.defaultCwd,
            assistantName: this.opts.assistantName,
            assistantId: this.opts.assistantId,
          });
          if (prepared.error) {
            return { content: [{ type: "text" as const, text: prepared.error }] };
          }
          await this.sendLocalFile(peerUserId, prepared.filePath);
          return {
            content: [{ type: "text" as const, text: `已发送文件: ${basename(prepared.filePath)}` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `发送失败: ${error instanceof Error ? error.message : String(error)}` }],
          };
        }
      },
    );

    const sessionMcp = createSdkMcpServer({
      name: "weixin-session",
      tools: [sendFileTool],
    });

    const cwd = this.opts.defaultCwd || homedir();
    const query = await runAgent(userText, {
      systemPrompt: system,
      resume: claudeSessionId,
      cwd,
      ...(provider === "claude" && { env }),
      ...(provider === "openai" && {
        openaiOverrides: buildOpenAIOverrides(assistantConfig, this.opts.model),
      }),
      pathToClaudeCodeExecutable: getClaudeCodePath(),
      provider,
      mcpServers: {
        "vk-shared": sharedMcp,
        "weixin-session": sessionMcp,
        ...loadMcporterServers(),
      },
    });

    let finalText = "";
    let bufferedAssistant: StreamMessage | null = null;
    const persistStreamMessage = (message: StreamMessage) => {
      persistedMessages.push(message);
    };

    for await (const message of query) {
      bufferedAssistant = bufferPersistedBotMessage(
        message as StreamMessage,
        bufferedAssistant,
        persistStreamMessage,
      );
      const typed = message as Record<string, unknown>;
      if (typed.type === "result" && typed.subtype === "success") {
        finalText = String(typed.result || "");
        if (!sensitiveTurnState.active && typeof typed.session_id === "string") {
          setBotClaudeSessionId(historyKey, typed.session_id);
        }
      } else {
        const partial = extractPartialText(typed);
        if (partial) finalText = partial;
      }
    }

    flushBufferedBotAssistantMessage(bufferedAssistant, persistStreamMessage);
    return finalText || "（无回复）";
  }

  private async deliverReply(peerUserId: string, replyText: string): Promise<void> {
    const segments = parseReplySegments(replyText);
    const hasImages = segments.some((segment) => segment.kind === "image");

    if (hasImages) {
      for (const segment of segments) {
        if (segment.kind === "text") {
          const text = stripRichText(segment.content);
          if (!text) continue;
          for (const chunk of chunkMessage(text)) {
            await this.sendPlainText(peerUserId, chunk);
          }
        } else {
          await this.sendLocalFile(peerUserId, segment.path);
        }
      }
      return;
    }

    const normalizedText = stripRichText(replyText);
    for (const chunk of chunkMessage(normalizedText || "（无回复）")) {
      await this.sendPlainText(peerUserId, chunk);
    }
  }

  private async sendPlainText(peerUserId: string, text: string): Promise<void> {
    const contextToken = getWeixinContextToken(this.opts.accountId, peerUserId);
    if (!contextToken) {
      throw new Error(`缺少 context_token，无法向 ${peerUserId} 发送消息`);
    }
    await sendTextMessage(this.getCredentials(), peerUserId, text, contextToken);
  }

  private async sendLocalFile(peerUserId: string, filePath: string): Promise<void> {
    const contextToken = getWeixinContextToken(this.opts.accountId, peerUserId);
    if (!contextToken) {
      throw new Error(`缺少 context_token，无法向 ${peerUserId} 发送文件`);
    }

    const fileBuffer = readFileSync(filePath);
    const mediaType = inferWeixinUploadMediaType(filePath);
    const uploaded = await uploadMediaToCdn(this.getCredentials(), fileBuffer, mediaType, peerUserId);
    const item = buildOutboundMediaItem(
      mediaType,
      uploaded,
      filePath,
      statSync(filePath).size,
    );
    await sendMessage(this.getCredentials(), peerUserId, [item], contextToken);
  }

  private async sendTypingIndicator(peerUserId: string, status: number): Promise<void> {
    const contextToken = getWeixinContextToken(this.opts.accountId, peerUserId);
    if (!contextToken) return;

    const ticketKey = `${this.opts.accountId}:${peerUserId}`;
    let ticket = this.typingTickets.get(ticketKey);
    if (!ticket) {
      try {
        const config = await getConfig(this.getCredentials(), peerUserId, contextToken);
        if (config.typing_ticket) {
          ticket = config.typing_ticket;
          this.typingTickets.set(ticketKey, ticket);
        }
      } catch {
        return;
      }
    }
    if (!ticket) return;
    await apiSendTyping(this.getCredentials(), peerUserId, ticket, status);
  }
}
