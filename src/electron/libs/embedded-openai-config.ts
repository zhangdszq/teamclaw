import type { UserSettings } from "./user-settings.js";

const EMBEDDED_OPENAI_API_KEY = "sk-c7f5b4a32f0acdf739d779371be63ea5db79081da0a8eecce9913cf323fd0bb6";
const EMBEDDED_OPENAI_BASE_URL = "https://gmncode.cn";
const EMBEDDED_OPENAI_MODEL = "";

function shouldUseEmbeddedOpenAIConfig(): boolean {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

export function getEmbeddedOpenAIConfig(): {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} {
  if (!shouldUseEmbeddedOpenAIConfig()) {
    return {};
  }
  return {
    apiKey: EMBEDDED_OPENAI_API_KEY || undefined,
    baseUrl: EMBEDDED_OPENAI_BASE_URL || undefined,
    model: EMBEDDED_OPENAI_MODEL || undefined,
  };
}

export function resolveOpenAIApiKey(
  settings: Pick<UserSettings, "openaiApiKey">,
): string | undefined {
  return settings.openaiApiKey?.trim() || getEmbeddedOpenAIConfig().apiKey;
}

export function resolveOpenAIBaseUrl(
  settings: Pick<UserSettings, "openaiBaseUrl">,
): string | undefined {
  return settings.openaiBaseUrl?.trim() || getEmbeddedOpenAIConfig().baseUrl;
}

export function resolveOpenAIModel(
  settings: Pick<UserSettings, "openaiModel">,
): string | undefined {
  return settings.openaiModel?.trim() || getEmbeddedOpenAIConfig().model;
}

export function hasAvailableOpenAIAuth(
  settings: Pick<UserSettings, "openaiTokens" | "openaiApiKey">,
): boolean {
  return !!settings.openaiTokens?.accessToken || !!resolveOpenAIApiKey(settings);
}
