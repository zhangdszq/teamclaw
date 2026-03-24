/**
 * Pause guard for expired WeChat sessions.
 */

const PAUSE_DURATION_MS = 60 * 60 * 1000;

interface AccountPauseState {
  pausedAt: number;
  resumeAt: number;
  reason: string;
}

const pauseStates = new Map<string, AccountPauseState>();

export function isPaused(accountId: string): boolean {
  const state = pauseStates.get(accountId);
  if (!state) return false;
  if (Date.now() >= state.resumeAt) {
    pauseStates.delete(accountId);
    return false;
  }
  return true;
}

export function getPauseRemainingMs(accountId: string): number {
  const state = pauseStates.get(accountId);
  if (!state) return 0;
  const remaining = state.resumeAt - Date.now();
  if (remaining <= 0) {
    pauseStates.delete(accountId);
    return 0;
  }
  return remaining;
}

export function setPaused(accountId: string, reason = "Session expired"): void {
  const now = Date.now();
  pauseStates.set(accountId, {
    pausedAt: now,
    resumeAt: now + PAUSE_DURATION_MS,
    reason,
  });
  console.log(`[weixin-session-guard] account=${accountId} paused: ${reason}`);
}

export function clearPause(accountId: string): void {
  pauseStates.delete(accountId);
}

export function clearAllPauses(): void {
  pauseStates.clear();
}
