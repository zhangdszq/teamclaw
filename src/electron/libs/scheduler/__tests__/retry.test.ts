import { describe, it, expect } from "vitest";
import {
  isTransientError,
  classifyError,
  getBackoffDelayMs,
  shouldRetryOneShotTask,
  getBackoffNextRunMs,
  DEFAULT_BACKOFF_SCHEDULE_MS,
} from "../core/retry.js";

describe("isTransientError", () => {
  it("returns true for rate limit errors", () => {
    expect(isTransientError("Error: 429 Too Many Requests")).toBe(true);
    expect(isTransientError("rate limit exceeded")).toBe(true);
    expect(isTransientError("rate_limit hit")).toBe(true);
  });

  it("returns true for network errors", () => {
    expect(isTransientError("ECONNRESET connection reset")).toBe(true);
    expect(isTransientError("fetch failed")).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
  });

  it("returns true for server errors", () => {
    expect(isTransientError("Server returned 503")).toBe(true);
    expect(isTransientError("502 Bad Gateway")).toBe(true);
  });

  it("returns true for timeout errors", () => {
    expect(isTransientError("ETIMEDOUT")).toBe(true);
    expect(isTransientError("request timed out")).toBe(true);
  });

  it("returns true for overloaded errors", () => {
    expect(isTransientError("529 overloaded_error")).toBe(true);
    expect(isTransientError("high demand")).toBe(true);
  });

  it("returns false for permanent errors", () => {
    expect(isTransientError("invalid API key")).toBe(false);
    expect(isTransientError("401 Unauthorized")).toBe(false);
    expect(isTransientError("configuration error: missing model")).toBe(false);
    expect(isTransientError("")).toBe(false);
  });
});

describe("classifyError", () => {
  it("classifies rate_limit", () => {
    expect(classifyError("429 too many requests")).toBe("rate_limit");
  });

  it("classifies network", () => {
    expect(classifyError("ECONNRESET")).toBe("network");
  });

  it("returns null for permanent errors", () => {
    expect(classifyError("invalid credentials")).toBeNull();
  });
});

describe("getBackoffDelayMs", () => {
  it("returns 0 for 0 errors", () => {
    expect(getBackoffDelayMs(0)).toBe(0);
  });

  it("returns first delay for 1 error", () => {
    expect(getBackoffDelayMs(1)).toBe(DEFAULT_BACKOFF_SCHEDULE_MS[0]);
  });

  it("returns second delay for 2 errors", () => {
    expect(getBackoffDelayMs(2)).toBe(DEFAULT_BACKOFF_SCHEDULE_MS[1]);
  });

  it("caps at last entry for large error count", () => {
    const lastDelay = DEFAULT_BACKOFF_SCHEDULE_MS[DEFAULT_BACKOFF_SCHEDULE_MS.length - 1];
    expect(getBackoffDelayMs(999)).toBe(lastDelay);
  });

  it("accepts custom schedule", () => {
    expect(getBackoffDelayMs(1, [1000, 2000, 3000])).toBe(1000);
    expect(getBackoffDelayMs(2, [1000, 2000, 3000])).toBe(2000);
    expect(getBackoffDelayMs(10, [1000, 2000, 3000])).toBe(3000);
  });
});

describe("shouldRetryOneShotTask", () => {
  it("retries transient error within limit", () => {
    expect(shouldRetryOneShotTask(1, "fetch failed")).toBe(true);
    expect(shouldRetryOneShotTask(2, "rate limit exceeded")).toBe(true);
  });

  it("stops retrying after maxRetries", () => {
    expect(shouldRetryOneShotTask(3, "fetch failed")).toBe(false);
    expect(shouldRetryOneShotTask(4, "fetch failed")).toBe(false);
  });

  it("does not retry permanent errors", () => {
    expect(shouldRetryOneShotTask(0, "invalid API key")).toBe(false);
  });
});

describe("getBackoffNextRunMs", () => {
  it("returns nowMs + backoff", () => {
    const now = 1_000_000;
    const result = getBackoffNextRunMs(1, now);
    expect(result).toBe(now + DEFAULT_BACKOFF_SCHEDULE_MS[0]);
  });
});
