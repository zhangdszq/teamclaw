/**
 * WeChat CDN media encryption helpers.
 */

import crypto from "crypto";
import type { CDNMedia, MessageItem, WeixinCredentials } from "./weixin-types.js";
import { MessageItemType, UploadMediaType } from "./weixin-types.js";
import { getUploadUrl } from "./weixin-api.js";

const MAX_MEDIA_SIZE = 100 * 1024 * 1024;

export function generateMediaKey(): Buffer {
  return crypto.randomBytes(16);
}

export function encryptMedia(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function decryptMedia(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Parse AES key from a message item.
 * Two encodings exist in the wild:
 *   - base64(raw 16 bytes) — images
 *   - base64(32-char hex string of 16 bytes) — file / voice / video
 * Also handles the legacy hex-only `aeskey` field.
 */
function parseAesKey(item: { aeskey?: string; media?: CDNMedia }): Buffer | null {
  if (item.aeskey && item.aeskey.length === 32) {
    return Buffer.from(item.aeskey, "hex");
  }
  if (item.media?.aes_key) {
    const decoded = Buffer.from(item.media.aes_key, "base64");
    if (decoded.length === 16) {
      return decoded;
    }
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
      return Buffer.from(decoded.toString("ascii"), "hex");
    }
    console.warn(`[Weixin-media] Unexpected aes_key length after base64 decode: ${decoded.length} bytes`);
    return null;
  }
  return null;
}

export function buildCdnDownloadUrl(cdnBaseUrl: string, encryptQueryParam: string): string {
  const base = cdnBaseUrl.replace(/\/+$/, "");
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, fileKey: string): string {
  const base = cdnBaseUrl.replace(/\/+$/, "");
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
}

const WEIXIN_CDN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MicroMessenger/7.0.20";

export async function downloadAndDecryptMedia(
  cdnUrl: string,
  aesKey: Buffer,
  label = "media",
): Promise<Buffer> {
  const response = await fetch(cdnUrl, {
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: "*/*",
      "User-Agent": WEIXIN_CDN_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`CDN download failed for ${label}: ${response.status}`);
  }
  const encrypted = Buffer.from(await response.arrayBuffer());
  if (encrypted.length > MAX_MEDIA_SIZE) {
    throw new Error(`Media too large: ${encrypted.length} bytes`);
  }
  return decryptMedia(encrypted, aesKey);
}

export async function downloadMediaFromItem(
  item: MessageItem,
  cdnBaseUrl: string,
): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
  let encryptParam: string | undefined;
  let aesKey: Buffer | null = null;
  let mimeType = "application/octet-stream";
  let filename = "file";

  switch (item.type) {
    case MessageItemType.IMAGE:
      if (item.image_item) {
        encryptParam = item.image_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.image_item);
        mimeType = "image/jpeg";
        filename = `image_${Date.now()}.jpg`;
      }
      break;
    case MessageItemType.VOICE:
      if (item.voice_item) {
        encryptParam = item.voice_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.voice_item);
        mimeType = "audio/silk";
        filename = `voice_${Date.now()}.silk`;
      }
      break;
    case MessageItemType.FILE:
      if (item.file_item) {
        encryptParam = item.file_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.file_item);
        filename = item.file_item.file_name || `file_${Date.now()}`;
        const ext = filename.split(".").pop()?.toLowerCase();
        if (ext) {
          const mimeMap: Record<string, string> = {
            pdf: "application/pdf",
            doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xls: "application/vnd.ms-excel",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            txt: "text/plain",
            zip: "application/zip",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
          };
          mimeType = mimeMap[ext] || mimeType;
        }
      }
      break;
    case MessageItemType.VIDEO:
      if (item.video_item) {
        encryptParam = item.video_item.media?.encrypt_query_param;
        aesKey = parseAesKey(item.video_item);
        mimeType = "video/mp4";
        filename = `video_${Date.now()}.mp4`;
      }
      break;
    default:
      break;
  }

  if (!encryptParam || !aesKey) return null;
  const cdnUrl = buildCdnDownloadUrl(cdnBaseUrl, encryptParam);
  const data = await downloadAndDecryptMedia(cdnUrl, aesKey, filename);
  return { data, mimeType, filename };
}

export async function uploadMediaToCdn(
  creds: WeixinCredentials,
  data: Buffer,
  mediaType: number,
  toUserId: string,
): Promise<{ encryptQueryParam: string; aesKeyBase64: string; cipherSize: number }> {
  const plainMd5 = crypto.createHash("md5").update(data).digest("hex");
  const aesKey = generateMediaKey();
  const fileKey = crypto.randomBytes(16).toString("hex");
  const cipherSize = aesEcbPaddedSize(data.length);

  const uploadResp = await getUploadUrl(
    creds,
    fileKey,
    mediaType,
    data.length,
    plainMd5,
    cipherSize,
    toUserId,
    aesKey.toString("hex"),
  );
  if (!uploadResp.upload_param) {
    throw new Error(`Failed to get WeChat upload URL: ${JSON.stringify(uploadResp)}`);
  }

  const encrypted = encryptMedia(data, aesKey);
  const cdnUrl = buildCdnUploadUrl(creds.cdnBaseUrl, uploadResp.upload_param, fileKey);
  const response = await fetch(cdnUrl, {
    method: "POST",
    body: new Uint8Array(encrypted),
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });
  if (!response.ok) {
    const errMsg = response.headers.get("x-error-message") ?? `status ${response.status}`;
    throw new Error(`CDN upload failed: ${errMsg}`);
  }

  const downloadParam = response.headers.get("x-encrypted-param") ?? uploadResp.upload_param;

  return {
    encryptQueryParam: downloadParam,
    aesKeyBase64: Buffer.from(aesKey.toString("hex")).toString("base64"),
    cipherSize: encrypted.length,
  };
}

export function inferWeixinUploadMediaType(filePath: string): number {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) {
    return UploadMediaType.IMAGE;
  }
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) {
    return UploadMediaType.VIDEO;
  }
  if (["mp3", "wav", "m4a", "aac", "silk", "ogg"].includes(ext)) {
    return UploadMediaType.VOICE;
  }
  return UploadMediaType.FILE;
}
