import { describe, it, expect, beforeEach } from "vitest";
import { calculateNextRunAtMs, clearCronCacheForTest } from "../core/schedule.js";
import type { ScheduleConfig } from "../core/types.js";

beforeEach(() => clearCronCacheForTest());

const NOW = new Date("2024-06-15T10:00:00.000Z").getTime(); // Saturday 10:00 UTC

describe("calculateNextRunAtMs — once", () => {
  it("returns future timestamp", () => {
    const future = new Date(NOW + 60_000).toISOString();
    const result = calculateNextRunAtMs({ kind: "once", scheduledTime: future }, NOW);
    expect(result).toBe(NOW + 60_000);
  });

  it("returns undefined for past time", () => {
    const past = new Date(NOW - 1000).toISOString();
    expect(calculateNextRunAtMs({ kind: "once", scheduledTime: past }, NOW)).toBeUndefined();
  });

  it("returns undefined for invalid date", () => {
    expect(
      calculateNextRunAtMs({ kind: "once", scheduledTime: "not-a-date" }, NOW),
    ).toBeUndefined();
  });
});

describe("calculateNextRunAtMs — interval", () => {
  it("returns anchor + 1*interval when no elapsed time", () => {
    const anchor = NOW;
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 30, intervalUnit: "minutes", anchorMs: anchor };
    // at exactly anchor: elapsed=0, steps=1
    expect(calculateNextRunAtMs(cfg, anchor)).toBe(anchor + 30 * 60_000);
  });

  it("returns next interval when past due", () => {
    const anchor = NOW - 90_000; // 1.5 min ago
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 1, intervalUnit: "minutes", anchorMs: anchor };
    // elapsed=90s, steps=ceil(90/60)=2 → anchor + 2min
    expect(calculateNextRunAtMs(cfg, NOW)).toBe(anchor + 2 * 60_000);
  });

  it("computes hours correctly", () => {
    const anchor = NOW;
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 2, intervalUnit: "hours", anchorMs: anchor };
    expect(calculateNextRunAtMs(cfg, anchor)).toBe(anchor + 2 * 3_600_000);
  });

  it("computes days correctly", () => {
    const anchor = NOW;
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 1, intervalUnit: "days", anchorMs: anchor };
    expect(calculateNextRunAtMs(cfg, anchor)).toBe(anchor + 86_400_000);
  });

  it("computes weeks correctly", () => {
    const anchor = NOW;
    const cfg: ScheduleConfig = { kind: "interval", intervalValue: 1, intervalUnit: "weeks", anchorMs: anchor };
    expect(calculateNextRunAtMs(cfg, anchor)).toBe(anchor + 7 * 86_400_000);
  });

  it("returns undefined when intervalValue missing", () => {
    const cfg = { kind: "interval" as const, intervalValue: 0, intervalUnit: "minutes" as const };
    expect(calculateNextRunAtMs(cfg, NOW)).toBeUndefined();
  });
});

describe("calculateNextRunAtMs — daily", () => {
  it("returns today's time when not yet reached", () => {
    // NOW is 10:00 UTC, target 11:00 local (assume UTC for simplicity)
    const nowLocal = new Date("2024-06-15T10:00:00");
    const nowMs = nowLocal.getTime();
    const cfg: ScheduleConfig = { kind: "daily", dailyTime: "11:00" };
    const result = calculateNextRunAtMs(cfg, nowMs);
    expect(result).toBeDefined();
    const next = new Date(result!);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  it("returns tomorrow's time when already passed today", () => {
    const nowLocal = new Date("2024-06-15T12:00:00");
    const nowMs = nowLocal.getTime();
    const cfg: ScheduleConfig = { kind: "daily", dailyTime: "09:00" };
    const result = calculateNextRunAtMs(cfg, nowMs);
    expect(result).toBeDefined();
    const next = new Date(result!);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(9);
  });

  it("respects dailyDays filter", () => {
    // 2024-06-15 is Saturday (day=6). Ask for Sunday (0) only
    const nowLocal = new Date("2024-06-15T08:00:00");
    const nowMs = nowLocal.getTime();
    const cfg: ScheduleConfig = { kind: "daily", dailyTime: "08:00", dailyDays: [0] };
    const result = calculateNextRunAtMs(cfg, nowMs);
    expect(result).toBeDefined();
    const next = new Date(result!);
    expect(next.getDay()).toBe(0); // Sunday
  });

  it("returns undefined for invalid time", () => {
    expect(
      calculateNextRunAtMs({ kind: "daily", dailyTime: "not:valid" }, NOW),
    ).toBeUndefined();
  });
});

describe("calculateNextRunAtMs — cron", () => {
  it("computes next run from cron expression (UTC)", () => {
    // Every minute
    const cfg: ScheduleConfig = { kind: "cron", expr: "* * * * *", timezone: "UTC" };
    const result = calculateNextRunAtMs(cfg, NOW);
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(NOW);
  });

  it("returns undefined for invalid cron expression", () => {
    const cfg: ScheduleConfig = { kind: "cron", expr: "not-valid", timezone: "UTC" };
    expect(calculateNextRunAtMs(cfg, NOW)).toBeUndefined();
  });

  it("daily cron (0 9 * * *) returns next 9am", () => {
    // NOW is 10:00 UTC, so next 9am UTC is tomorrow
    const cfg: ScheduleConfig = { kind: "cron", expr: "0 9 * * *", timezone: "UTC" };
    const result = calculateNextRunAtMs(cfg, NOW);
    expect(result).toBeDefined();
    const next = new Date(result!);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    // Should be next day since it's 10am now
    expect(next.getUTCDate()).toBeGreaterThan(new Date(NOW).getUTCDate());
  });
});
