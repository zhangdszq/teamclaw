/**
 * Codex SDK runner — translates Codex ThreadEvents into the existing
 * ServerEvent / SDKMessage format so the UI can render them unchanged.
 */
import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type CodexOptions,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { ServerEvent } from "../types.js";
import type { Session } from "./session-store.js";
import { buildSmartMemoryContext } from "./memory-store.js";
import { IMAGE_INLINE_RULE } from "./bot-base.js";
import { app } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

export type CodexRunnerOptions = {
  prompt: string;
  session: Session;
  model?: string;
  onEvent: (event: ServerEvent) => void;
  onSessionUpdate?: (updates: Partial<Session>) => void;
};

export type RunnerHandle = {
  abort: () => void;
};

const DEFAULT_CWD = homedir();

// ─── Codex binary resolution ─────────────────────────────────

export function getCodexBinaryPath(): string | undefined {
  if (app.isPackaged) {
    // In packaged app, the vendor directory is asar-unpacked
    const platform = process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const vendorPath = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@openai",
      "codex-sdk",
      "vendor",
      `${arch}-${platform}`,
      "codex",
      "codex"
    );
    if (existsSync(vendorPath)) {
      return vendorPath;
    }
  }
  return undefined;
}

// ─── UUID helper ─────────────────────────────────────────────

let counter = 0;
function syntheticUuid(): string {
  return `codex-${Date.now()}-${++counter}`;
}

// ─── Output post-processing ──────────────────────────────────

const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?|svg)$/i;

/**
 * Convert backtick-quoted absolute image paths in Codex output to Markdown
 * image syntax so the renderer can display them inline.
 *
 * e.g.  `/tmp/shot.png`  →  ![](/tmp/shot.png)
 *       `C:\Users\foo\shot.jpg`  →  ![](C:/Users/foo/shot.jpg)
 *
 * Only affects paths with recognised image extensions; other backtick paths
 * (directories, scripts, etc.) are left unchanged to avoid false positives.
 */
function inlineCodeImagesToMarkdown(text: string): string {
  return text.replace(/`((?:\/|[A-Za-z]:[/\\])[^`\n]+)`/g, (match, rawPath) => {
    const path = rawPath.trim();
    if (!IMG_EXT_RE.test(path)) return match;
    const urlPath = path.replace(/\\/g, "/");
    return `![](${urlPath})`;
  });
}

// ─── SDKMessage construction helpers ─────────────────────────
// We build plain objects that match the shapes the UI already renders.

function makeSystemInit(
  sessionId: string,
  model: string,
  cwd: string,
  threadId?: string
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: threadId ?? sessionId,
    model,
    cwd,
    permissionMode: "dangerFullAccess",
    uuid: syntheticUuid(),
  };
}

function makeAssistantText(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: syntheticUuid(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: inlineCodeImagesToMarkdown(text) }],
    },
  };
}

function makeAssistantThinking(thinking: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: syntheticUuid(),
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  };
}

function makeAssistantToolUse(
  id: string,
  name: string,
  input: unknown
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: syntheticUuid(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function makeToolResult(
  toolUseId: string,
  content: string,
  isError = false
): Record<string, unknown> {
  return {
    type: "user",
    uuid: syntheticUuid(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  };
}

function makeResult(
  success: boolean,
  usage?: { input_tokens: number; output_tokens: number }
): Record<string, unknown> {
  return {
    type: "result",
    subtype: success ? "success" : "error",
    uuid: syntheticUuid(),
    duration_ms: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── Event mapping ───────────────────────────────────────────

function mapItemToMessages(
  item: ThreadItem,
  phase: "started" | "updated" | "completed"
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  switch (item.type) {
    case "agent_message": {
      if (item.text) {
        messages.push(makeAssistantText(item.text));
      }
      break;
    }

    case "reasoning": {
      if (item.text) {
        messages.push(makeAssistantThinking(item.text));
      }
      break;
    }

    case "command_execution": {
      if (phase === "started") {
        messages.push(
          makeAssistantToolUse(item.id, "Bash", { command: item.command })
        );
      }
      if (phase === "completed" || phase === "updated") {
        const exitInfo =
          item.exit_code !== undefined ? `[exit ${item.exit_code}] ` : "";
        const output = `${exitInfo}${item.aggregated_output ?? ""}`;
        messages.push(
          makeToolResult(item.id, output, item.status === "failed")
        );
      }
      break;
    }

    case "file_change": {
      if (phase === "started") {
        const summary = item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join("\n");
        messages.push(
          makeAssistantToolUse(item.id, "Edit", {
            description: summary,
            changes: item.changes,
          })
        );
      }
      if (phase === "completed") {
        const summary = item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join("\n");
        messages.push(
          makeToolResult(item.id, summary, item.status === "failed")
        );
      }
      break;
    }

    case "mcp_tool_call": {
      if (phase === "started") {
        messages.push(
          makeAssistantToolUse(item.id, `MCP:${item.server}/${item.tool}`, item.arguments)
        );
      }
      if (phase === "completed") {
        const content = item.error
          ? item.error.message
          : JSON.stringify(item.result ?? {});
        messages.push(
          makeToolResult(item.id, content, item.status === "failed")
        );
      }
      break;
    }

    case "web_search": {
      if (phase === "started") {
        messages.push(
          makeAssistantToolUse(item.id, "WebSearch", { query: item.query })
        );
      }
      if (phase === "completed") {
        messages.push(makeToolResult(item.id, `Search: ${item.query}`));
      }
      break;
    }

    case "todo_list": {
      const text = item.items
        .map((t) => `${t.completed ? "✓" : "○"} ${t.text}`)
        .join("\n");
      messages.push(makeAssistantText(`**Todo List**\n${text}`));
      break;
    }

    case "error": {
      messages.push(makeAssistantText(`**Error:** ${item.message}`));
      break;
    }
  }

  return messages;
}

// ─── Public runner ───────────────────────────────────────────

export async function runCodex(
  options: CodexRunnerOptions
): Promise<RunnerHandle> {
  const { prompt, session, model, onEvent, onSessionUpdate } = options;
  const abortController = new AbortController();

  // Inject smart memory context for new sessions (scoped to assistant)
  let effectivePrompt = prompt;
  if (!session.claudeSessionId) {
    try {
      const memoryCtx = buildSmartMemoryContext(prompt, session.assistantId, session.cwd);
      if (memoryCtx) {
        effectivePrompt = memoryCtx + "\n\n" + prompt;
        console.log("[CodexRunner/fallback] Memory context injected, length:", memoryCtx.length);
      }
    } catch (err) {
      console.warn("[CodexRunner/fallback] Failed to load memory context:", err);
    }
  }

  const sendMessage = (message: Record<string, unknown>) => {
    onEvent({
      type: "stream.message",
      payload: { sessionId: session.id, message: message as any },
    });
  };

  // Start query in the background
  (async () => {
    try {
      const codexPath = getCodexBinaryPath();
      const codexOpts: CodexOptions = {};
      if (codexPath) {
        codexOpts.codexPathOverride = codexPath;
      }

      const codex = new Codex(codexOpts);

      const threadOpts: ThreadOptions = {
        model: model ?? "gpt-5.3-codex",
        workingDirectory: session.cwd ?? DEFAULT_CWD,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      };

      const thread = session.claudeSessionId
        ? codex.resumeThread(session.claudeSessionId, threadOpts)
        : codex.startThread(threadOpts);

      // Append image-inline rule as a suffix so the model treats it as an active
      // instruction for this turn (suffix placement is more salient than prefix for Codex).
      const promptWithRule = `${effectivePrompt}\n\n${IMAGE_INLINE_RULE}`;
      const { events } = await thread.runStreamed(promptWithRule, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        handleThreadEvent(event, session, sendMessage, onSessionUpdate);
      }

      // Turn completed normally
      if (session.status === "running") {
        onEvent({
          type: "session.status",
          payload: {
            sessionId: session.id,
            status: "completed",
            title: session.title,
          },
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      console.error("[codex-runner] Error:", error);
      onEvent({
        type: "session.status",
        payload: {
          sessionId: session.id,
          status: "error",
          title: session.title,
          error: String(error),
        },
      });
    }
  })();

  return {
    abort: () => abortController.abort(),
  };
}

function handleThreadEvent(
  event: ThreadEvent,
  session: Session,
  sendMessage: (msg: Record<string, unknown>) => void,
  onSessionUpdate?: (updates: Partial<Session>) => void
): void {
  switch (event.type) {
    case "thread.started": {
      // Store thread ID for potential resume
      session.claudeSessionId = event.thread_id;
      onSessionUpdate?.({ claudeSessionId: event.thread_id });

      sendMessage(
        makeSystemInit(
          session.id,
          "codex",
          session.cwd ?? DEFAULT_CWD,
          event.thread_id
        )
      );
      break;
    }

    case "turn.started":
      // No direct mapping needed; session is already "running"
      break;

    case "turn.completed": {
      sendMessage(
        makeResult(true, {
          input_tokens: event.usage.input_tokens,
          output_tokens: event.usage.output_tokens,
        })
      );
      break;
    }

    case "turn.failed": {
      sendMessage(
        makeAssistantText(`**Error:** ${event.error.message}`)
      );
      sendMessage(makeResult(false));
      break;
    }

    case "item.started": {
      const msgs = mapItemToMessages(event.item, "started");
      msgs.forEach(sendMessage);
      break;
    }

    case "item.updated": {
      const msgs = mapItemToMessages(event.item, "updated");
      msgs.forEach(sendMessage);
      break;
    }

    case "item.completed": {
      const msgs = mapItemToMessages(event.item, "completed");
      msgs.forEach(sendMessage);
      break;
    }

    case "error": {
      sendMessage(makeAssistantText(`**Stream Error:** ${event.message}`));
      break;
    }
  }
}
