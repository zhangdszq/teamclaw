import { describe, expect, it } from "vitest";

import {
  buildContinuePrompt,
  buildResumeFallbackPrompt,
  buildSkillContinuationGuidance,
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
    expect(
      shouldFallbackFromContinueError(
        new Error('--resume requires a valid session ID when used with --print. Provided value "missing-remote-session-for-fallback" is not a valid UUID')
      )
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

  it("preserves delegate tool calls and tool results in fallback history", () => {
    const prompt = buildResumeFallbackPrompt(
      [
        { type: "user_prompt", prompt: "继续刚才的排查" },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "mcp__vk-shared__delegate_to_cursor",
                input: {
                  cwd: "/repo",
                  task: "检查 continue 时为什么会丢结果",
                },
              },
            ],
          },
        } as any,
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_123",
                content: "Cursor 已定位到 session-resume.ts 过滤掉了 tool_result block。",
              },
              {
                type: "text",
                text: "Base directory for this skill: /Users/demo/.claude/skills/operate-coding-tools",
              },
            ],
          },
        } as any,
      ],
      "那就继续修复吧"
    );

    expect(prompt).toContain("[工具调用 mcp__vk-shared__delegate_to_cursor]");
    expect(prompt).toContain("检查 continue 时为什么会丢结果");
    expect(prompt).toContain("[工具结果]");
    expect(prompt).toContain("Cursor 已定位到 session-resume.ts 过滤掉了 tool_result block。");
    expect(prompt).not.toContain("Base directory for this skill");
  });

  it("adds Cursor delegation guidance for operate-coding-tools sessions", () => {
    const guidance = buildSkillContinuationGuidance(["operate-coding-tools"]);
    const prompt = buildContinuePrompt("继续", ["operate-coding-tools"]);

    expect(guidance).toContain("/operate-coding-tools");
    expect(guidance).toContain("必须让 Cursor 完成实质分析");
    expect(prompt).toContain("## 当前技能约束");
    expect(prompt).toContain("## 用户最新消息");
    expect(prompt).toContain("继续");
  });
});
