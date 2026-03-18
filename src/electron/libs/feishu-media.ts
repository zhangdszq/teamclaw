import { Readable } from "stream";

export type RecentFeishuAttachment = {
  kind: "file" | "video";
  fileName: string;
  filePath?: string;
  sourceMessageId: string;
  receivedAt: number;
};

export type FeishuPostAttachment = {
  kind: "file" | "media";
  fileKey: string;
  fileName?: string;
};

type FeishuPostNode = {
  tag?: string;
  text?: string;
  image_key?: string;
  href?: { url?: { link?: string } };
  file_key?: string;
  file_name?: string;
  name?: string;
  video_key?: string;
};

export const FEISHU_ATTACHMENT_CONTEXT_TTL_MS = 15 * 60 * 1000;

const RECENT_ATTACHMENT_FOLLOW_UP_RE =
  /发了|刚发|刚才发|这个|那个|上面|上一条|上一个|这段|这份|附件|视频|文件|图片|录音|语音/i;

async function readableToBuffer(readable: Readable): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (chunk: Buffer | string | Uint8Array) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
        return;
      }
      chunks.push(Buffer.from(String(chunk)));
    });
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

function isReadableLike(value: unknown): value is Readable {
  return Boolean(value) && typeof value === "object" && typeof (value as Readable).on === "function";
}

export async function bufferFromFeishuDownloadResponse(response: unknown): Promise<Buffer | null> {
  if (!response) return null;
  if (Buffer.isBuffer(response)) return response;
  if (response instanceof ArrayBuffer) return Buffer.from(response);
  if (ArrayBuffer.isView(response)) {
    return Buffer.from(response.buffer, response.byteOffset, response.byteLength);
  }
  if (isReadableLike(response)) return await readableToBuffer(response);

  if (typeof response === "object") {
    const candidate = response as {
      getReadableStream?: () => Readable;
      data?: unknown;
      body?: unknown;
      file?: unknown;
    };
    if (typeof candidate.getReadableStream === "function") {
      return await readableToBuffer(candidate.getReadableStream());
    }
    const nestedKeys: Array<keyof typeof candidate> = ["data", "body", "file"];
    for (const key of nestedKeys) {
      const nested = await bufferFromFeishuDownloadResponse(candidate[key]);
      if (nested) return nested;
    }
  }

  return null;
}

export function parseFeishuPostContent(content: unknown): {
  text: string;
  imageKeys: string[];
  attachments: FeishuPostAttachment[];
} {
  const parts: string[] = [];
  const imageKeys: string[] = [];
  const attachments: FeishuPostAttachment[] = [];
  const postContent = content as { content?: Array<Array<FeishuPostNode>> };

  for (const line of postContent.content ?? []) {
    for (const node of line) {
      if (node.tag === "text" && node.text) {
        parts.push(node.text.replace(/@[^\s]+\s*/g, "").trim());
        continue;
      }
      if (node.tag === "a" && node.href?.url?.link) {
        parts.push(`[链接: ${node.href.url.link}]`);
        continue;
      }
      if (node.tag === "img" && node.image_key) {
        imageKeys.push(node.image_key);
        continue;
      }
      if ((node.tag === "media" || node.tag === "file") && (node.file_key || node.video_key)) {
        attachments.push({
          kind: node.tag === "file" ? "file" : "media",
          fileKey: String(node.file_key ?? node.video_key),
          fileName: node.file_name ?? node.name,
        });
      }
    }
  }

  return {
    text: parts.join("").trim() || "[富文本消息]",
    imageKeys,
    attachments,
  };
}

export function buildRecentFeishuAttachmentContext(
  attachment: RecentFeishuAttachment | undefined,
  userText: string,
  nowMs = Date.now(),
): string | undefined {
  if (!attachment) return undefined;
  if (nowMs - attachment.receivedAt > FEISHU_ATTACHMENT_CONTEXT_TTL_MS) return undefined;

  const normalizedText = userText.trim();
  if (!normalizedText || !RECENT_ATTACHMENT_FOLLOW_UP_RE.test(normalizedText)) return undefined;

  const kindLabel = attachment.kind === "video" ? "视频" : "文件";
  const lines = [
    "## 当前对话最近收到的附件",
    "- 这不是历史旧文件，而是当前对话里刚收到的新附件。",
    `- 类型：${kindLabel}`,
    `- 文件名：${attachment.fileName}`,
  ];
  if (attachment.filePath) {
    lines.push(`- 文件路径：${attachment.filePath}`);
  }
  lines.push("- 如果用户本轮提到“发了/刚发的/这个视频/这个文件/上面那个附件”，默认优先指这个附件。");
  return lines.join("\n");
}
