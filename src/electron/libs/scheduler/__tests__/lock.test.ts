import { describe, it, expect, vi } from "vitest";
import { createMutex } from "../core/lock.js";

describe("createMutex", () => {
  it("runs a single task", async () => {
    const locked = createMutex();
    const result = await locked(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent tasks (FIFO order)", async () => {
    const locked = createMutex();
    const order: number[] = [];

    await Promise.all([
      locked(async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        order.push(1);
      }),
      locked(async () => {
        order.push(2);
      }),
      locked(async () => {
        order.push(3);
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("releases lock even when task throws", async () => {
    const locked = createMutex();
    await expect(
      locked(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The next task should still run despite the previous failure
    const result = await locked(async () => "ok");
    expect(result).toBe("ok");
  });

  it("propagates the return value", async () => {
    const locked = createMutex();
    const result = await locked(async () => ({ x: 1 }));
    expect(result).toEqual({ x: 1 });
  });

  it("handles many concurrent tasks without deadlock", async () => {
    const locked = createMutex();
    const results: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        locked(async () => {
          results.push(i);
        }),
      ),
    );
    expect(results).toHaveLength(20);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
