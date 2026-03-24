import { app } from "electron";
import { randomUUID } from "crypto";
import { loadUserSettings, type UserSettings } from "./user-settings.js";

export type AnalyticsEnv = "test" | "prod";

export type AnalyticsSourceType =
  | "ui"
  | "bot"
  | "system"
  | "session"
  | "src_api";

export type AnalyticsSourceChannel =
  | "main_window"
  | "quick_window"
  | "dingtalk"
  | "feishu"
  | "telegram"
  | "weixin"
  | "qqbot"
  | "webhook"
  | "embedded_api"
  | "scheduler";

export type AnalyticsRuntimeContext = Record<string, unknown>;
export type AnalyticsParams = Record<string, unknown>;

type AnalyticsCategory = "track" | "logging" | "metrics";
type AnalyticsTrackType = "trigger" | "click" | "show" | "view" | "input" | "scroll";
type AnalyticsLogType = "log" | "warn" | "error" | "perf";
type AnalyticsChannel = { name: "ha" };

type NormalizedLogInput = {
  content?: string;
  target?: string;
  duration?: number;
  errorCode?: string;
  errorMessage?: string;
};

const APP_NAME = "teamclaw";
const HA_REPORT_URL = "https://blazingabc.com/ha/report";
const MSG_VERSION = "1.0.0";
const PROCESS_SESSION_ID = randomUUID();
const channel: AnalyticsChannel = { name: "ha" };

let runtimeContext: AnalyticsRuntimeContext = {};
let userContext: AnalyticsRuntimeContext = {};
let initialized = false;

function resolveEnv(): AnalyticsEnv {
  if (process.env.DINOCLAW_ANALYTICS_ENV === "prod") return "prod";
  if (process.env.DINOCLAW_ANALYTICS_ENV === "test") return "test";
  return app.isPackaged ? "prod" : "test";
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sanitizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeValue(item))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return sanitizeObject({
      err_name: value.name,
      err_message: value.message,
      err_stack: value.stack,
    });
  }
  if (typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>);
  }
  return String(value);
}

function sanitizeObject<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }
  return output as Partial<T>;
}

function getBaseContext(): AnalyticsRuntimeContext {
  const now = new Date();
  return sanitizeObject({
    app_name: APP_NAME,
    app_version: app.getVersion(),
    env: resolveEnv(),
    platform: process.platform,
    process_type: "main",
    msg_version: MSG_VERSION,
    launch_session_id: PROCESS_SESSION_ID,
    client_time: now.getTime(),
    timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezone_offset: now.getTimezoneOffset(),
  });
}

function normalizeLogInput(data: string | NormalizedLogInput): NormalizedLogInput {
  if (typeof data === "string") {
    return { content: data };
  }
  return data ?? {};
}

function normalizeError(exception: unknown): AnalyticsRuntimeContext {
  if (!exception) return {};
  if (exception instanceof Error) {
    return sanitizeObject({
      err_name: exception.name,
      err_message: exception.message,
      err_stack: exception.stack,
    });
  }
  return sanitizeObject({
    err_message: typeof exception === "string" ? exception : JSON.stringify(exception),
  });
}

function beforeSend(
  params: AnalyticsRuntimeContext,
  category: AnalyticsCategory,
  analyticsChannel: AnalyticsChannel,
): AnalyticsRuntimeContext {
  // Main process owns the final payload shape so all entry points
  // share the same common fields and sanitization rules.
  const merged = sanitizeObject({
    ...getBaseContext(),
    ...userContext,
    ...runtimeContext,
    ...params,
    msg_category: category,
  });

  if (analyticsChannel.name === "ha") {
    return merged;
  }

  return merged;
}

async function postToHA(payload: AnalyticsRuntimeContext): Promise<void> {
  const env = payload.env === "prod" ? "prod" : "test";
  const url = `${HA_REPORT_URL}/${env}/`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("[analytics] HA send failed:", error);
  }
}

function send(params: AnalyticsRuntimeContext, category: AnalyticsCategory): void {
  const payload = beforeSend(params, category, channel);
  void postToHA(payload);
}

export function initAnalytics(): void {
  if (initialized) return;
  syncAnalyticsUserContext(loadUserSettings());
  initialized = true;
}

export function getAnalyticsEnv(): AnalyticsEnv {
  return resolveEnv();
}

export function setRuntimeContext(partial: AnalyticsRuntimeContext): void {
  // Renderer sends a full snapshot of its current context, so replace instead of merge
  // to avoid stale fields from a previous window/session leaking into new events.
  runtimeContext = sanitizeObject(partial ?? {});
}

export function clearRuntimeContext(keys?: string[]): void {
  if (!keys?.length) {
    runtimeContext = {};
    return;
  }
  const next = { ...runtimeContext };
  for (const key of keys) {
    delete next[key];
  }
  runtimeContext = next;
}

export function getRuntimeContext(): AnalyticsRuntimeContext {
  return { ...runtimeContext };
}

export function syncAnalyticsUserContext(settings: UserSettings): void {
  // Keep Google identity in a dedicated user context so login/logout
  // immediately affects all subsequent events without touching call sites.
  const googleUser = (
    settings as UserSettings & {
      googleUser?: { email?: string; name?: string };
    }
  ).googleUser;
  userContext = sanitizeObject({
    google_email: googleUser?.email,
    google_name: googleUser?.name,
  });
}

export function trigger(
  eventId: string,
  params: AnalyticsParams = {},
  type: AnalyticsTrackType = "trigger",
): void {
  send(
    {
      event_id: eventId,
      event_type: type,
      custom: sanitizeObject(params),
    },
    "track",
  );
}

export function track(eventId: string, params: AnalyticsParams = {}): void {
  trigger(eventId, params, "trigger");
}

export function click(eventId: string, params: AnalyticsParams = {}): void {
  trigger(eventId, params, "click");
}

export function show(eventId: string, params: AnalyticsParams = {}): void {
  trigger(eventId, params, "show");
}

export function view(eventId: string, params: AnalyticsParams = {}): void {
  trigger(eventId, params, "view");
}

export function input(eventId: string, params: AnalyticsParams = {}): void {
  trigger(eventId, params, "input");
}

export function scroll(eventId: string, params: AnalyticsParams = {}): void {
  trigger(eventId, params, "scroll");
}

function writeLog(
  type: AnalyticsLogType,
  data: string | NormalizedLogInput,
  params: AnalyticsParams = {},
  exception?: unknown,
): void {
  const normalized = normalizeLogInput(data);
  const duration = toNumber(normalized.duration);
  send(
    {
      log_type: type,
      content: normalized.content,
      target: normalized.target,
      duration,
      err_code: normalized.errorCode,
      err_message: normalized.errorMessage,
      ...normalizeError(exception),
      custom: sanitizeObject(params),
    },
    "logging",
  );
}

export function log(data: string | NormalizedLogInput, params: AnalyticsParams = {}): void {
  writeLog("log", data, params);
}

export function warn(data: string | NormalizedLogInput, params: AnalyticsParams = {}, exception?: unknown): void {
  writeLog("warn", data, params, exception);
}

export function error(data: string | NormalizedLogInput, params: AnalyticsParams = {}, exception?: unknown): void {
  writeLog("error", data, params, exception);
}

export function perf(
  data: string | NormalizedLogInput,
  params: AnalyticsParams = {},
  exception?: unknown,
): void {
  writeLog("perf", data, params, exception);
}

export function trackAnalytics(eventId: string, params: AnalyticsParams = {}): void {
  track(eventId, params);
}

export function clickAnalytics(eventId: string, params: AnalyticsParams = {}): void {
  click(eventId, params);
}

export function viewAnalytics(eventId: string, params: AnalyticsParams = {}): void {
  view(eventId, params);
}

export function errorAnalytics(eventId: string, params: AnalyticsParams = {}, exception?: unknown): void {
  error({ content: eventId }, params, exception);
}

export function perfAnalytics(eventId: string, duration: number, params: AnalyticsParams = {}): void {
  perf({ content: eventId, duration }, params);
}
