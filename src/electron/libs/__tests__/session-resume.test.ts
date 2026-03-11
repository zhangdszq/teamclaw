import { describe, expect, it } from "vitest";

import {
  buildResumeFallbackPrompt,
  isResumeReadyMessage,
  shouldFallbackFromContinueError,
} from "../session-resume.js";

describe("session-resume helpers", () => {
  it("does not mark system init as resume-ready", () => {
    expect(isResumeReadyMessage({ type: "system", subtype: "init", session_id: "abc" })).toBe(false);
  });

  it("marks post-init stream messages as resume-ready", () => {
    expect(isResumeReadyMessage({ type: "stream_event", event: { type: "content_block_start" } })).toBe(true);
    expect(isResumeReadyMessage({ type: "assistant", message: { content: [] } })).toBe(true);
  });

  it("detects lost upstream conversation errors", () => {
    expect(
      shouldFallbackFromContinueError(new Error("No conversation found with session ID: 123"))
    ).toBe(true);
    expect(shouldFallbackFromContinueError(new Error("HTTP 502 upstream failed"))).toBe(false);
  });

  it("builds a local-history fallback prompt", () => {
    const prompt = buildResumeFallbackPrompt(
      [
        { type: "user_prompt", prompt: "先帮我看一下这个报错" },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "这是一个续聊状态丢失的问题。" }],
          },
        } as any,
      ],
      "那现在应该怎么修？"
    );

    expect(prompt).toContain("## 本地历史");
    expect(prompt).toContain("[用户] 先帮我看一下这个报错");
    expect(prompt).toContain("[助手] 这是一个续聊状态丢失的问题。");
    expect(prompt).toContain("## 用户最新消息");
    expect(prompt).toContain("那现在应该怎么修？");
  });
});
