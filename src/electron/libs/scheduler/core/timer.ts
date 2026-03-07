import type { TaskState } from "./types.js";

// Maximum setTimeout delay before we rearm (prevents long-timer drift).
// Node.js has a ~24.8-day limit; we keep it at 60 s as a safety cap.
const MAX_TIMER_DELAY_MS = 60_000;

export interface TimerSlot {
  enabled: boolean;
  state: TaskState;
}

/**
 * Arm a one-shot setTimeout that fires at the nearest upcoming task time.
 * Call this whenever the task list changes (add / update / delete / run).
 *
 * @param timer  - current timer reference (pass a boxed ref so caller can share state)
 * @param tasks  - all tasks (enabled check + nextRunAtMs)
 * @param onTick - callback invoked when the timer fires
 * @param nowMs  - current epoch ms (injectable for testing)
 */
export function armTimer(
  timerRef: { value: ReturnType<typeof setTimeout> | null },
  tasks: TimerSlot[],
  onTick: () => void,
  nowMs: number = Date.now(),
): void {
  stopTimer(timerRef);

  const nearest = tasks
    .filter((t) => t.enabled && typeof t.state.nextRunAtMs === "number")
    .reduce<number>((min, t) => Math.min(min, t.state.nextRunAtMs!), Infinity);

  if (!Number.isFinite(nearest)) return;

  const delay = Math.max(1_000, Math.min(nearest - nowMs, MAX_TIMER_DELAY_MS));
  timerRef.value = setTimeout(onTick, delay);
}

/**
 * Stop the current timer if one is running.
 */
export function stopTimer(timerRef: { value: ReturnType<typeof setTimeout> | null }): void {
  if (timerRef.value !== null) {
    clearTimeout(timerRef.value);
    timerRef.value = null;
  }
}

/**
 * Create a mutable timer reference (boxed so armTimer/stopTimer can mutate it).
 */
export function createTimerRef(): { value: ReturnType<typeof setTimeout> | null } {
  return { value: null };
}
