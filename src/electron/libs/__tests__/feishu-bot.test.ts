import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/mock/user-data"),
  },
}));

import {
  buildFeishuInboundKeys,
  claimFeishuInboundKeys,
  releaseFeishuInboundKeys,
  shouldSkipFeishuFinalReply,
} from "../feishu-bot-utils.js";

describe("feishu bot duplicate guards", () => {
  it("builds both event and message keys for webhook delivery", () => {
    expect(
      buildFeishuInboundKeys("assistant-1", "msg-1", "evt-1"),
    ).toEqual([
      "feishu-event:assistant-1:evt-1",
      "feishu:assistant-1:msg-1",
    ]);
  });

  it("claims inbound keys atomically and blocks duplicate retries", () => {
    const store = new Map<string, number>();
    const inflight = new Set<string>();
    const keys = buildFeishuInboundKeys("assistant-1", "msg-1", "evt-1");

    expect(claimFeishuInboundKeys(keys, store, inflight)).toBe(true);
    expect(claimFeishuInboundKeys(keys, store, inflight)).toBe(false);

    releaseFeishuInboundKeys(keys, inflight);
    expect(claimFeishuInboundKeys(keys, store, inflight)).toBe(false);
  });

  it("treats tool messages and final replies with only mention/tag differences as duplicates", () => {
    expect(
      shouldSkipFeishuFinalReply(
        "处理完成，请查看结果。",
        '<at user_id="ou_xxx">张三</at>\n处理完成，请查看结果。',
      ),
    ).toBe(true);
  });

  it("does not suppress the final reply when the tool only sent progress text", () => {
    expect(
      shouldSkipFeishuFinalReply(
        "正在整理资料，请稍候。",
        "处理完成，请查看结果。",
      ),
    ).toBe(false);
  });
});
