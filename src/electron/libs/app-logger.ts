/**
 * App-level logging and error alerting.
 *
 * - Configures electron-log to write to platform log files (10 MB, 5 rotations)
 * - Replaces console.log/warn/error globally so all existing log calls are persisted
 * - Registers process uncaughtException + unhandledRejection handlers that:
 *   1. Write to the log file (synchronous, always succeeds)
 *   2. Fire-and-forget POST to the configured DingTalk group webhook (non-blocking)
 */

import log from "electron-log/main.js";
import { createHmac } from "crypto";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

// ─── electron-log configuration ───────────────────────────────────────────────

const LOG_DIR = join(homedir(), ".vk-cowork", "logs");
mkdirSync(LOG_DIR, { recursive: true });

log.transports.file.resolvePathFn = () => join(LOG_DIR, "main.log");
log.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB per file
log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";

// Override console.* so all existing log calls go to the log file too
Object.assign(console, log.functions);

// ─── DingTalk webhook alert ────────────────────────────────────────────────────

function buildWebhookUrl(webhookUrl: string, secret: string): string {
  const timestamp = Date.now().toString();
  const sign = createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  const sep = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

type UserInfo = { userName?: string; workDescription?: string; email?: string };

function buildAlertMarkdown(kind: string, err: unknown, settings?: UserInfo): string {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack
    ? err.stack.split("\n").slice(0, 10).join("\n")
    : "";

  const lines: string[] = [
    `### AI Team 崩溃告警`,
    ``,
    `**类型**: ${kind}`,
    ``,
    `**时间**: ${now}`,
  ];
  if (settings?.userName) lines.push(``, `**用户**: ${settings.userName}`);
  if (settings?.email) lines.push(``, `**邮箱**: ${settings.email}`);
  if (settings?.workDescription) lines.push(``, `**告警描述**: ${settings.workDescription}`);
  lines.push(``, `**错误**: ${message.slice(0, 300)}`);
  if (stack) lines.push(``, `\`\`\`\n${stack}\n\`\`\``);

  return lines.join("\n");
}

export async function sendDingtalkAlert(text: string): Promise<void> {
  // Lazy-load user settings to avoid circular deps at module init time
  const { loadUserSettings } = await import("./user-settings.js");
  const settings = loadUserSettings();

  const webhookBase = settings.alertDingtalkWebhook?.trim();
  if (!webhookBase) return;

  const secret = settings.alertDingtalkSecret?.trim();
  const url = secret ? buildWebhookUrl(webhookBase, secret) : webhookBase;

  const body = JSON.stringify({
    msgtype: "markdown",
    markdown: { title: "AI Team 崩溃告警", text },
  });

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a test alert to the configured DingTalk webhook.
 * Called from the settings UI after the user saves alert config.
 * Returns an error message string on failure, or null on success.
 */
export async function sendTestDingtalkAlert(
  webhookUrl: string,
  secret: string | undefined,
  userInfo: UserInfo,
): Promise<{ ok: boolean; error?: string }> {
  const webhookBase = webhookUrl.trim();
  if (!webhookBase) return { ok: false, error: "Webhook 地址为空" };

  const url = secret?.trim() ? buildWebhookUrl(webhookBase, secret.trim()) : webhookBase;
  const now = new Date().toLocaleString("zh-CN", { hour12: false });

  const lines: string[] = [
    `### AI Team 测试告警`,
    ``,
    `**状态**: 告警配置验证成功`,
    ``,
    `**时间**: ${now}`,
  ];
  if (userInfo.userName) lines.push(``, `**用户**: ${userInfo.userName}`);
  if (userInfo.email) lines.push(``, `**邮箱**: ${userInfo.email}`);
  if (userInfo.workDescription) lines.push(``, `**告警描述**: ${userInfo.workDescription}`);
  lines.push(``, `此消息由「设置 → 告警」保存触发，用于确认 Webhook 可正常接收消息。`);

  const text = lines.join("\n");

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title: "AI Team 测试告警", text },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const error = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
      log.error("[alert-test] webhook failed:", error);
      return { ok: false, error };
    }
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    if (data.errcode && data.errcode !== 0) {
      const error = `钉钉错误 ${data.errcode}: ${data.errmsg ?? ""}`;
      log.error("[alert-test] dingtalk error:", error);
      return { ok: false, error };
    }
    log.info("[alert-test] test alert sent OK");
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("[alert-test] fetch exception:", error);
    return { ok: false, error };
  }
}

// ─── Global error handlers ─────────────────────────────────────────────────────

process.on("uncaughtException", (err: Error) => {
  log.error("[uncaughtException]", err);
  void (async () => {
    const { loadUserSettings } = await import("./user-settings.js");
    const s = loadUserSettings();
    const text = buildAlertMarkdown("uncaughtException", err, {
      userName: s.userName,
      workDescription: s.workDescription,
      email: s.googleUser?.email,
    });
    await sendDingtalkAlert(text);
  })().catch(() => {});
});

process.on("unhandledRejection", (reason: unknown) => {
  log.error("[unhandledRejection]", reason);
  void (async () => {
    const { loadUserSettings } = await import("./user-settings.js");
    const s = loadUserSettings();
    const text = buildAlertMarkdown("unhandledRejection", reason, {
      userName: s.userName,
      workDescription: s.workDescription,
      email: s.googleUser?.email,
    });
    await sendDingtalkAlert(text);
  })().catch(() => {});
});

log.info("[app-logger] Initialized — log file:", log.transports.file.getFile().path);
