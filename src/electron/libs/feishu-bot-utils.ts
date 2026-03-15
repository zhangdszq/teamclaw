import {
  isDuplicate as isDuplicateMsg,
  markProcessed as markProcessedMsg,
} from "./bot-base.js";
import { createHash } from "crypto";

export type FeishuInboundSource = "webhook" | "websocket";

export interface FeishuInboundMeta {
  source: FeishuInboundSource;
  eventId?: string;
}

export interface FeishuDeliveryState {
  streamStarted: boolean;
  streamingMsgId: string | null;
  lastToolMessage: string | null;
  toolMessageCount: number;
}

function hashFeishuKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 24);
}

export function buildFeishuInboundKeys(
  assistantId: string,
  messageId?: string,
  eventId?: string,
): string[] {
  const keys: string[] = [];
  if (eventId) keys.push(`feishu-event:${assistantId}:${eventId}`);
  if (messageId) keys.push(`feishu:${assistantId}:${messageId}`);
  return keys;
}

export function buildFeishuContentDedupKey(
  assistantId: string,
  chatId: string,
  senderId: string,
  msgType: string,
  createTime?: string,
  rawContent?: string,
): string | null {
  if (!createTime || !rawContent) return null;
  const normalizedContent = rawContent.trim();
  if (!normalizedContent) return null;
  return `feishu-content:${assistantId}:${chatId}:${senderId}:${msgType}:${createTime}:${hashFeishuKey(normalizedContent)}`;
}

export function claimFeishuInboundKeys(
  keys: string[],
  store: Map<string, number>,
  inflight: Set<string>,
): boolean {
  if (keys.some((key) => isDuplicateMsg(key, store) || inflight.has(key))) {
    return false;
  }
  for (const key of keys) {
    markProcessedMsg(key, store);
    inflight.add(key);
  }
  return true;
}

export function releaseFeishuInboundKeys(keys: string[], inflight: Set<string>): void {
  for (const key of keys) inflight.delete(key);
}

export function normalizeFeishuComparableText(text: string): string {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldSkipFeishuFinalReply(lastToolMessage: string | null, finalReply: string): boolean {
  if (!lastToolMessage) return false;
  const normalizedTool = normalizeFeishuComparableText(lastToolMessage);
  const normalizedFinal = normalizeFeishuComparableText(finalReply);
  return Boolean(normalizedTool) && normalizedTool === normalizedFinal;
}

export function buildFeishuRequestUuid(
  kind: string,
  assistantId: string,
  messageId: string,
  chatId: string,
  salt: string,
): string {
  const hash = hashFeishuKey([kind, assistantId, messageId || "-", chatId || "-", salt].join("|"));
  return `fs-${kind}-${hash}`;
}
