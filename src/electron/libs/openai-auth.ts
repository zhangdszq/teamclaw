/**
 * OpenAI Codex OAuth Authentication
 * 
 * Implements the same OAuth flow used by OpenAI Codex CLI:
 * - PKCE (S256) authorization code flow
 * - System browser for login UI
 * - Temporary local HTTP server to receive OAuth callback
 * - Token exchange and refresh
 * - Credential storage in user settings
 */
import { createServer, type Server } from "http";
import { net, shell } from "electron";
import { randomBytes, createHash } from "crypto";
import { loadUserSettings, saveUserSettings } from "./user-settings.js";

// OAuth constants (same as openai/codex)
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const REQUIRED_OPENAI_API_SCOPES = [
  "api.connectors.read",
  "api.connectors.invoke",
] as const;

export const OPENAI_OAUTH_SCOPE = [
  "openid",
  "profile",
  "email",
  "offline_access",
  ...REQUIRED_OPENAI_API_SCOPES,
].join(" ");

export interface OpenAIAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;  // raw JWT from OpenID Connect
  expiresAt: number; // timestamp in ms
}

export interface OpenAIAuthStatus {
  loggedIn: boolean;
  email?: string;
  expiresAt?: number;
  needsReauth?: boolean;
  missingScopes?: string[];
  error?: string;
}

// ─── PKCE Helpers ────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ─── JWT Decode ──────────────────────────────────────────────

interface JWTPayload {
  email?: string;
  name?: string;
  sub?: string;
  exp?: number;
  scp?: string[] | string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
  [key: string]: unknown;
}

function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded) as JWTPayload;
  } catch {
    return null;
  }
}

function normalizeScopes(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function getMissingOpenAIScopes(accessToken?: string | null): string[] {
  if (!accessToken) return [...REQUIRED_OPENAI_API_SCOPES];
  const granted = new Set(normalizeScopes(decodeJWT(accessToken)?.scp));
  return REQUIRED_OPENAI_API_SCOPES.filter((scope) => !granted.has(scope));
}

function buildMissingScopesMessage(missingScopes: string[]): string {
  return `OpenAI OAuth 授权缺少必要权限（${missingScopes.join(", ")}），请重新登录 ChatGPT。`;
}

// ─── Auth Status ─────────────────────────────────────────────

export function getOpenAIAuthStatus(): OpenAIAuthStatus {
  const settings = loadUserSettings();
  const tokens = settings.openaiTokens;

  if (!tokens?.accessToken || !tokens?.refreshToken) {
    return { loggedIn: false };
  }

  const decoded = decodeJWT(tokens.accessToken);
  const missingScopes = getMissingOpenAIScopes(tokens.accessToken);
  if (missingScopes.length > 0) {
    return {
      loggedIn: false,
      email: decoded?.email ?? undefined,
      expiresAt: tokens.expiresAt,
      needsReauth: true,
      missingScopes,
      error: buildMissingScopesMessage(missingScopes),
    };
  }
  return {
    loggedIn: true,
    email: decoded?.email ?? undefined,
    expiresAt: tokens.expiresAt,
  };
}

/**
 * Verify stored tokens are still present and valid on startup.
 */
export function ensureOpenAIAuthSync(): void {
  const settings = loadUserSettings();
  const tokens = settings.openaiTokens;
  if (tokens?.accessToken && tokens?.refreshToken) {
    console.log("[openai-auth] Stored OpenAI tokens found");
  }
}

const OPENAI_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>登录成功</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;line-height:1.6;">
  <h2 style="margin:0 0 8px;color:#2C5F2F;">OpenAI 登录成功</h2>
  <p style="margin:0;color:#444;">请返回 AI Team 应用继续使用。</p>
  <script>setTimeout(() => window.close(), 2500);</script>
</body></html>`;

const openAIErrorHtml = (message: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>登录失败</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;line-height:1.6;">
  <h2 style="margin:0 0 8px;color:#DC2626;">OpenAI 登录失败</h2>
  <p style="margin:0;color:#444;">${message}</p>
</body></html>`;

// ─── OAuth Login (System Browser + Local Server) ─────────────

export function openAILogin(_parentWindow?: unknown): Promise<{ success: boolean; email?: string; error?: string }> {
  return new Promise((resolve) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    let resolved = false;
    let server: Server | null = null;
    const finish = (result: { success: boolean; email?: string; error?: string }) => {
      if (resolved) return;
      resolved = true;
      if (server) {
        server.close();
        server = null;
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ success: false, error: "登录超时，请重试" });
    }, 120_000);

    server = createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? "/", REDIRECT_URI);
      if (requestUrl.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(openAIErrorHtml(`OAuth 错误: ${error}`));
        clearTimeout(timeout);
        finish({ success: false, error: `OAuth error: ${error}` });
        return;
      }

      if (!code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(openAIErrorHtml("未收到授权码"));
        clearTimeout(timeout);
        finish({ success: false, error: "No authorization code received" });
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(openAIErrorHtml("State 不匹配，可能存在安全风险"));
        clearTimeout(timeout);
        finish({ success: false, error: "State mismatch - possible CSRF attack" });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(OPENAI_SUCCESS_HTML);
      clearTimeout(timeout);

      try {
        const tokens = await exchangeCodeForTokens(code, codeVerifier);
        if (!tokens) {
          finish({ success: false, error: "Failed to exchange authorization code for tokens" });
          return;
        }

        const missingScopes = getMissingOpenAIScopes(tokens.accessToken);
        if (missingScopes.length > 0) {
          finish({ success: false, error: buildMissingScopesMessage(missingScopes) });
          return;
        }

        const settings = loadUserSettings();
        settings.openaiTokens = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          expiresAt: tokens.expiresAt,
        };
        saveUserSettings(settings);

        const decoded = decodeJWT(tokens.accessToken);
        finish({ success: true, email: decoded?.email ?? undefined });
      } catch (err) {
        finish({
          success: false,
          error: `Callback error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    server.listen(1455, "127.0.0.1", () => {
      const authUrl = new URL(AUTHORIZE_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("scope", OPENAI_OAUTH_SCOPE);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("id_token_add_organizations", "true");
      authUrl.searchParams.set("codex_cli_simplified_flow", "true");
      authUrl.searchParams.set("originator", "codex_cli_rs");
      void shell.openExternal(authUrl.toString());
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      finish({
        success: false,
        error: `本地回调端口 1455 启动失败: ${err.message}`,
      });
    });
  });
}

// ─── Token Exchange ──────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<OpenAIAuthTokens | null> {
  try {
    // Use Electron net.fetch so the request goes through system proxy
    const response = await net.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[openai-auth] Token exchange failed:", response.status, text);
      return null;
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
      console.error("[openai-auth] Token response missing fields");
      return null;
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      idToken: json.id_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  } catch (error) {
    console.error("[openai-auth] Token exchange error:", error);
    return null;
  }
}

// ─── Token Refresh ───────────────────────────────────────────

export async function refreshOpenAIToken(): Promise<boolean> {
  const settings = loadUserSettings();
  const tokens = settings.openaiTokens;

  if (!tokens?.refreshToken) {
    return false;
  }

  try {
    const response = await net.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      console.error("[openai-auth] Token refresh failed:", response.status);
      return false;
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
      console.error("[openai-auth] Refresh response missing fields");
      return false;
    }

    const missingScopes = getMissingOpenAIScopes(json.access_token);
    if (missingScopes.length > 0) {
      console.error("[openai-auth] Refresh token missing required scopes:", missingScopes.join(", "));
      return false;
    }

    const newTokens: OpenAIAuthTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      idToken: json.id_token ?? tokens.idToken,  // keep existing idToken if not refreshed
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    settings.openaiTokens = newTokens;
    saveUserSettings(settings);
    return true;
  } catch (error) {
    console.error("[openai-auth] Token refresh error:", error);
    return false;
  }
}

// ─── Logout ──────────────────────────────────────────────────

export function openAILogout(): void {
  const settings = loadUserSettings();
  delete settings.openaiTokens;
  saveUserSettings(settings);
}

// ─── Get Valid Access Token (auto-refresh if needed) ─────────

export async function getValidOpenAIToken(): Promise<string | null> {
  const settings = loadUserSettings();
  const tokens = settings.openaiTokens;

  if (!tokens?.accessToken) {
    return null;
  }

  if (getMissingOpenAIScopes(tokens.accessToken).length > 0) {
    return null;
  }

  // If token expires within 5 minutes, refresh it
  const REFRESH_BUFFER = 5 * 60 * 1000;
  if (tokens.expiresAt && tokens.expiresAt - Date.now() < REFRESH_BUFFER) {
    const refreshed = await refreshOpenAIToken();
    if (!refreshed) {
      return null;
    }
    // Reload settings after refresh
    const updatedSettings = loadUserSettings();
    const refreshedToken = updatedSettings.openaiTokens?.accessToken ?? null;
    if (getMissingOpenAIScopes(refreshedToken).length > 0) {
      return null;
    }
    return refreshedToken;
  }

  return tokens.accessToken;
}
