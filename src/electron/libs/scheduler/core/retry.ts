// Retry policy for scheduled task execution failures.
// Classifies errors as transient (retryable) or permanent (fail fast).

// ─── Error classification ─────────────────────────────────────────────────────

const TRANSIENT_PATTERNS: Record<string, RegExp> = {
  rate_limit: /(rate[_\s]limit|too many requests|429|resource has been exhausted)/i,
  overloaded: /\b529\b|overloaded(?:_error)?|high demand|temporarily overloaded|capacity exceeded/i,
  network: /(network|econnreset|econnrefused|fetch failed|socket)/i,
  timeout: /(timeout|etimedout|timed out)/i,
  server_error: /\b5\d{2}\b/,
};

export type RetryErrorKind = keyof typeof TRANSIENT_PATTERNS;

/**
 * Returns true if the error message matches a known transient (retryable) pattern.
 */
export function isTransientError(error: string): boolean {
  if (!error) return false;
  return Object.values(TRANSIENT_PATTERNS).some((re) => re.test(error));
}

/**
 * Returns the matched transient error kind, or null if the error is permanent.
 */
export function classifyError(error: string): RetryErrorKind | null {
  if (!error) return null;
  for (const [kind, re] of Object.entries(TRANSIENT_PATTERNS)) {
    if (re.test(error)) return kind as RetryErrorKind;
  }
  return null;
}

// ─── Backoff schedule ─────────────────────────────────────────────────────────

/** Default exponential backoff schedule (ms), indexed by consecutive error count. */
export const DEFAULT_BACKOFF_SCHEDULE_MS = [
  30_000,        // 1st consecutive error: 30 s
  60_000,        // 2nd: 1 min
  5 * 60_000,    // 3rd: 5 min
  15 * 60_000,   // 4th: 15 min
  60 * 60_000,   // 5th+: 1 hour
];

/**
 * Compute backoff delay (ms) for the given consecutive error count.
 * Returns the last entry in the schedule for counts beyond the schedule length.
 */
export function getBackoffDelayMs(
  consecutiveErrors: number,
  schedule: number[] = DEFAULT_BACKOFF_SCHEDULE_MS,
): number {
  if (consecutiveErrors <= 0) return 0;
  const idx = Math.min(consecutiveErrors - 1, schedule.length - 1);
  return schedule[Math.max(0, idx)];
}

// ─── One-shot retry policy ────────────────────────────────────────────────────

/** Default max retries for one-shot tasks on transient errors. */
export const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

/**
 * Determine whether a one-shot task should be retried after a failure.
 *
 * @param consecutiveErrors - how many times it has already failed
 * @param error             - error message from the last run
 * @param maxRetries        - maximum allowed retries (default 3)
 */
export function shouldRetryOneShotTask(
  consecutiveErrors: number,
  error: string,
  maxRetries: number = DEFAULT_MAX_TRANSIENT_RETRIES,
): boolean {
  if (consecutiveErrors >= maxRetries) return false;
  return isTransientError(error);
}

// ─── Next-run computation after failure ──────────────────────────────────────

/**
 * Compute the next run time after a failure (backoff from now).
 * Returns epoch ms.
 */
export function getBackoffNextRunMs(
  consecutiveErrors: number,
  nowMs: number = Date.now(),
  schedule: number[] = DEFAULT_BACKOFF_SCHEDULE_MS,
): number {
  return nowMs + getBackoffDelayMs(consecutiveErrors, schedule);
}
