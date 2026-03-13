import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  settings: {} as {
    openaiTokens?: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
  },
}));

vi.mock("electron", () => ({
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../user-settings.js", () => ({
  loadUserSettings: () => mockState.settings,
  saveUserSettings: (next: typeof mockState.settings) => {
    mockState.settings = next;
  },
}));

import {
  OPENAI_OAUTH_SCOPE,
  REQUIRED_OPENAI_API_SCOPES,
  getMissingOpenAIScopes,
  getOpenAIAuthStatus,
} from "../openai-auth.js";

function makeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.sig`;
}

describe("openai auth scopes", () => {
  beforeEach(() => {
    mockState.settings = {};
  });

  it("requests the API scopes required by the responses proxy", () => {
    const requestedScopes = OPENAI_OAUTH_SCOPE.split(" ");
    expect(requestedScopes).toEqual(expect.arrayContaining([...REQUIRED_OPENAI_API_SCOPES]));
  });

  it("detects missing API scopes from legacy OAuth tokens", () => {
    const accessToken = makeJwt({
      email: "user@example.com",
      scp: ["openid", "profile", "email", "offline_access"],
    });

    expect(getMissingOpenAIScopes(accessToken)).toEqual(REQUIRED_OPENAI_API_SCOPES);
  });

  it("marks stored OAuth as needing re-login when scopes are incomplete", () => {
    mockState.settings = {
      openaiTokens: {
        accessToken: makeJwt({
          email: "user@example.com",
          scp: ["openid", "profile", "email", "offline_access"],
        }),
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
      },
    };

    expect(getOpenAIAuthStatus()).toMatchObject({
      loggedIn: false,
      needsReauth: true,
      missingScopes: [...REQUIRED_OPENAI_API_SCOPES],
    });
  });

  it("keeps OAuth logged in when all required scopes are present", () => {
    mockState.settings = {
      openaiTokens: {
        accessToken: makeJwt({
          email: "user@example.com",
          scp: [...REQUIRED_OPENAI_API_SCOPES, "openid", "profile", "email", "offline_access"],
        }),
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
      },
    };

    expect(getOpenAIAuthStatus()).toMatchObject({
      loggedIn: true,
      email: "user@example.com",
    });
  });
});
