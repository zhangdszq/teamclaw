import { Cron } from "croner";
import type { ScheduleConfig } from "./types.js";

// Cache for croner instances to avoid repeated parsing
const CRON_CACHE_MAX = 256;
const cronCache = new Map<string, Cron>();

function getCachedCron(expr: string, timezone: string): Cron {
  const key = `${timezone}\x00${expr}`;
  const cached = cronCache.get(key);
  if (cached) return cached;
  if (cronCache.size >= CRON_CACHE_MAX) {
    const oldest = cronCache.keys().next().value;
    if (oldest) cronCache.delete(oldest);
  }
  const cron = new Cron(expr, { timezone, catch: false });
  cronCache.set(key, cron);
  return cron;
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Compute the next scheduled run time (as epoch ms) for a given schedule config.
 * Returns `undefined` when there is no future run (e.g., one-shot past due, invalid expr).
 *
 * Pure function — no side effects, no I/O. Suitable for unit testing.
 */
export function calculateNextRunAtMs(schedule: ScheduleConfig, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "once": {
      const atMs = new Date(schedule.scheduledTime).getTime();
      if (!Number.isFinite(atMs)) return undefined;
      return atMs > nowMs ? atMs : undefined;
    }

    case "interval": {
      const { intervalValue, intervalUnit } = schedule;
      if (intervalValue == null || intervalValue <= 0 || !intervalUnit) return undefined;

      let everyMs: number;
      switch (intervalUnit) {
        case "minutes":
          everyMs = intervalValue * 60_000;
          break;
        case "hours":
          everyMs = intervalValue * 3_600_000;
          break;
        case "days":
          everyMs = intervalValue * 86_400_000;
          break;
        case "weeks":
          everyMs = intervalValue * 7 * 86_400_000;
          break;
      }

      const anchor = typeof schedule.anchorMs === "number" ? schedule.anchorMs : nowMs;
      if (nowMs < anchor) return anchor;
      const elapsed = nowMs - anchor;
      const steps = Math.max(1, Math.ceil(elapsed / everyMs));
      return anchor + steps * everyMs;
    }

    case "daily": {
      const { dailyTime, dailyDays } = schedule;
      if (!dailyTime) return undefined;
      const [hours, minutes] = dailyTime.split(":").map(Number);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;

      const candidate = new Date(nowMs);
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate.getTime() <= nowMs) {
        candidate.setDate(candidate.getDate() + 1);
      }

      if (dailyDays && dailyDays.length > 0) {
        for (let i = 0; i < 8; i++) {
          if (dailyDays.includes(candidate.getDay())) {
            return candidate.getTime();
          }
          candidate.setDate(candidate.getDate() + 1);
        }
        return undefined;
      }

      return candidate.getTime();
    }

    case "cron": {
      const { expr, timezone } = schedule;
      if (!expr?.trim()) return undefined;
      try {
        const tz = timezone?.trim() || localTimezone();
        const cron = getCachedCron(expr.trim(), tz);
        const next = cron.nextRun(new Date(nowMs));
        if (!next) return undefined;
        const nextMs = next.getTime();
        if (!Number.isFinite(nextMs) || nextMs <= nowMs) {
          // Retry from next second (croner timezone edge case workaround)
          const retry = cron.nextRun(new Date(Math.floor(nowMs / 1000) * 1000 + 1000));
          if (retry) {
            const retryMs = retry.getTime();
            if (Number.isFinite(retryMs) && retryMs > nowMs) return retryMs;
          }
          return undefined;
        }
        return nextMs;
      } catch {
        return undefined;
      }
    }
  }
}

export function clearCronCacheForTest(): void {
  cronCache.clear();
}
