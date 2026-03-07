import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { readFile as readFileAsync } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { app } from "electron";

export interface OpenAITokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;  // raw JWT from OpenID Connect
  expiresAt: number; // timestamp in ms
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
}

export interface GoogleUser {
  email: string;
  name?: string;
  picture?: string;
}

export interface UserSettings {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicModel?: string;
  // Proxy settings
  proxyEnabled?: boolean;
  proxyUrl?: string;  // e.g., http://127.0.0.1:7890 or socks5://127.0.0.1:1080
  // OpenAI Codex OAuth tokens
  openaiTokens?: OpenAITokens;
  // Webhook auth token — set to require Authorization: Bearer <token> on /webhook routes
  webhookToken?: string;
  // Personalization
  userName?: string;
  workDescription?: string;
  globalPrompt?: string;
  // Quick window global shortcut (Electron accelerator format, e.g. "Alt+Space")
  quickWindowShortcut?: string;
  // Google OAuth
  googleTokens?: GoogleTokens;
  googleUser?: GoogleUser;
  // Whether the splash screen has been seen (set true after first launch)
  splashSeen?: boolean;
  // DingTalk group alert webhook (custom robot)
  alertDingtalkWebhook?: string;
  // Optional signing secret for the DingTalk custom robot
  alertDingtalkSecret?: string;
  // Memory isolation V3: per-assistant private MEMORY.md (default: true)
  memoryIsolationV3?: boolean;
  // UI dark mode
  darkMode?: boolean;
}

// Custom error class for validation errors
export class UserSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserSettingsValidationError';
  }
}

// Validation functions
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Support http, https, socks5 proxy protocols
    return ['http:', 'https:', 'socks5:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function validateOpenAITokens(tokens: unknown): void {
  if (!tokens || typeof tokens !== 'object') {
    throw new UserSettingsValidationError('openaiTokens must be an object');
  }
  const t = tokens as Record<string, unknown>;
  if (typeof t.accessToken !== 'string' || !t.accessToken) {
    throw new UserSettingsValidationError('openaiTokens.accessToken must be a non-empty string');
  }
  if (typeof t.refreshToken !== 'string' || !t.refreshToken) {
    throw new UserSettingsValidationError('openaiTokens.refreshToken must be a non-empty string');
  }
  if (typeof t.expiresAt !== 'number' || t.expiresAt <= 0) {
    throw new UserSettingsValidationError('openaiTokens.expiresAt must be a positive number');
  }
}

function validateGoogleTokens(tokens: unknown): void {
  if (!tokens || typeof tokens !== 'object') {
    throw new UserSettingsValidationError('googleTokens must be an object');
  }
  const t = tokens as Record<string, unknown>;
  if (typeof t.accessToken !== 'string' || !t.accessToken) {
    throw new UserSettingsValidationError('googleTokens.accessToken must be a non-empty string');
  }
  if (typeof t.refreshToken !== 'string' || !t.refreshToken) {
    throw new UserSettingsValidationError('googleTokens.refreshToken must be a non-empty string');
  }
  if (typeof t.expiresAt !== 'number' || t.expiresAt <= 0) {
    throw new UserSettingsValidationError('googleTokens.expiresAt must be a positive number');
  }
}

function validateGoogleUser(user: unknown): void {
  if (!user || typeof user !== 'object') {
    throw new UserSettingsValidationError('googleUser must be an object');
  }
  const u = user as Record<string, unknown>;
  if (typeof u.email !== 'string' || !u.email) {
    throw new UserSettingsValidationError('googleUser.email must be a non-empty string');
  }
  // Email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(u.email)) {
    throw new UserSettingsValidationError('googleUser.email must be a valid email address');
  }
}

// Comprehensive validation function - throws on invalid settings
function validateUserSettings(settings: unknown): asserts settings is UserSettings {
  if (!settings || typeof settings !== 'object') {
    throw new UserSettingsValidationError('Settings must be an object');
  }

  const s = settings as Record<string, unknown>;

  // Validate anthropicBaseUrl if provided
  if (s.anthropicBaseUrl !== undefined) {
    if (typeof s.anthropicBaseUrl !== 'string') {
      throw new UserSettingsValidationError('anthropicBaseUrl must be a string');
    }
    if (s.anthropicBaseUrl && !isValidUrl(s.anthropicBaseUrl)) {
      throw new UserSettingsValidationError('anthropicBaseUrl must be a valid URL');
    }
  }

  // Validate anthropicAuthToken if provided
  if (s.anthropicAuthToken !== undefined && typeof s.anthropicAuthToken !== 'string') {
    throw new UserSettingsValidationError('anthropicAuthToken must be a string');
  }

  // Validate anthropicModel if provided
  if (s.anthropicModel !== undefined && typeof s.anthropicModel !== 'string') {
    throw new UserSettingsValidationError('anthropicModel must be a string');
  }

  // Validate proxy settings
  if (s.proxyEnabled !== undefined && typeof s.proxyEnabled !== 'boolean') {
    throw new UserSettingsValidationError('proxyEnabled must be a boolean');
  }

  if (s.proxyUrl !== undefined) {
    if (typeof s.proxyUrl !== 'string') {
      throw new UserSettingsValidationError('proxyUrl must be a string');
    }
    if (s.proxyUrl && !isValidProxyUrl(s.proxyUrl)) {
      throw new UserSettingsValidationError('proxyUrl must be a valid proxy URL (http, https, or socks5)');
    }
  }

  // Validate openaiTokens
  if (s.openaiTokens !== undefined) {
    validateOpenAITokens(s.openaiTokens);
  }

  // Validate webhookToken if provided
  if (s.webhookToken !== undefined && typeof s.webhookToken !== 'string') {
    throw new UserSettingsValidationError('webhookToken must be a string');
  }

  // Validate personalization fields
  if (s.userName !== undefined && typeof s.userName !== 'string') {
    throw new UserSettingsValidationError('userName must be a string');
  }

  if (s.workDescription !== undefined && typeof s.workDescription !== 'string') {
    throw new UserSettingsValidationError('workDescription must be a string');
  }

  if (s.globalPrompt !== undefined && typeof s.globalPrompt !== 'string') {
    throw new UserSettingsValidationError('globalPrompt must be a string');
  }

  // Validate quickWindowShortcut if provided
  if (s.quickWindowShortcut !== undefined && typeof s.quickWindowShortcut !== 'string') {
    throw new UserSettingsValidationError('quickWindowShortcut must be a string');
  }

  // Validate googleTokens
  if (s.googleTokens !== undefined) {
    validateGoogleTokens(s.googleTokens);
  }

  // Validate googleUser
  if (s.googleUser !== undefined) {
    validateGoogleUser(s.googleUser);
  }

  // Validate splashSeen if provided
  if (s.splashSeen !== undefined && typeof s.splashSeen !== 'boolean') {
    throw new UserSettingsValidationError('splashSeen must be a boolean');
  }

  // Validate DingTalk webhook if provided
  if (s.alertDingtalkWebhook !== undefined) {
    if (typeof s.alertDingtalkWebhook !== 'string') {
      throw new UserSettingsValidationError('alertDingtalkWebhook must be a string');
    }
    if (s.alertDingtalkWebhook && !isValidUrl(s.alertDingtalkWebhook)) {
      throw new UserSettingsValidationError('alertDingtalkWebhook must be a valid URL');
    }
  }

  // Validate alertDingtalkSecret if provided
  if (s.alertDingtalkSecret !== undefined && typeof s.alertDingtalkSecret !== 'string') {
    throw new UserSettingsValidationError('alertDingtalkSecret must be a string');
  }

  // Validate darkMode if provided
  if (s.darkMode !== undefined && typeof s.darkMode !== 'boolean') {
    throw new UserSettingsValidationError('darkMode must be a boolean');
  }

}

const VK_COWORK_DIR = join(homedir(), ".vk-cowork");
const SETTINGS_FILE = join(VK_COWORK_DIR, "user-settings.json");
const LEGACY_SETTINGS_FILE = join(app.getPath("userData"), "user-settings.json");

let migrated = false;

function ensureDirectory() {
  if (!existsSync(VK_COWORK_DIR)) {
    mkdirSync(VK_COWORK_DIR, { recursive: true });
  }
}

function migrateFromLegacy(): void {
  if (migrated) return;
  migrated = true;
  if (existsSync(SETTINGS_FILE) || !existsSync(LEGACY_SETTINGS_FILE)) return;
  try {
    ensureDirectory();
    const raw = readFileSync(LEGACY_SETTINGS_FILE, "utf8");
    JSON.parse(raw); // validate JSON before writing
    writeFileSync(SETTINGS_FILE, raw, "utf8");
    unlinkSync(LEGACY_SETTINGS_FILE);
  } catch {
    // migration best-effort; keep both files on failure
  }
}

export function loadUserSettings(): UserSettings {
  migrateFromLegacy();
  try {
    if (!existsSync(SETTINGS_FILE)) {
      return {};
    }
    const raw = readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw) as UserSettings;
  } catch {
    return {};
  }
}

export async function loadUserSettingsAsync(): Promise<UserSettings> {
  migrateFromLegacy();
  try {
    const raw = await readFileAsync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw) as UserSettings;
  } catch {
    return {};
  }
}

export function saveUserSettings(settings: UserSettings): void {
  // Run comprehensive validation - throws on invalid settings
  validateUserSettings(settings);

  ensureDirectory();
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");

  // Sync API key/url into ~/.claude/settings.json so claude CLI reads the latest config,
  // preventing stale values in that file from overriding user settings.
  syncToClaudeSettings(settings);
}

function syncToClaudeSettings(settings: UserSettings): void {
  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
  try {
    let parsed: { env?: Record<string, string>; [key: string]: unknown } = {};
    if (existsSync(claudeSettingsPath)) {
      parsed = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
    }
    const env: Record<string, string> = { ...(parsed.env ?? {}) };

    if (settings.anthropicAuthToken) {
      env.ANTHROPIC_API_KEY = settings.anthropicAuthToken;
      env.ANTHROPIC_AUTH_TOKEN = settings.anthropicAuthToken;
    } else {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    if (settings.anthropicBaseUrl) {
      env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
    } else {
      delete env.ANTHROPIC_BASE_URL;
    }

    parsed.env = env;
    writeFileSync(claudeSettingsPath, JSON.stringify(parsed, null, 2), "utf8");
  } catch {
    // best-effort, don't block saving user settings
  }
}

export function getUserSetting<K extends keyof UserSettings>(key: K): UserSettings[K] {
  const settings = loadUserSettings();
  return settings[key];
}

export function setUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
  const settings = loadUserSettings();
  settings[key] = value;
  saveUserSettings(settings);
}
