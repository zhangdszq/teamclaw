import { memo, useEffect, useRef, useState } from "react";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import type { StreamMessage } from "../types";
import MDContent, { ImagePreviewOverlay, normalizeImageSrc } from "../render/markdown";

type MessageContent = SDKAssistantMessage["message"]["content"][number];
type ToolResultContent = SDKUserMessage["message"]["content"][number];
type ToolStatus = "pending" | "success" | "error";
const toolStatusMap = new Map<string, ToolStatus>();
const toolStatusListeners = new Set<() => void>();
const MAX_VISIBLE_LINES = 3;

type AskUserQuestionInput = {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  answers?: Record<string, string>;
};

const setToolStatus = (toolUseId: string | undefined, status: ToolStatus) => {
  if (!toolUseId) return;
  toolStatusMap.set(toolUseId, status);
  toolStatusListeners.forEach((listener) => listener());
};

const useToolStatus = (toolUseId: string | undefined) => {
  const [status, setStatus] = useState<ToolStatus | undefined>(() =>
    toolUseId ? toolStatusMap.get(toolUseId) : undefined
  );
  useEffect(() => {
    if (!toolUseId) return;
    const handleUpdate = () => setStatus(toolStatusMap.get(toolUseId));
    toolStatusListeners.add(handleUpdate);
    return () => { toolStatusListeners.delete(handleUpdate); };
  }, [toolUseId]);
  return status;
};

const StatusDot = ({ variant = "accent", isActive = false, isVisible = true }: {
  variant?: "accent" | "success" | "error"; isActive?: boolean; isVisible?: boolean;
}) => {
  if (!isVisible) return null;
  const colorClass = variant === "success" ? "bg-success" : variant === "error" ? "bg-error" : "bg-accent";
  return (
    <span className="relative flex h-2 w-2">
      {isActive && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${colorClass} opacity-75`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colorClass}`} />
    </span>
  );
};


export function isMarkdown(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const patterns: RegExp[] = [
    /^#{1,6}\s+/m,
    /```[\s\S]*?```/,
    /!\[[^\]]*\]\([^)]+\)/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function extractTagContent(input: string, tag: string): string | null {
  const match = input.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

// Check if error is a macOS permission error
const isPermissionError = (content: string): boolean => {
  const permissionPatterns = [
    /Operation not permitted/i,
    /EPERM/i,
    /Permission denied/i,
    /access denied/i,
  ];
  return permissionPatterns.some(pattern => pattern.test(content));
};

// Check if error is a file size limit error (Claude SDK built-in limit)
const isFileSizeLimitError = (content: string): boolean => {
  return /exceeds maximum allowed size/i.test(content);
};

// Extract file size info from error
const extractFileSizeInfo = (content: string): { actualSize: string; maxSize: string } | null => {
  const match = content.match(/\((\d+(?:\.\d+)?KB)\).*?maximum.*?\((\d+KB)\)/i);
  if (match) {
    return { actualSize: match[1], maxSize: match[2] };
  }
  return null;
};

// Extract path from permission error
const extractPathFromError = (content: string): string | null => {
  // Match patterns like "/Users/will/Downloads" or "ls: /path: Operation not permitted"
  const patterns = [
    /(?:ls|cat|cd|rm|cp|mv|open|read|write):\s*([\/~][^\s:]+)/i,
    /(?:accessing|reading|writing|opening)\s+['"]?([\/~][^\s'"]+)/i,
    /(\/Users\/[^\s:]+)/,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  return null;
};

const ToolResult = ({ messageContent }: { messageContent: ToolResultContent }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [granting, setGranting] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isFirstRender = useRef(true);
  let lines: string[] = [];
  
  // Type guard for tool_result
  if (typeof messageContent === "string" || messageContent.type !== "tool_result") return null;
  
  const toolUseId = messageContent.tool_use_id;
  const status: ToolStatus = messageContent.is_error ? "error" : "success";
  const isError = messageContent.is_error;

  if (messageContent.is_error) {
    lines = [extractTagContent(String(messageContent.content), "tool_use_error") || String(messageContent.content)];
  } else {
    try {
      if (Array.isArray(messageContent.content)) {
        lines = messageContent.content.map((item: any) => item.text || "").join("\n").split("\n");
      } else {
        lines = String(messageContent.content).split("\n");
      }
    } catch { lines = [JSON.stringify(messageContent, null, 2)]; }
  }

  const fullContent = lines.join("\n");
  const hasPermissionError = isPermissionError(fullContent);
  const errorPath = hasPermissionError ? extractPathFromError(fullContent) : null;
  const hasFileSizeLimitError = isFileSizeLimitError(fullContent);
  const fileSizeInfo = hasFileSizeLimitError ? extractFileSizeInfo(fullContent) : null;
  
  const isMarkdownContent = isMarkdown(fullContent);
  const hasMoreLines = lines.length > MAX_VISIBLE_LINES;
  const visibleContent = hasMoreLines && !isExpanded ? lines.slice(0, MAX_VISIBLE_LINES).join("\n") : fullContent;

  useEffect(() => { setToolStatus(toolUseId, status); }, [toolUseId, status]);
  useEffect(() => {
    if (!hasMoreLines || isFirstRender.current) { isFirstRender.current = false; return; }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasMoreLines, isExpanded]);

  const handleGrantAccess = async () => {
    setGranting(true);
    try {
      // First try to request folder access via dialog
      const result = await window.electron.requestFolderAccess(errorPath || undefined);
      if (result.granted) {
        setAccessGranted(true);
      } else {
        // If user cancelled, open system preferences
        await window.electron.openPrivacySettings();
        // Assume user will grant access in system preferences
        setAccessGranted(true);
      }
    } catch (error) {
      console.error("Failed to request access:", error);
      // Fallback to opening system preferences
      await window.electron.openPrivacySettings();
      setAccessGranted(true);
    } finally {
      setGranting(false);
    }
  };

  return (
    <div className="flex flex-col mt-4">
      <div className="text-[13px] font-semibold text-accent">Output</div>
      <div className="mt-2 rounded-xl bg-surface-tertiary p-3">
        <pre className={`text-sm whitespace-pre-wrap break-words font-mono ${isError ? "text-red-500" : "text-ink-700"}`}>
          {isMarkdownContent ? <MDContent text={visibleContent} /> : visibleContent}
        </pre>
        {hasMoreLines && (
          <button onClick={() => setIsExpanded(!isExpanded)} className="mt-2 text-sm text-accent hover:text-accent-hover transition-colors flex items-center gap-1">
            <span>{isExpanded ? "▲" : "▼"}</span>
            <span>{isExpanded ? "Collapse" : `Show ${lines.length - MAX_VISIBLE_LINES} more lines`}</span>
          </button>
        )}
        {/* Permission error - show grant access button or success message */}
        {hasPermissionError && !accessGranted && (
          <div className="mt-3 pt-3 border-t border-ink-900/10">
            <div className="flex items-start gap-2 text-warning text-sm mb-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>macOS 需要授权访问此文件夹{errorPath ? `：${errorPath}` : ""}</span>
            </div>
            <button
              onClick={handleGrantAccess}
              disabled={granting}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {granting ? (
                <span className="flex items-center gap-1.5">
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  授权中...
                </span>
              ) : (
                "授予文件夹访问权限"
              )}
            </button>
          </div>
        )}
        {hasPermissionError && accessGranted && (
          <div className="mt-3 pt-3 border-t border-ink-900/10">
            <div className="flex items-center gap-2 text-success text-sm">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>已授权，请重新执行任务</span>
            </div>
          </div>
        )}
        {/* File size limit error - show info message */}
        {hasFileSizeLimitError && (
          <div className="mt-3 pt-3 border-t border-ink-900/10">
            <div className="flex items-start gap-2 text-info text-sm">
              <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <div>
                <span className="font-medium">文件过大</span>
                {fileSizeInfo && (
                  <span className="text-ink-500 ml-1">
                    ({fileSizeInfo.actualSize}，限制 {fileSizeInfo.maxSize})
                  </span>
                )}
                <p className="text-ink-500 mt-1">
                  Claude SDK 限制单次读取 256KB。AI 会自动使用分段读取或搜索方式处理。
                </p>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

const ThinkingBlock = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink-600 transition-colors py-0.5"
      >
        <svg
          className={`h-2.5 w-2.5 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
        >
          <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        思考过程
      </button>
      {expanded && (
        <div className="ml-4 mt-1 pl-3 border-l-2 border-ink-900/8 text-sm text-ink-500">
          <MDContent text={text} />
        </div>
      )}
    </div>
  );
};

const AssistantBlockCard = ({
  title,
  text,
  showIndicator = false,
  copyable = false,
  onLike,
  liked = false,
}: {
  title: string;
  text: string;
  showIndicator?: boolean;
  copyable?: boolean;
  onLike?: () => void;
  liked?: boolean;
}) => {
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = async () => {
    if (!contentRef.current) return;
    try {
      const htmlContent = contentRef.current.innerHTML;
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([htmlContent], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLike = () => {
    if (liked) return;
    onLike?.();
  };

  return (
    <div className="flex flex-col mt-4">
      <div className="text-[13px] font-semibold text-accent flex items-center gap-2">
        <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
        {title}
      </div>
      <div ref={contentRef}>
        <MDContent text={text} />
      </div>
      {copyable && (
        <div className="mt-2 flex justify-end gap-1">
          {onLike && (
            <button
              onClick={handleLike}
              title={liked ? "已提炼为经验" : "提炼为经验"}
              className={`rounded-lg p-1.5 transition-colors ${
                liked
                  ? "text-accent"
                  : "text-muted hover:text-ink-700 hover:bg-surface-tertiary"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
              </svg>
            </button>
          )}
          <button
            onClick={handleCopy}
            title="复制为富文本"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink-700 hover:bg-surface-tertiary transition-colors"
          >
            {copied ? (
              <>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-success" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                <span>已复制</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>复制</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

const ToolUseCard = ({ messageContent, showIndicator = false }: { messageContent: MessageContent; showIndicator?: boolean }) => {
  if (messageContent.type !== "tool_use") return null;
  
  const toolStatus = useToolStatus(messageContent.id);
  const statusVariant = toolStatus === "error" ? "error" : "success";
  const isPending = !toolStatus || toolStatus === "pending";
  const shouldShowDot = toolStatus === "success" || toolStatus === "error" || showIndicator;

  useEffect(() => {
    if (messageContent?.id && !toolStatusMap.has(messageContent.id)) setToolStatus(messageContent.id, "pending");
  }, [messageContent?.id]);

  const getToolInfo = (): string | null => {
    const input = messageContent.input as Record<string, any>;
    switch (messageContent.name) {
      case "Bash": return input?.command || null;
      case "Read": case "Write": case "Edit": return input?.file_path || null;
      case "Glob": case "Grep": return input?.pattern || null;
      case "Task": return input?.description || null;
      case "WebFetch": return input?.url || null;
      default: return null;
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[1rem] bg-surface-tertiary px-3 py-2 mt-4 overflow-hidden">
      <div className="flex flex-row items-center gap-2 min-w-0">
        <StatusDot variant={statusVariant} isActive={isPending && showIndicator} isVisible={shouldShowDot} />
        <div className="flex flex-row items-center gap-2 tool-use-item min-w-0 flex-1">
          <span className="inline-flex items-center rounded-md text-accent py-0.5 text-sm font-medium shrink-0">{messageContent.name}</span>
          <span className="text-sm text-muted truncate">{getToolInfo()}</span>
        </div>
      </div>
    </div>
  );
};

const AskUserQuestionCard = ({
  messageContent,
  onAnswer
}: {
  messageContent: MessageContent;
  onAnswer?: (answers: Record<string, string>) => void;
}) => {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  
  if (messageContent.type !== "tool_use") return null;
  
  const input = messageContent.input as AskUserQuestionInput | null;
  const questions = input?.questions ?? [];
  
  // Check if all questions are answered
  const isComplete = questions.length > 0 && questions.every((_, idx) => answers[idx]);
  
  // Auto-detect yes/no questions and generate options
  const getOptions = (q: { question: string; options?: Array<{ label: string }> }) => {
    if (q.options && q.options.length > 0) return q.options;
    
    // Detect yes/no questions in Chinese
    if (/是否|要不要|需不需要/.test(q.question)) {
      return [{ label: "是" }, { label: "否" }];
    }
    return null;
  };
  
  const handleSelect = (qIndex: number, label: string) => {
    setAnswers(prev => ({ ...prev, [qIndex]: label }));
  };
  
  const handleSubmit = () => {
    if (!onAnswer || !isComplete) return;
    const result: Record<string, string> = {};
    questions.forEach((q, idx) => {
      result[q.question] = answers[idx] || "";
    });
    onAnswer(result);
  };

  // If answered, just show completed state
  if (input?.answers && Object.keys(input.answers).length > 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[1rem] bg-surface-tertiary px-3 py-2 mt-4">
        <div className="flex flex-row items-center gap-2">
          <StatusDot variant="success" isActive={false} isVisible={true} />
          <span className="inline-flex items-center rounded-md text-accent py-0.5 text-sm font-medium">AskUserQuestion</span>
        </div>
        {questions.map((q, idx) => (
          <div key={idx} className="text-sm text-ink-700 ml-4">
            {q.question}: <span className="font-medium">{input.answers?.[q.question] || ""}</span>
          </div>
        ))}
      </div>
    );
  }

  // Show interactive selection
  return (
    <div className="rounded-2xl border border-accent/20 bg-accent/5 p-4 mt-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-accent mb-3">
        <StatusDot variant="accent" isActive={true} isVisible={true} />
        <span>AskUserQuestion</span>
      </div>
      
      {questions.map((q, qIndex) => {
        const options = getOptions(q);
        const selected = answers[qIndex];
        
        return (
          <div key={qIndex} className={qIndex > 0 ? "mt-4 pt-3 border-t border-accent/10" : ""}>
            <p className="text-sm font-medium text-ink-800 mb-2">{q.question}</p>
            
            {options ? (
              <div className="flex flex-wrap gap-2">
                {options.map((opt, optIdx) => (
                  <button
                    key={optIdx}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      selected === opt.label
                        ? "bg-accent text-white shadow-sm"
                        : "bg-surface border border-ink-900/10 text-ink-700 hover:border-accent/40"
                    }`}
                    onClick={() => handleSelect(qIndex, opt.label)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="text"
                className="w-full rounded-xl border border-ink-900/10 bg-surface px-4 py-2 text-sm"
                placeholder="请输入..."
                value={answers[qIndex] || ""}
                onChange={(e) => handleSelect(qIndex, e.target.value)}
              />
            )}
          </div>
        );
      })}
      
      {onAnswer && (
        <button
          className={`mt-4 px-5 py-2 rounded-full text-sm font-medium text-white transition-all ${
            isComplete ? "bg-accent hover:bg-accent-hover" : "bg-ink-400/40 cursor-not-allowed"
          }`}
          onClick={handleSubmit}
          disabled={!isComplete}
        >
          确认
        </button>
      )}
    </div>
  );
};


const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tiff", "avif"]);
function isImageFile(p: string) {
  return IMAGE_EXTS.has((p.split(".").pop() ?? "").toLowerCase());
}

function getAttachmentName(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

type ParsedAttachment = {
  path: string;
  name: string;
  isImage: boolean;
  isDir: boolean;
};

const UserImageAttachmentCard = ({ attachment }: { attachment: ParsedAttachment }) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electron.getImageThumbnail(attachment.path)
      .then((dataUrl) => {
        if (!cancelled && dataUrl) setPreview(dataUrl);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [attachment.path]);

  const fullSrc = normalizeImageSrc(attachment.path);

  return (
    <div className="group relative flex-shrink-0">
      <div
        className="h-[72px] w-[72px] cursor-zoom-in overflow-hidden rounded-2xl border border-ink-900/10 bg-surface-secondary shadow-[0_8px_24px_rgba(15,23,42,0.06)]"
        onClick={() => fullSrc && setPreviewOpen(true)}
      >
        {preview ? (
          <img
            src={preview}
            alt={attachment.name}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <svg className="h-6 w-6 animate-pulse text-ink-300" viewBox="0 0 24 24" fill="none">
              <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 rounded-lg bg-black/48 px-2 py-1 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
        <div className="truncate">{attachment.name}</div>
      </div>
      {previewOpen && fullSrc && (
        <ImagePreviewOverlay src={fullSrc} alt={attachment.name} onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  );
};

function parseUserPrompt(raw: string): { attachments: ParsedAttachment[]; text: string } {
  const lines = raw.split("\n");
  const attachments: ParsedAttachment[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const imgMatch = line.match(/^请分析这张图片: (.+)$/);
    const fileMatch = line.match(/^请读取并分析这个文件: (.+)$/);
    const dirMatch = line.match(/^请列出并分析这个文件夹: (.+)$/);
    if (imgMatch) {
      const path = imgMatch[1].trim();
      attachments.push({ path, name: getAttachmentName(path), isImage: true, isDir: false });
    } else if (fileMatch) {
      const path = fileMatch[1].trim();
      attachments.push({ path, name: getAttachmentName(path), isImage: isImageFile(path), isDir: false });
    } else if (dirMatch) {
      const path = dirMatch[1].trim();
      attachments.push({ path, name: getAttachmentName(path), isImage: false, isDir: true });
    } else {
      textLines.push(line);
    }
  }
  return { attachments, text: textLines.join("\n").trim() };
}

const UserMessageCard = ({ message, showIndicator = false, userName = "User" }: { message: { type: "user_prompt"; prompt: string }; showIndicator?: boolean; userName?: string }) => {
  // Strip hidden plan execution instructions injected by the system
  const visiblePrompt = message.prompt
    .replace(/\n---\n【计划项执行规范[\s\S]*$/m, "")
    .trimEnd();
  const { attachments, text } = parseUserPrompt(visiblePrompt);
  return (
    <div className="flex flex-col mt-4">
      <div className="text-[13px] font-semibold text-accent flex items-center gap-2">
        <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
        {userName}
      </div>
      {attachments.length > 0 && (
        <div className="mt-2 mb-1 flex flex-wrap gap-2">
          {attachments.map((att) => (
            att.isImage ? (
              <UserImageAttachmentCard key={att.path} attachment={att} />
            ) : (
              <div key={att.path} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-900/10 bg-surface-secondary px-2.5 py-1 text-xs text-ink-600">
                {att.isDir ? (
                  <svg className="h-3.5 w-3.5 text-yellow-600 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
                <span className="max-w-[240px] truncate">{att.name}</span>
              </div>
            )
          ))}
        </div>
      )}
      {text && <MDContent text={text} />}
    </div>
  );
};

export const MessageCard = memo(function MessageCard({
  message,
  isLast = false,
  isRunning = false,
  onAskUserQuestionAnswer,
  onLikeMessage,
  likeScopeId = "",
  likedMessageKeys,
  assistantName,
  userName,
  excludeToolUseIds,
}: {
  message: StreamMessage;
  isLast?: boolean;
  isRunning?: boolean;
  showSystemInfo?: boolean;
  onAskUserQuestionAnswer?: (toolUseId: string, answers: Record<string, string>) => void;
  onLikeMessage?: (likeKey: string, text: string) => void;
  likeScopeId?: string;
  likedMessageKeys?: Set<string>;
  assistantName?: string;
  userName?: string;
  excludeToolUseIds?: Set<string>;
}) {
  const showIndicator = isLast && isRunning;

  if (message.type === "user_prompt") {
    return <UserMessageCard message={message} showIndicator={showIndicator} userName={userName} />;
  }

  const sdkMessage = message as SDKMessage;

  // Always hide system init and successful session result
  if (sdkMessage.type === "system") {
    return null;
  }

  if (sdkMessage.type === "result") {
    if (sdkMessage.subtype === "success") {
      return null;
    }
    // Always show errors
    return (
      <div className="flex flex-col gap-2 mt-4">
        <div className="header text-error">Session Error</div>
        <div className="rounded-xl bg-error-light p-3">
          <pre className="text-sm text-error whitespace-pre-wrap">{JSON.stringify(sdkMessage, null, 2)}</pre>
        </div>
      </div>
    );
  }

  if (sdkMessage.type === "assistant") {
    const contents = sdkMessage.message.content;
    const fallbackFingerprint = contents
      .map((c) => {
        if (c.type === "text") return `t:${c.text.slice(0, 80)}`;
        if (c.type === "thinking") return `k:${c.thinking.slice(0, 40)}`;
        if (c.type === "tool_use") return `u:${c.id}`;
        return c.type;
      })
      .join("|");
    const messageId =
      "uuid" in message && message.uuid
        ? String(message.uuid)
        : `assistant-${fallbackFingerprint}`;
    
    return (
      <>
        {contents.map((content: MessageContent, idx: number) => {
          const isLastContent = idx === contents.length - 1;
          if (content.type === "thinking") {
            return <ThinkingBlock key={idx} text={content.thinking} />;
          }
          if (content.type === "text") {
            const likeKey = `${likeScopeId}:${messageId}:${idx}`;
            return (
              <AssistantBlockCard
                key={idx}
                title={assistantName || "Assistant"}
                text={content.text}
                showIndicator={isLastContent && showIndicator}
                copyable
                onLike={onLikeMessage ? () => onLikeMessage(likeKey, content.text) : undefined}
                liked={likedMessageKeys?.has(likeKey) ?? false}
              />
            );
          }
          if (content.type === "tool_use") {
            // Skip tool uses that are rendered outside the collapsed section
            if (excludeToolUseIds?.has(content.id)) return null;
            if (content.name === "AskUserQuestion") {
              return (
                <AskUserQuestionCard 
                  key={idx} 
                  messageContent={content}
                  onAnswer={onAskUserQuestionAnswer ? (answers) => onAskUserQuestionAnswer(content.id, answers) : undefined}
                />
              );
            }
            return <ToolUseCard key={idx} messageContent={content} showIndicator={isLastContent && showIndicator} />;
          }
          return null;
        })}
      </>
    );
  }

  if (sdkMessage.type === "user") {
    const contents = sdkMessage.message.content;
    // Handle string content
    if (typeof contents === "string") {
      return null;
    }
    return (
      <>
        {contents.map((content: ToolResultContent, idx: number) => {
          if (typeof content !== "string" && content.type === "tool_result") {
            return <ToolResult key={idx} messageContent={content} />;
          }
          return null;
        })}
      </>
    );
  }

  return null;
});

export { MessageCard as EventCard };

// ─── Process Group ────────────────────────────────────────────────────────────
// Collapses consecutive tool-call / tool-result messages into one clickable row.

export function ProcessGroup({
  messages,
  isLast = false,
  isRunning = false,
  showSystemInfo,
  onAskUserQuestionAnswer,
  onLikeMessage,
  likeScopeId = "",
  likedMessageKeys,
  assistantName,
  userName,
}: {
  messages: StreamMessage[];
  isLast?: boolean;
  isRunning?: boolean;
  showSystemInfo: boolean;
  onAskUserQuestionAnswer?: (toolUseId: string, answers: Record<string, string>) => void;
  onLikeMessage?: (likeKey: string, text: string) => void;
  likeScopeId?: string;
  likedMessageKeys?: Set<string>;
  assistantName?: string;
  userName?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // Collect tool call names/count for the summary line
  const toolNames: string[] = [];
  for (const msg of messages) {
    const m = msg as any;
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c.type === "tool_use") toolNames.push(c.name as string);
      }
    }
  }

  // Extract unanswered AskUserQuestion tool uses to render outside the collapsed section
  const activeAskQuestions: { content: MessageContent; toolUseId: string }[] = [];
  for (const msg of messages) {
    const m = msg as any;
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c.type === "tool_use" && c.name === "AskUserQuestion") {
          const input = c.input as AskUserQuestionInput | null;
          if (!input?.answers || Object.keys(input.answers).length === 0) {
            activeAskQuestions.push({ content: c as MessageContent, toolUseId: c.id });
          }
        }
      }
    }
  }
  const activeAskIds = new Set(activeAskQuestions.map((q) => q.toolUseId));

  const unique = [...new Set(toolNames)];
  const count = toolNames.length;
  const summaryText =
    count === 0
      ? "思考中…"
      : `${unique.slice(0, 3).join(" · ")}${unique.length > 3 ? ` 等` : ""}  ·  共 ${count} 步`;

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-lg text-xs hover:bg-surface-secondary/70 transition-colors group"
      >
        {/* Chevron */}
        <svg
          className={`h-3 w-3 text-ink-400 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
        >
          <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {/* Summary */}
        {isRunning && isLast ? (
          <span className="flex items-center gap-1.5 text-accent">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            处理中…
          </span>
        ) : (
          <span className="text-ink-400 font-mono">{summaryText}</span>
        )}

        {/* Toggle hint */}
        <span className="ml-auto text-ink-300 opacity-0 group-hover:opacity-100 transition-opacity text-[11px]">
          {expanded ? "收起" : "展开"}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="ml-4 mt-1 pl-3 border-l-2 border-ink-900/8">
          {messages.map((msg, idx) => {
            const msgKey = ("uuid" in msg && msg.uuid) ? String(msg.uuid) : `proc-${idx}`;
            return (
              <MessageCard
                key={msgKey}
                message={msg}
                isLast={isLast && idx === messages.length - 1}
                isRunning={isRunning}
                showSystemInfo={showSystemInfo}
                onAskUserQuestionAnswer={onAskUserQuestionAnswer}
                onLikeMessage={onLikeMessage}
                likeScopeId={likeScopeId}
                likedMessageKeys={likedMessageKeys}
                assistantName={assistantName}
                userName={userName}
                excludeToolUseIds={activeAskIds}
              />
            );
          })}
        </div>
      )}

      {/* Active AskUserQuestion cards always visible outside the collapsed section */}
      {activeAskQuestions.map(({ content, toolUseId }) => (
        <AskUserQuestionCard
          key={toolUseId}
          messageContent={content}
          onAnswer={onAskUserQuestionAnswer ? (answers) => onAskUserQuestionAnswer(toolUseId, answers) : undefined}
        />
      ))}
    </div>
  );
}
