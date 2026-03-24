type AnalyticsContext = Record<string, unknown>;
type AnalyticsParams = Record<string, unknown>;

const APP_NAME = "teamclaw";

let pageContext: AnalyticsContext = {};
let userContext: AnalyticsContext = {};

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
  if (typeof value === "object") return sanitizeObject(value as Record<string, unknown>);
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

function getEnv(): "test" | "prod" {
  return import.meta.env.PROD ? "prod" : "test";
}

async function syncUserContextFromSettings(): Promise<void> {
  try {
    const settings = await window.electron.getUserSettings();
    setAnalyticsUserContext({
      google_email: settings.googleUser?.email,
      google_name: settings.googleUser?.name,
    });
  } catch {
    // Ignore startup hydration failures; call sites can still override later.
  }
}

function getBaseParams(extra: AnalyticsParams = {}): AnalyticsParams {
  // Window-local context stays in the renderer so multiple windows
  // do not overwrite each other's attribution in the main process.
  return sanitizeObject({
    app_name: APP_NAME,
    env: getEnv(),
    process_type: "renderer",
    ...userContext,
    ...pageContext,
    ...extra,
  });
}

export function initAnalytics(): boolean {
  void syncUserContextFromSettings();
  return true;
}

export function setAnalyticsUserContext(context: AnalyticsContext): void {
  userContext = sanitizeObject(context);
  // Sync only user identity to main process. Window/page context is sent
  // per event and should not become global shared state across windows.
  void window.electron.analyticsSetContext(userContext);
}

export function setAnalyticsContext(context: AnalyticsContext): void {
  pageContext = sanitizeObject(context);
}

export function track(eventId: string, params: AnalyticsParams = {}): void {
  const merged = getBaseParams(params);
  void window.electron.analyticsTrack(eventId, merged);
}

export function clickTrack(eventId: string, params: AnalyticsParams = {}): void {
  const merged = getBaseParams(params);
  void window.electron.analyticsClick(eventId, merged);
}

export function viewTrack(eventId: string, params: AnalyticsParams = {}): void {
  const merged = getBaseParams(params);
  void window.electron.analyticsView(eventId, merged);
}

export function logTrack(data: string | AnalyticsParams, params: AnalyticsParams = {}): void {
  void window.electron.analyticsLog(data, getBaseParams(params));
}

export function errorTrack(data: string | AnalyticsParams, params: AnalyticsParams = {}): void {
  void window.electron.analyticsError(data, getBaseParams(params));
}

export function perfTrack(data: string | AnalyticsParams, params: AnalyticsParams = {}): void {
  void window.electron.analyticsPerf(data, getBaseParams(params));
}
