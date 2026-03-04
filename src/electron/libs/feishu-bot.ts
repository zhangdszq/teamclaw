/**
 * Feishu (Lark) WebSocket Bot Service
 *
 * Mirrors the DingTalk Stream bot implementation:
 * - Feishu SDK @larksuiteoapi/node-sdk WSClient for long-connection
 * - Extensible tool registry (take_screenshot, send_file, bash, send_message, web_fetch, web_search, read_file, write_file)
 * - AI provider selection: Anthropic Claude or OpenAI Codex
 * - Session/memory sync with the in-app session store
 * - Conversation history (last N turns)
 * - Dynamic session title generation
 * - Message deduplication
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EventEmitter } from "events";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { loadUserSettings } from "./user-settings.js";
import { getCodexBinaryPath } from "./codex-runner.js";
import { buildSmartMemoryContext, recordConversation } from "./memory-store.js";
import { getClaudeCodePath } from "./util.js";
import { getSettingSources } from "./claude-settings.js";
import type { SessionStore } from "./session-store.js";
import { createSharedMcpServer } from "./shared-mcp.js";
import {
  type ConvMessage,
  buildQueryEnv,
  buildStructuredPersona,
  buildHistoryContext,
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
  parseReplySegments,
} from "./bot-base.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FeishuBotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface FeishuBotOptions {
  appId: string;
  appSecret: string;
  /** "feishu" (default) or "lark" */
  domain?: "feishu" | "lark";
  assistantId: string;
  assistantName: string;
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  userContext?: string;
  provider?: "claude" | "codex";
  model?: string;
  defaultCwd?: string;
  /** Max reconnect attempts (default: 10) */
  maxConnectionAttempts?: number;
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
  // Clean up related maps to prevent memory leaks
  const keysToClean = Array.from(histories.keys()).filter(k => k.startsWith(assistantId));
  for (const key of keysToClean) {
    histories.delete(key);
    botSessionIds.delete(key);
  }
  emit(assistantId, "disconnected");
}

export function getFeishuBotStatus(assistantId: string): FeishuBotStatus {
  return pool.get(assistantId)?.status ?? "disconnected";
}

/** Returns the first assistantId that has a connected Feishu bot, or null. */
export function getAnyConnectedFeishuAssistantId(): string | null {
  for (const [id, conn] of pool.entries()) {
    if (conn.status === "connected") return id;
  }
  return null;
}

// ─── Proactive messaging ───────────────────────────────────────────────────────

/** Records the most recently active chatId for proactive messaging fallback. */
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

function getHistory(assistantId: string): ConvMessage[] {
  if (!histories.has(assistantId)) histories.set(assistantId, []);
  return histories.get(assistantId)!;
}

function getBotSession(
  assistantId: string,
  assistantName: string,
  provider: "claude" | "codex",
  model: string | undefined,
  cwd: string | undefined,
): string {
  if (botSessionIds.has(assistantId)) return botSessionIds.get(assistantId)!;
  if (!sessionStore) throw new Error("[Feishu] SessionStore not injected");
  const session = sessionStore.createSession({
    title: `[飞书] ${assistantName}`,
    assistantId,
    provider,
    model,
    cwd,
  });
  botSessionIds.set(assistantId, session.id);
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

// ─── Claude session ID registry (for query() resume) ─────────────────────────

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

// ─── FeishuConnection ──────────────────────────────────────────────────────────

class FeishuConnection {
  status: FeishuBotStatus = "disconnected";
  private wsClient: InstanceType<typeof lark.WSClient> | null = null;
  private feishuClient: InstanceType<typeof lark.Client>;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Set<string>();

  constructor(private opts: FeishuBotOptions) {
    const domain = opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.feishuClient = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.status = "connecting";
    emit(this.opts.assistantId, "connecting");

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
    try {
      this.wsClient?.close();
    } catch { /* ignore */ }
    this.wsClient = null;
    this.status = "disconnected";
  }

  private async connect(): Promise<void> {
    const domain = this.opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    const dispatcher = new lark.EventDispatcher({
      encryptKey: "",
    }).register({
      "im.message.receive_v1": async (data: Record<string, unknown>) => {
        try {
          await this.handleMessage(data);
        } catch (err) {
          console.error("[Feishu] Message handling error:", err);
        }
      },
    });

    const wsClient = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain,
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

      // The Feishu SDK WSClient.start() doesn't return a promise indicating
      // connection success, so we use a timeout to detect initial failures.
      const connectTimeout = setTimeout(() => {
        if (this.status === "connecting") {
          // Still connecting after 10s — assume success (SDK is polling)
          this.status = "connected";
          emit(this.opts.assistantId, "connected");
          this.reconnectAttempts = 0;
          console.log(`[Feishu] Connected: assistant=${this.opts.assistantId}`);
          settle();
        }
      }, 10_000);

      wsClient.start({ eventDispatcher: dispatcher }).then(() => {
        clearTimeout(connectTimeout);
        if (!this.stopped) {
          this.status = "connected";
          emit(this.opts.assistantId, "connected");
          this.reconnectAttempts = 0;
          console.log(`[Feishu] Connected: assistant=${this.opts.assistantId}`);
          settle();
        }
      }).catch((err: Error) => {
        clearTimeout(connectTimeout);
        console.error("[Feishu] WSClient.start() failed:", err.message);
        this.status = "error";
        emit(this.opts.assistantId, "error", err.message);
        if (!this.stopped) {
          settle(err);
        }
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
      this.connect().catch((err) => {
        console.error("[Feishu] Reconnect failed:", err.message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Message handling ──────────────────────────────────────────────────────────

  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    const message = data.message as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;
    if (!message || !sender) return;

    const messageId = String(message.message_id ?? "");
    const msgType = String(message.message_type ?? "text");
    const chatId = String(message.chat_id ?? "");
    const senderId = String((sender.sender_id as Record<string, unknown>)?.open_id ?? "");

    // Skip bot's own messages
    const senderType = String(sender.sender_type ?? "");
    if (senderType === "app") return;

    // Record last-seen chatId for proactive messaging
    recordLastSeenChat(this.opts.assistantId, chatId);

    // Deduplication
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
      const extracted = this.extractText(message, msgType);
      if (!extracted) return;

      console.log(`[Feishu] Message (${msgType}): ${extracted.slice(0, 100)}`);

      await this.generateAndDeliver(extracted, senderId, chatId, messageId);
    } finally {
      if (dedupKey) this.inflight.delete(dedupKey);
    }
  }

  private extractText(message: Record<string, unknown>, msgType: string): string | null {
    try {
      const contentRaw = String(message.content ?? "{}");
      const content = JSON.parse(contentRaw) as Record<string, unknown>;

      if (msgType === "text") {
        const text = String(content.text ?? "").trim();
        // Strip @bot mention in group chats
        return text.replace(/@[^\s]+\s*/g, "").trim() || null;
      }

      if (msgType === "post") {
        // Rich text - extract all text nodes
        const parts: string[] = [];
        const content2 = content as { content?: Array<Array<{ tag?: string; text?: string }>> };
        for (const line of content2.content ?? []) {
          for (const node of line) {
            if (node.tag === "text" && node.text) parts.push(node.text);
          }
        }
        return parts.join("").trim() || "[富文本消息]";
      }

      if (msgType === "image") return "[图片消息]";
      if (msgType === "audio") return "[语音消息]";
      if (msgType === "file") return `[文件: ${String(content.file_name ?? "未知")}]`;
      if (msgType === "video") return "[视频消息]";
      if (msgType === "sticker") return "[表情包]";

      return `[${msgType} 消息]`;
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
  ): Promise<void> {
    const history = getHistory(this.opts.assistantId);
    const provider = this.opts.provider ?? "claude";

    const sessionId = getBotSession(
      this.opts.assistantId,
      this.opts.assistantName,
      provider,
      this.opts.model,
      this.opts.defaultCwd,
    );

    sessionStore?.recordMessage(sessionId, { type: "user_prompt", prompt: userText });
    updateBotSessionTitle(sessionId, userText).catch((e) => console.warn("[Feishu] Failed to update session title:", e));

    history.push({ role: "user", content: userText });
    while (history.length > MAX_TURNS * 2) history.shift();

    const memoryContext = await buildSmartMemoryContext(userText, this.opts.assistantId, this.opts.defaultCwd);
    const historySection = history.length > 1
      ? buildHistoryContext(history.slice(0, -1), this.opts.assistantId)
      : undefined;
    const system = buildStructuredPersona(this.opts, memoryContext, historySection);

    let replyText: string;

    try {
      if (provider === "codex") {
        replyText = await this.runCodexSession(system, history, userText);
      } else {
        replyText = await this.runClaudeQuery(system, userText, messageId, chatId);
      }
    } catch (err) {
      console.error("[Feishu] AI error:", err);
      replyText = "抱歉，处理您的消息时遇到了问题，请稍后再试。";
    }

    history.push({ role: "assistant", content: replyText });
    this.persistReply(sessionId, replyText, userText);

    await this.sendReply(messageId, chatId, replyText);
  }

  /** Claude query() path via Agent SDK with shared MCP + per-session MCP */
  private async runClaudeQuery(
    system: string,
    userText: string,
    messageId: string,
    chatId: string,
  ): Promise<string> {
    const sessionMcp = this.createSessionMcp(messageId, chatId);
    const sharedMcp = createSharedMcpServer({ assistantId: this.opts.assistantId, sessionCwd: this.opts.defaultCwd });
    const claudeSessionId = getBotClaudeSessionId(this.opts.assistantId);
    const claudeCodePath = getClaudeCodePath();

    let finalText = "";
    const q = query({
      prompt: userText,
      options: {
        systemPrompt: system,
        resume: claudeSessionId,
        cwd: this.opts.defaultCwd ?? homedir(),
        mcpServers: { "vk-shared": sharedMcp, "fs-session": sessionMcp },
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        allowDangerouslySkipPermissions: true,
        maxTurns: 300,
        settingSources: getSettingSources(),
        pathToClaudeCodeExecutable: claudeCodePath,
        env: buildQueryEnv(),
      },
    });

    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        finalText = message.result;
        setBotClaudeSessionId(this.opts.assistantId, message.session_id);
      }
    }

    return finalText || "抱歉，无法生成回复。";
  }

  /** Per-session MCP server with send_message + send_file tools bound to current context */
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

    return createSdkMcpServer({ name: "feishu-session", tools: [sendMessageTool, sendFileTool] });
  }

  /** Codex provider session */
  private async runCodexSession(
    system: string,
    history: ConvMessage[],
    userText: string,
  ): Promise<string> {
    const codexOpts: CodexOptions = {};
    const codexPath = getCodexBinaryPath();
    if (codexPath) codexOpts.codexPathOverride = codexPath;

    const codex = new Codex(codexOpts);
    const threadOpts: ThreadOptions = {
      model: this.opts.model || "gpt-5.3-codex",
      workingDirectory: this.opts.defaultCwd || homedir(),
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };

    const historyLines = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const fullPrompt = `${system}\n\n${historyLines}\n\nPlease reply to the latest user message above.`;

    const thread = codex.startThread(threadOpts);
    const { events } = await thread.runStreamed(fullPrompt, {});

    const textParts: string[] = [];
    for await (const event of events) {
      if (
        event.type === "item.completed" &&
        event.item.type === "agent_message" &&
        event.item.text
      ) {
        textParts.push(event.item.text);
      }
    }
    return textParts.join("").trim() || "抱歉，无法生成回复。";
  }

  /** File upload and send via Feishu API */
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
          return `图片压缩后仍超过 20MB，建议先裁剪或降低分辨率。`;
        }
      } catch {
        cleanup();
        return `图片超过 20MB 限制，压缩失败，请先手动压缩。`;
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

  // ── Send message ──────────────────────────────────────────────────────────────

  /**
   * Upload a local image file to Feishu and return the image_key.
   * Returns null on failure.
   */
  private async uploadImageForPost(filePath: string): Promise<string | null> {
    try {
      const fs = await import("fs");
      const imageBuffer = fs.readFileSync(filePath);
      const uploadResp = await this.feishuClient.im.image.create({
        data: { image_type: "message", image: imageBuffer },
      });
      const imageKey = (uploadResp as Record<string, unknown>)?.image_key as string | undefined;
      return imageKey ?? null;
    } catch (err) {
      console.error("[Feishu] Image upload error:", err);
      return null;
    }
  }

  private async sendReply(messageId: string, chatId: string, text: string): Promise<void> {
    try {
      const segments = parseReplySegments(text);
      const hasImages = segments.some((s) => s.kind === "image");

      if (hasImages) {
        // Build Feishu "post" rich-text content: each segment becomes a paragraph.
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
              // Fallback: mention path as text if upload failed
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

      // No images — plain text path (existing behavior)
      if (messageId) {
        await this.feishuClient.im.message.reply({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify({ text }),
            msg_type: "text",
            reply_in_thread: false,
          },
        });
        return;
      }

      // Fallback: send to chat
      if (chatId) {
        await this.feishuClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: "text",
          },
        });
      }
    } catch (err) {
      console.error("[Feishu] Send reply error:", err);
    }
  }

  async sendProactive(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.feishuClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Feishu] Proactive send error:", msg);
      return { ok: false, error: msg };
    }
  }

}
