import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import {
  bufferFromFeishuDownloadResponse,
  buildRecentFeishuAttachmentContext,
  FEISHU_ATTACHMENT_CONTEXT_TTL_MS,
  parseFeishuPostContent,
  type RecentFeishuAttachment,
} from "../feishu-media.js";

describe("feishu media helpers", () => {
  it("reads buffers from SDK stream wrappers", async () => {
    const response = {
      getReadableStream: () => Readable.from([Buffer.from("hello "), Buffer.from("world")]),
    };

    const buffer = await bufferFromFeishuDownloadResponse(response);

    expect(buffer?.toString("utf8")).toBe("hello world");
  });

  it("reads buffers from nested data payloads", async () => {
    const response = {
      data: {
        getReadableStream: () => Readable.from([Buffer.from("nested")]),
      },
    };

    const buffer = await bufferFromFeishuDownloadResponse(response);

    expect(buffer?.toString("utf8")).toBe("nested");
  });

  it("extracts embedded media attachments from post content", () => {
    const parsed = parseFeishuPostContent({
      content: [
        [{ tag: "media", file_key: "file_v3_demo", image_key: "img_v3_demo" }],
        [{ tag: "text", text: "帮我分析这个视频" }],
      ],
    });

    expect(parsed.text).toBe("帮我分析这个视频");
    expect(parsed.imageKeys).toEqual([]);
    expect(parsed.attachments).toEqual([
      { kind: "media", fileKey: "file_v3_demo", fileName: undefined },
    ]);
  });

  it("builds recent attachment context for follow-up messages", () => {
    const attachment: RecentFeishuAttachment = {
      kind: "video",
      fileName: "sales.mp4",
      filePath: "/tmp/sales.mp4",
      sourceMessageId: "msg-1",
      receivedAt: 1_000,
    };

    const context = buildRecentFeishuAttachmentContext(attachment, "发了啊，帮我解析这个视频", 2_000);

    expect(context).toContain("当前对话最近收到的附件");
    expect(context).toContain("sales.mp4");
    expect(context).toContain("/tmp/sales.mp4");
  });

  it("skips attachment context for stale or unrelated follow-ups", () => {
    const attachment: RecentFeishuAttachment = {
      kind: "file",
      fileName: "brief.pdf",
      filePath: "/tmp/brief.pdf",
      sourceMessageId: "msg-2",
      receivedAt: 1_000,
    };

    expect(
      buildRecentFeishuAttachmentContext(attachment, "今天天气怎么样", 2_000),
    ).toBeUndefined();

    expect(
      buildRecentFeishuAttachmentContext(
        attachment,
        "帮我看这个文件",
        1_000 + FEISHU_ATTACHMENT_CONTEXT_TTL_MS + 1,
      ),
    ).toBeUndefined();
  });
});
