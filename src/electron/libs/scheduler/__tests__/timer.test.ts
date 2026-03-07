import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { armTimer, stopTimer, createTimerRef } from "../core/timer.js";

describe("armTimer / stopTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not set timer when no enabled tasks", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    armTimer(ref, [], tick, Date.now());
    expect(ref.value).toBeNull();
    expect(tick).not.toHaveBeenCalled();
  });

  it("does not set timer when no nextRunAtMs on enabled tasks", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    armTimer(ref, [{ enabled: true, state: {} }], tick, Date.now());
    expect(ref.value).toBeNull();
  });

  it("fires onTick at the nearest task time", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    const now = Date.now();
    const future = now + 5_000;
    armTimer(ref, [{ enabled: true, state: { nextRunAtMs: future } }], tick, now);

    expect(ref.value).not.toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledOnce();
  });

  it("uses minimum delay (1s) for already-due tasks", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    const now = Date.now();
    const past = now - 10_000;
    armTimer(ref, [{ enabled: true, state: { nextRunAtMs: past } }], tick, now);

    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledOnce();
  });

  it("caps delay at MAX_TIMER_DELAY_MS (60s)", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    const now = Date.now();
    const farFuture = now + 3_600_000; // 1 hour
    armTimer(ref, [{ enabled: true, state: { nextRunAtMs: farFuture } }], tick, now);

    // Should not fire after 60s (it will rearm when the tick is called)
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledOnce(); // fires at 60s cap
  });

  it("selects the nearest among multiple tasks", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    const now = Date.now();
    armTimer(
      ref,
      [
        { enabled: true, state: { nextRunAtMs: now + 10_000 } },
        { enabled: true, state: { nextRunAtMs: now + 5_000 } },
        { enabled: false, state: { nextRunAtMs: now + 1_000 } }, // disabled
      ],
      tick,
      now,
    );
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledOnce();
  });

  it("stopTimer clears the timer", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    const now = Date.now();
    armTimer(ref, [{ enabled: true, state: { nextRunAtMs: now + 5_000 } }], tick, now);
    expect(ref.value).not.toBeNull();

    stopTimer(ref);
    expect(ref.value).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("armTimer clears previous timer before rearming", () => {
    const ref = createTimerRef();
    const tick = vi.fn();
    const now = Date.now();
    armTimer(ref, [{ enabled: true, state: { nextRunAtMs: now + 10_000 } }], tick, now);
    armTimer(ref, [{ enabled: true, state: { nextRunAtMs: now + 5_000 } }], tick, now);

    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledOnce(); // fires exactly once
  });
});
