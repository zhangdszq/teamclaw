import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/mock-electron-user-data" },
}));

vi.mock("../user-settings.js", () => ({
  loadUserSettings: () => ({}),
}));

vi.mock("../util.js", () => ({
  getEnhancedEnv: () => ({}),
}));

vi.mock("../memory-store.js", () => ({
  getRecentConversationBlocks: () => [],
}));

import { MediaGroupBuffer, type FlushedMediaGroup } from "../bot-base.js";

describe("MediaGroupBuffer", () => {
  let flushed: Array<{ groupKey: string; result: FlushedMediaGroup }>;
  let buffer: MediaGroupBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    buffer = new MediaGroupBuffer(
      (groupKey, result) => { flushed.push({ groupKey, result }); },
      500,
    );
  });

  afterEach(() => {
    buffer.clear();
    vi.useRealTimers();
  });

  it("aggregates multiple items into a single flush", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1, caption: "写公众号" });
    buffer.add("g1", "chat1", { filePath: "/tmp/b.jpg", messageId: 2 });
    buffer.add("g1", "chat1", { filePath: "/tmp/c.jpg", messageId: 3 });

    expect(flushed).toHaveLength(0);
    expect(buffer.size).toBe(1);

    vi.advanceTimersByTime(500);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].result.filePaths).toEqual(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);
    expect(flushed[0].result.messageIds).toEqual([1, 2, 3]);
    expect(flushed[0].result.caption).toBe("写公众号");
    expect(flushed[0].result.chatId).toBe("chat1");
    expect(buffer.size).toBe(0);
  });

  it("uses caption from any message if the first has none", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1 });
    buffer.add("g1", "chat1", { filePath: "/tmp/b.jpg", messageId: 2, caption: "后来的caption" });
    buffer.add("g1", "chat1", { filePath: "/tmp/c.jpg", messageId: 3 });

    vi.advanceTimersByTime(500);

    expect(flushed[0].result.caption).toBe("后来的caption");
  });

  it("prefers the first caption and ignores subsequent ones", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1, caption: "第一个" });
    buffer.add("g1", "chat1", { filePath: "/tmp/b.jpg", messageId: 2, caption: "第二个" });

    vi.advanceTimersByTime(500);

    expect(flushed[0].result.caption).toBe("第一个");
  });

  it("resets the timer on each add (debounce)", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1 });
    vi.advanceTimersByTime(400);

    expect(flushed).toHaveLength(0);

    buffer.add("g1", "chat1", { filePath: "/tmp/b.jpg", messageId: 2 });
    vi.advanceTimersByTime(400);

    // Still not flushed — timer was reset
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(100);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].result.filePaths).toEqual(["/tmp/a.jpg", "/tmp/b.jpg"]);
  });

  it("handles different groups independently", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1, caption: "组1" });
    buffer.add("g2", "chat1", { filePath: "/tmp/x.jpg", messageId: 10, caption: "组2" });
    buffer.add("g1", "chat1", { filePath: "/tmp/b.jpg", messageId: 2 });

    expect(buffer.size).toBe(2);

    vi.advanceTimersByTime(500);

    expect(flushed).toHaveLength(2);
    const g1 = flushed.find((f) => f.groupKey === "g1")!;
    const g2 = flushed.find((f) => f.groupKey === "g2")!;
    expect(g1.result.filePaths).toEqual(["/tmp/a.jpg", "/tmp/b.jpg"]);
    expect(g2.result.filePaths).toEqual(["/tmp/x.jpg"]);
  });

  it("handles null filePath gracefully", () => {
    buffer.add("g1", "chat1", { filePath: null, messageId: 1 });
    buffer.add("g1", "chat1", { filePath: "/tmp/b.jpg", messageId: 2 });

    vi.advanceTimersByTime(500);

    expect(flushed[0].result.filePaths).toEqual(["/tmp/b.jpg"]);
    expect(flushed[0].result.messageIds).toEqual([1, 2]);
  });

  it("clear() cancels pending timers", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1 });

    expect(buffer.size).toBe(1);
    buffer.clear();
    expect(buffer.size).toBe(0);

    vi.advanceTimersByTime(1000);

    expect(flushed).toHaveLength(0);
  });

  it("single-item group flushes after timeout", () => {
    buffer.add("g1", "chat1", { filePath: "/tmp/a.jpg", messageId: 1, caption: "单图" });

    vi.advanceTimersByTime(500);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].result.filePaths).toEqual(["/tmp/a.jpg"]);
    expect(flushed[0].result.caption).toBe("单图");
  });

  it("6-photo album aggregates correctly", () => {
    for (let i = 1; i <= 6; i++) {
      buffer.add("album1", "chat1", {
        filePath: `/tmp/photo${i}.jpg`,
        messageId: i,
        caption: i === 1 ? "帮我用这些图写公众号文章" : undefined,
      });
    }

    expect(buffer.size).toBe(1);

    vi.advanceTimersByTime(500);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].result.filePaths).toHaveLength(6);
    expect(flushed[0].result.messageIds).toEqual([1, 2, 3, 4, 5, 6]);
    expect(flushed[0].result.caption).toBe("帮我用这些图写公众号文章");
  });
});
