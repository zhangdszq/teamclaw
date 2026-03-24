import type { StreamMessage } from "../types";

export type FolderAccessRequestInput = {
  path: string | null;
  errorMessage: string;
};

export type FolderAccessRequest = {
  toolUseId: string;
  toolName: "FolderAccess";
  input: FolderAccessRequestInput;
};

function extractTagContent(input: string, tag: string): string | null {
  const match = input.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

export const isPermissionError = (content: string): boolean => {
  const permissionPatterns = [
    /Operation not permitted/i,
    /EPERM/i,
    /Permission denied/i,
    /access denied/i,
  ];
  return permissionPatterns.some((pattern) => pattern.test(content));
};

export const extractPathFromError = (content: string): string | null => {
  const patterns = [
    /(?:ls|cat|cd|rm|cp|mv|open|read|write):\s*([/~][^\s:]+)/i,
    /(?:accessing|reading|writing|opening)\s+['"]?([/~][^\s'"]+)/i,
    /(\/Users\/[^\s:]+)/,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  return null;
};

function extractToolResultText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "object" && item && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  const raw = String(content ?? "");
  return extractTagContent(raw, "tool_use_error") || raw;
}

export function getFolderAccessRequestsFromMessages(messages: StreamMessage[]): FolderAccessRequest[] {
  let lastUserPromptIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { type?: string }).type === "user_prompt") {
      lastUserPromptIndex = i;
      break;
    }
  }

  const requests: FolderAccessRequest[] = [];
  const seenToolUseIds = new Set<string>();

  for (let i = lastUserPromptIndex + 1; i < messages.length; i++) {
    const message = messages[i] as {
      type?: string;
      message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
    };

    if (message.type !== "user" || !Array.isArray(message.message?.content)) continue;

    for (const item of message.message.content) {
      if (item?.type !== "tool_result" || !item.is_error) continue;

      const errorMessage = extractToolResultText(item.content);
      if (!isPermissionError(errorMessage)) continue;

      const sourceToolUseId = item.tool_use_id || `permission-error-${i}`;
      const toolUseId = `folder-access:${sourceToolUseId}`;
      if (seenToolUseIds.has(toolUseId)) continue;
      seenToolUseIds.add(toolUseId);

      requests.push({
        toolUseId,
        toolName: "FolderAccess",
        input: {
          path: extractPathFromError(errorMessage),
          errorMessage,
        },
      });
    }
  }

  return requests;
}
