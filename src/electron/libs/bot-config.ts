import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type BotPlatformType = "telegram" | "feishu" | "wecom" | "discord" | "dingtalk" | "qqbot";

export type TelegramBotConfig = {
  platform: "telegram";
  token: string;
  proxy?: string;
  /** Private chat policy */
  dmPolicy?: "open" | "allowlist";
  /** Group chat policy */
  groupPolicy?: "open" | "allowlist";
  /** Allowlisted Telegram user IDs or group chat IDs */
  allowFrom?: string[];
  /** Require @mention in groups before responding (default: true) */
  requireMention?: boolean;
  /** Owner Telegram user IDs for proactive messaging */
  ownerUserIds?: string[];
  connected: boolean;
};

export type FeishuBotConfig = {
  platform: "feishu";
  appId: string;
  appSecret: string;
  /** "feishu" | "lark" | custom URL for private deployment */
  domain: "feishu" | "lark" | string;
  connectionMode?: "websocket" | "webhook";
  webhookPort?: number;
  dmPolicy?: "open" | "allowlist" | "pairing";
  groupPolicy?: "open" | "allowlist" | "disabled";
  allowFrom?: string[];
  requireMention?: boolean;
  renderMode?: "auto" | "raw" | "card";
  ownerOpenIds?: string[];
  connected: boolean;
};

export type WecomBotConfig = {
  platform: "wecom";
  corpId: string;
  agentId: string;
  secret: string;
  connected: boolean;
};

export type DiscordBotConfig = {
  platform: "discord";
  token: string;
  connected: boolean;
};

export type DingtalkBotConfig = {
  platform: "dingtalk";
  appKey: string;
  appSecret: string;
  /** For Card API and media download — defaults to appKey */
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  /** Reply mode: "markdown" (default) or "card" (AI streaming card) */
  messageType?: "markdown" | "card";
  /** Required when messageType="card" */
  cardTemplateId?: string;
  /** Card template content field key — defaults to "content" */
  cardTemplateKey?: string;
  /** Private chat policy */
  dmPolicy?: "open" | "allowlist";
  /** Group chat policy */
  groupPolicy?: "open" | "allowlist";
  /** Allowlisted staff IDs or conversation IDs */
  allowFrom?: string[];
  /** Max reconnect attempts (default: 10) */
  maxConnectionAttempts?: number;
  /** Initial reconnect delay ms (default: 1000) */
  initialReconnectDelay?: number;
  /** Max reconnect delay ms (default: 60000) */
  maxReconnectDelay?: number;
  /** Jitter factor 0–1 (default: 0.3) */
  reconnectJitter?: number;
  /**
   * Owner staff ID(s) for proactive push messages.
   * Fill in your own staffId so the bot can notify you proactively.
   */
  ownerStaffIds?: string[];
  connected: boolean;
};

export type QQBotConfig = {
  platform: "qqbot";
  appId: string;
  clientSecret: string;
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  ownerOpenIds?: string[];
  connected: boolean;
};

export type BotPlatformConfig =
  | TelegramBotConfig
  | FeishuBotConfig
  | WecomBotConfig
  | DiscordBotConfig
  | DingtalkBotConfig
  | QQBotConfig;

export type BotConfig = {
  platforms: Partial<Record<BotPlatformType, BotPlatformConfig>>;
};

const VK_COWORK_DIR = join(homedir(), ".vk-cowork");
const BOT_CONFIG_FILE = join(VK_COWORK_DIR, "bot-config.json");

function ensureDirectory() {
  if (!existsSync(VK_COWORK_DIR)) {
    mkdirSync(VK_COWORK_DIR, { recursive: true });
  }
}

function buildDefaultConfig(): BotConfig {
  return { platforms: {} };
}

export function loadBotConfig(): BotConfig {
  try {
    if (!existsSync(BOT_CONFIG_FILE)) {
      return buildDefaultConfig();
    }
    const raw = readFileSync(BOT_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as BotConfig;
    return parsed ?? buildDefaultConfig();
  } catch {
    return buildDefaultConfig();
  }
}

export function saveBotConfig(config: BotConfig): BotConfig {
  ensureDirectory();
  writeFileSync(BOT_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  return config;
}

export async function testBotConnection(
  platformConfig: BotPlatformConfig
): Promise<{ success: boolean; message: string }> {
  try {
    if (platformConfig.platform === "telegram") {
      const { token, proxy } = platformConfig;
      if (!token) return { success: false, message: "Bot Token 不能为空" };

      const url = `https://api.telegram.org/bot${token}/getMe`;

      const proxyUrl = proxy
        || process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY
        || process.env.all_proxy || process.env.ALL_PROXY
        || undefined;

      let resp: Response;
      if (proxyUrl) {
        const undici = await import("undici");
        const dispatcher = new undici.ProxyAgent(proxyUrl);
        resp = await undici.fetch(url, { dispatcher }) as unknown as Response;
      } else {
        resp = await fetch(url);
      }
      const data = (await resp.json()) as { ok: boolean; result?: { username: string } };
      if (data.ok) {
        return { success: true, message: `连接成功：@${data.result?.username}` };
      }
      return { success: false, message: "Token 无效或网络不通" };
    }

    if (platformConfig.platform === "feishu") {
      const { appId, appSecret, domain } = platformConfig;
      if (!appId || !appSecret) return { success: false, message: "App ID 和 App Secret 不能为空" };

      const baseUrl =
        domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      const resp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const data = (await resp.json()) as { code: number; msg: string };
      if (data.code === 0) {
        return { success: true, message: "凭证验证成功" };
      }
      return { success: false, message: `验证失败：${data.msg}` };
    }

    if (platformConfig.platform === "dingtalk") {
      const { appKey, appSecret } = platformConfig;
      if (!appKey || !appSecret) return { success: false, message: "AppKey 和 AppSecret 不能为空" };

      const resp = await fetch(
        `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`
      );
      if (!resp.ok) {
        return { success: false, message: `请求失败：HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { errcode: number; errmsg: string; access_token?: string };
      if (data.errcode === 0 && data.access_token) {
        return { success: true, message: "凭证验证成功" };
      }
      return { success: false, message: `验证失败（${data.errcode}）：${data.errmsg}` };
    }

    if (platformConfig.platform === "wecom") {
      const { corpId, secret } = platformConfig;
      if (!corpId || !secret) return { success: false, message: "Corp ID 和 Secret 不能为空" };

      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`
      );
      const data = (await resp.json()) as { errcode: number; errmsg: string };
      if (data.errcode === 0) {
        return { success: true, message: "凭证验证成功" };
      }
      return { success: false, message: `验证失败：${data.errmsg}` };
    }

    if (platformConfig.platform === "qqbot") {
      const { appId, clientSecret } = platformConfig;
      if (!appId || !clientSecret) return { success: false, message: "App ID 和 App Secret 不能为空" };

      const resp = await fetch("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, clientSecret }),
      });
      if (!resp.ok) {
        return { success: false, message: `请求失败：HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (data.access_token) {
        return { success: true, message: "凭证验证成功" };
      }
      return { success: false, message: `验证失败：${JSON.stringify(data)}` };
    }

    if (platformConfig.platform === "discord") {
      const { token } = platformConfig;
      if (!token) return { success: false, message: "Bot Token 不能为空" };

      const resp = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      const data = (await resp.json()) as { username?: string; message?: string };
      if (resp.ok && data.username) {
        return { success: true, message: `连接成功：${data.username}` };
      }
      return { success: false, message: `验证失败：${data.message ?? "Token 无效"}` };
    }

    return { success: false, message: "不支持的平台" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `连接失败：${msg}` };
  }
}
