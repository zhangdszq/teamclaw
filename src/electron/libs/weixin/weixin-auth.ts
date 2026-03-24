/**
 * WeChat QR login flow for Electron.
 */

import QRCode from "qrcode";
import { startLoginQr, pollLoginQrStatus } from "./weixin-api.js";
import { upsertWeixinAccount } from "../weixin-db.js";
import type { QrCodeStatusResponse } from "./weixin-types.js";
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from "./weixin-types.js";

export interface QrLoginSession {
  qrcode: string;
  qrImage: string;
  startedAt: number;
  refreshCount: number;
  status: "waiting" | "scanned" | "confirmed" | "expired" | "failed";
  accountId?: string;
  error?: string;
}

const MAX_REFRESHES = 3;
const QR_TTL_MS = 5 * 60_000;
const GLOBAL_KEY = "__dinoclaw_weixin_login_sessions__";

function getLoginSessions(): Map<string, QrLoginSession> {
  const container = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: Map<string, QrLoginSession>;
  };
  if (!container[GLOBAL_KEY]) {
    container[GLOBAL_KEY] = new Map<string, QrLoginSession>();
  }
  return container[GLOBAL_KEY];
}

export async function startQrLoginSession(): Promise<{ sessionId: string; qrImage: string }> {
  const response = await startLoginQr();
  if (!response.qrcode || !response.qrcode_img_content) {
    throw new Error("Failed to obtain WeChat QR code");
  }

  const qrImage = await QRCode.toDataURL(response.qrcode_img_content, {
    width: 256,
    margin: 2,
  });

  const sessionId = `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session: QrLoginSession = {
    qrcode: response.qrcode,
    qrImage,
    startedAt: Date.now(),
    refreshCount: 0,
    status: "waiting",
  };

  getLoginSessions().set(sessionId, session);
  setTimeout(() => {
    getLoginSessions().delete(sessionId);
  }, 10 * 60_000);

  return { sessionId, qrImage };
}

export async function pollQrLoginStatus(sessionId: string): Promise<QrLoginSession> {
  const sessions = getLoginSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      qrcode: "",
      qrImage: "",
      startedAt: 0,
      refreshCount: 0,
      status: "failed",
      error: "Session not found",
    };
  }

  if (session.status === "confirmed" || session.status === "failed") {
    return session;
  }

  if (Date.now() - session.startedAt > QR_TTL_MS) {
    if (session.refreshCount >= MAX_REFRESHES) {
      session.status = "failed";
      session.error = "QR code expired after maximum refreshes";
      return session;
    }

    try {
      const refreshResponse = await startLoginQr();
      if (refreshResponse.qrcode && refreshResponse.qrcode_img_content) {
        session.qrcode = refreshResponse.qrcode;
        session.qrImage = await QRCode.toDataURL(refreshResponse.qrcode_img_content, {
          width: 256,
          margin: 2,
        });
        session.startedAt = Date.now();
        session.refreshCount += 1;
        session.status = "waiting";
      }
    } catch (error) {
      session.status = "failed";
      session.error = `QR refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    return session;
  }

  try {
    const response: QrCodeStatusResponse = await pollLoginQrStatus(session.qrcode);

    switch (response.status) {
      case "wait":
        session.status = "waiting";
        break;
      case "scaned":
        session.status = "scanned";
        break;
      case "confirmed": {
        session.status = "confirmed";
        if (response.bot_token && response.ilink_bot_id) {
          const accountId = String(response.ilink_bot_id).replace(/[@.]/g, "-");
          session.accountId = accountId;
          upsertWeixinAccount({
            accountId,
            userId: response.ilink_user_id || "",
            baseUrl: response.baseurl || DEFAULT_BASE_URL,
            cdnBaseUrl: DEFAULT_CDN_BASE_URL,
            token: response.bot_token,
            name: accountId,
            enabled: true,
          });
          console.log(`[weixin-auth] QR login succeeded for account=${accountId}`);
        }
        break;
      }
      case "expired":
        session.status = "expired";
        session.startedAt = 0;
        break;
      default:
        break;
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) {
      console.warn("[weixin-auth] poll error:", error);
    }
  }

  return session;
}

export function cancelQrLoginSession(sessionId: string): void {
  getLoginSessions().delete(sessionId);
}
