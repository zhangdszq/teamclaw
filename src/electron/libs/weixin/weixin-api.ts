/**
 * WeChat ilink bot HTTP client.
 */

import crypto from "crypto";
import type {
  GetConfigResponse,
  GetUpdatesResponse,
  GetUploadUrlResponse,
  MessageItem,
  QrCodeStartResponse,
  QrCodeStatusResponse,
  SendMessageResponse,
  WeixinCredentials,
} from "./weixin-types.js";
import {
  DEFAULT_BASE_URL,
  MessageItemType,
  MessageState,
  MessageType,
} from "./weixin-types.js";

const CHANNEL_VERSION = "dinoclaw-weixin-bot/1.0";
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const QR_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_LOGIN_TIMEOUT_MS = 40_000;

function generateWechatUin(): string {
  return crypto.randomBytes(4).toString("base64");
}

function buildHeaders(creds: WeixinCredentials, routeTag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${creds.botToken}`,
    "X-WECHAT-UIN": generateWechatUin(),
  };
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }
  return headers;
}

async function weixinRequest<T>(
  creds: WeixinCredentials,
  endpoint: string,
  body: unknown,
  timeoutMs = API_TIMEOUT_MS,
  routeTag?: string,
): Promise<T> {
  const baseUrl = creds.baseUrl || DEFAULT_BASE_URL;
  const url = `${baseUrl}/ilink/bot/${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(creds, routeTag),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`WeChat API error: ${response.status} ${response.statusText}`);
  }

  const rawText = await response.text();
  if (!rawText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch (error) {
    throw new Error(
      `WeChat API returned non-JSON body for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function getUpdates(
  creds: WeixinCredentials,
  getUpdatesBuf: string,
  timeoutMs = LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResponse> {
  try {
    return await weixinRequest<GetUpdatesResponse>(
      creds,
      "getupdates",
      {
        get_updates_buf: getUpdatesBuf ?? "",
        base_info: { channel_version: CHANNEL_VERSION },
      },
      timeoutMs + 5_000,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

function generateClientId(): string {
  return `dinoclaw-wx-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function sendMessage(
  creds: WeixinCredentials,
  toUserId: string,
  items: MessageItem[],
  contextToken: string,
): Promise<{ clientId: string }> {
  const clientId = generateClientId();
  await weixinRequest<SendMessageResponse>(
    creds,
    "sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: items.length > 0 ? items : undefined,
        context_token: contextToken || undefined,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
  );
  return { clientId };
}

export async function sendTextMessage(
  creds: WeixinCredentials,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<{ clientId: string }> {
  return sendMessage(
    creds,
    toUserId,
    [{ type: MessageItemType.TEXT, text_item: { text } }],
    contextToken,
  );
}

export async function getUploadUrl(
  creds: WeixinCredentials,
  fileKey: string,
  mediaType: number,
  rawSize: number,
  rawFileMd5: string,
  cipherFileSize: number,
  toUserId: string,
  aesKeyHex: string,
): Promise<GetUploadUrlResponse> {
  return weixinRequest<GetUploadUrlResponse>(creds, "getuploadurl", {
    filekey: fileKey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: rawSize,
    rawfilemd5: rawFileMd5,
    filesize: cipherFileSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: CHANNEL_VERSION },
  });
}

export async function getConfig(
  creds: WeixinCredentials,
  ilinkUserId?: string,
  contextToken?: string,
): Promise<GetConfigResponse> {
  return weixinRequest<GetConfigResponse>(
    creds,
    "getconfig",
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: { channel_version: CHANNEL_VERSION },
    },
    CONFIG_TIMEOUT_MS,
  );
}

export async function sendTyping(
  creds: WeixinCredentials,
  ilinkUserId: string,
  typingTicket: string,
  typingStatus: number,
): Promise<void> {
  try {
    await weixinRequest<Record<string, never>>(
      creds,
      "sendtyping",
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status: typingStatus,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      CONFIG_TIMEOUT_MS,
    );
  } catch {
    // Typing is best-effort only.
  }
}

export async function startLoginQr(): Promise<QrCodeStartResponse> {
  const url = `${QR_LOGIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`QR login start failed: ${response.status}`);
  }
  return (await response.json()) as QrCodeStartResponse;
}

export async function pollLoginQrStatus(qrcode: string): Promise<QrCodeStatusResponse> {
  const url = `${QR_LOGIN_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(QR_LOGIN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`QR status poll failed: ${response.status}`);
  }
  return (await response.json()) as QrCodeStatusResponse;
}
