import { memo, useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";

// ─── Toast (singleton pub/sub — ToastHost must be mounted once at app root) ───

type ToastState = { id: number; message: string; type: "ok" | "err" };
let toastCounter = 0;
type ToastListener = (t: ToastState) => void;
const toastListeners = new Set<ToastListener>();

export function emitToast(message: string, type: ToastState["type"] = "ok") {
  const t: ToastState = { id: ++toastCounter, message, type };
  toastListeners.forEach((fn) => fn(t));
}

/** Mount exactly once at the app root — renders toasts via portal. */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const handler: ToastListener = (t) => {
      setToasts((prev) => [...prev, t]);
      const tid = setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
        timers.current.delete(t.id);
      }, 2400);
      timers.current.set(t.id, tid);
    };
    toastListeners.add(handler);
    return () => {
      toastListeners.delete(handler);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  if (!toasts.length) return null;

  return createPortal(
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[2147483647] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2 rounded-xl bg-black/70 px-4 py-2.5 text-sm text-white shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          {t.type === "ok" ? (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2.5 8.5 6 12 13.5 4" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#f87171" strokeWidth="2.2" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          )}
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}

function normalizeImageSrc(src?: string): string | undefined {
  if (!src) return src;
  if (/^(https?:\/\/|data:|localfile:\/\/|file:\/\/)/i.test(src)) return src;
  // macOS / Linux absolute path → localfile:// (custom Electron protocol that bypasses
  // Chromium's cross-origin block when the page is served from http://localhost).
  if (src.startsWith("/")) return `localfile://${src}`;
  // Windows absolute path: C:\path\image.png or C:/path/image.png → localfile:///C:/path/image.png
  if (/^[A-Za-z]:[/\\]/.test(src)) return `localfile:///${src.replace(/\\/g, "/")}`;
  return src;
}

const IMAGE_DEST_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tiff|avif)(?:[?#][^)\s>]*)?$/i;

function isLocalLikeImageDestination(dest: string): boolean {
  return /^(\/|[A-Za-z]:[/\\]|file:\/\/|localfile:\/\/)/.test(dest) && IMAGE_DEST_RE.test(dest);
}

function normalizeMarkdownText(text: string): string {
  if (!text) return "";
  return text.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (full, alt: string, rawDest: string) => {
    const dest = String(rawDest).trim();
    if (!dest || (dest.startsWith("<") && dest.endsWith(">"))) return full;
    const unquoted = dest.replace(/^['"]|['"]$/g, "");
    if (!isLocalLikeImageDestination(unquoted) || !/\s/.test(unquoted)) return full;
    return `![${alt}](<${unquoted}>)`;
  });
}

function hasRenderableImageMarkdown(text: string): boolean {
  return /!\[[^\]]*\]\((?:<)?(?:\/|[A-Za-z]:[/\\]|file:\/\/|localfile:\/\/|https?:\/\/|data:)[^)>\n]+(?:>)?\)/i.test(text);
}

function resolveLocalImagePath(src: string): string | null {
  if (/^[A-Za-z]:[/\\]/.test(src) || src.startsWith("/")) return src;
  if (src.startsWith("localfile://")) {
    const url = new URL(src);
    let localPath = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
    localPath = decodeURIComponent(localPath);
    if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1);
    return localPath;
  }
  if (src.startsWith("file://")) {
    const url = new URL(src);
    let localPath = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1);
    return localPath;
  }
  return null;
}

async function copyImageFromSrc(src: string) {
  const localPath = resolveLocalImagePath(src);
  if (localPath) {
    const result = await window.electron.copyImageToClipboard(localPath);
    if (!result.ok) throw new Error(result.reason || "copy_failed");
    return;
  }
  const resp = await fetch(src);
  const blob = await resp.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

async function downloadImageFromSrc(src: string) {
  if (/^(https?:\/\/|data:)/i.test(src)) {
    const name = src.split("/").pop()?.split("?")[0] || "image";
    const a = document.createElement("a");
    a.href = src;
    a.download = name;
    a.click();
    emitToast(`已开始下载：${name}`);
    return;
  }

  const localPath = resolveLocalImagePath(src);
  if (!localPath) {
    emitToast("保存失败：无法解析本地图片路径", "err");
    return;
  }

  const result = await window.electron.saveImage(localPath);
  if (result.ok) {
    const name = result.savedTo?.split(/[/\\]/).pop() ?? "图片";
    emitToast(`下载成功：${name}`);
  } else if (result.reason && result.reason !== "canceled") {
    emitToast(`保存失败：${result.reason}`, "err");
  }
}

function ImageActionButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-white/85 shadow-lg backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white"
    >
      {children}
    </button>
  );
}

// ─── Inline image with hover toolbar ────────────────────────────────────────

function InlineImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [hovered, setHovered] = useState(false);
  const [copyTip, setCopyTip] = useState<"idle" | "ok" | "err">("idle");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [previewControlsVisible, setPreviewControlsVisible] = useState(false);
  const [previewDragging, setPreviewDragging] = useState(false);
  const previewControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const previewDragStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const clearPreviewControlsTimer = useCallback(() => {
    if (previewControlsTimerRef.current) {
      clearTimeout(previewControlsTimerRef.current);
      previewControlsTimerRef.current = null;
    }
  }, []);

  const revealPreviewControls = useCallback(() => {
    setPreviewControlsVisible(true);
    clearPreviewControlsTimer();
    previewControlsTimerRef.current = setTimeout(() => {
      setPreviewControlsVisible(false);
      previewControlsTimerRef.current = null;
    }, 1400);
  }, [clearPreviewControlsTimer]);

  const clampPreviewOffset = useCallback((next: { x: number; y: number }, scale: number = previewScale) => {
    const viewport = previewViewportRef.current;
    const image = previewImageRef.current;
    if (!viewport || !image || scale <= 1) return { x: 0, y: 0 };
    const maxX = Math.max(0, (image.offsetWidth * scale - viewport.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * scale - viewport.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, [previewScale]);

  const stopPreviewDrag = useCallback(() => {
    previewDragStartRef.current = null;
    setPreviewDragging(false);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await copyImageFromSrc(src);
      setCopyTip("ok");
      emitToast("复制成功");
      setTimeout(() => setCopyTip("idle"), 1800);
    } catch {
      setCopyTip("err");
      emitToast("复制失败", "err");
      setTimeout(() => setCopyTip("idle"), 1800);
    }
  }, [src]);

  const handleDownload = useCallback(async () => {
    await downloadImageFromSrc(src);
  }, [src]);

  useEffect(() => {
    if (!previewOpen) {
      setPreviewScale(1);
      setPreviewOffset({ x: 0, y: 0 });
      setPreviewControlsVisible(false);
      stopPreviewDrag();
      clearPreviewControlsTimer();
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreviewOpen(false);
      }
    };
    document.body.style.overflow = "hidden";
    setPreviewScale(1);
    setPreviewOffset({ x: 0, y: 0 });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      stopPreviewDrag();
      clearPreviewControlsTimer();
    };
  }, [previewOpen, clearPreviewControlsTimer, stopPreviewDrag]);

  useEffect(() => {
    if (!previewOpen) return;
    setPreviewOffset((prev) => clampPreviewOffset(prev, previewScale));
  }, [previewOpen, previewScale, clampPreviewOffset]);

  useEffect(() => {
    if (!previewDragging) return;
    const handleMouseUp = () => stopPreviewDrag();
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [previewDragging, stopPreviewDrag]);

  const handlePreviewWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY < 0 ? 0.16 : -0.16;
    setPreviewScale((prev) => Math.min(4, Math.max(1, Number((prev + delta).toFixed(2)))));
    revealPreviewControls();
  }, [revealPreviewControls]);

  const handlePreviewMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || previewScale <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    previewDragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: previewOffset.x,
      offsetY: previewOffset.y,
    };
    setPreviewDragging(true);
    revealPreviewControls();
  }, [previewScale, previewOffset.x, previewOffset.y, revealPreviewControls]);

  const handlePreviewMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    revealPreviewControls();
    const drag = previewDragStartRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const next = {
      x: drag.offsetX + (event.clientX - drag.x),
      y: drag.offsetY + (event.clientY - drag.y),
    };
    setPreviewOffset(clampPreviewOffset(next, previewScale));
  }, [clampPreviewOffset, previewScale, revealPreviewControls]);

  return (
    <>
      <span
        className="relative mt-3 inline-block max-w-[50%] align-top"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <img
          src={src}
          alt={alt || "image"}
          loading="lazy"
          onClick={() => setPreviewOpen(true)}
          className={`block h-auto max-w-full cursor-zoom-in rounded-xl border border-ink-900/10 ${className ?? ""}`.trim()}
        />

        {/* Hover toolbar */}
        <span
          className={`absolute right-2 top-2 flex gap-1 rounded-lg bg-black/50 px-1 py-1 backdrop-blur-sm transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          aria-hidden={!hovered}
        >
          <button
            type="button"
            title={copyTip === "ok" ? "已复制" : copyTip === "err" ? "复制失败" : "复制图片"}
            onClick={(event) => {
              event.stopPropagation();
              void handleCopy();
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/20 hover:text-white"
          >
            {copyTip === "ok" ? (
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 8 6.5 12 13 4" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="8" height="8" rx="1.5" />
                <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" />
              </svg>
            )}
          </button>

          <button
            type="button"
            title="下载图片"
            onClick={(event) => {
              event.stopPropagation();
              void handleDownload();
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/20 hover:text-white"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2v8M5 7l3 3 3-3" />
              <path d="M2 12h12" />
            </svg>
          </button>
        </span>
      </span>

      {previewOpen && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/78 p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={alt || "图片预览"}
          onClick={() => setPreviewOpen(false)}
          onMouseMove={handlePreviewMouseMove}
          onMouseLeave={() => {
            stopPreviewDrag();
            clearPreviewControlsTimer();
            setPreviewControlsVisible(false);
          }}
          onMouseUp={stopPreviewDrag}
          onWheel={handlePreviewWheel}
        >
          <div
            className={`absolute right-4 top-4 flex items-center gap-2 transition-opacity duration-200 ${previewControlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
          >
            <ImageActionButton
              title="复制图片"
              onClick={(event) => {
                event.stopPropagation();
                void handleCopy();
              }}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="8" height="8" rx="1.5" />
                <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" />
              </svg>
            </ImageActionButton>
            <ImageActionButton
              title="下载图片"
              onClick={(event) => {
                event.stopPropagation();
                void handleDownload();
              }}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v8M5 7l3 3 3-3" />
                <path d="M2 12h12" />
              </svg>
            </ImageActionButton>
            <ImageActionButton
              title="关闭预览"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewOpen(false);
              }}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </ImageActionButton>
          </div>

          <div
            ref={previewViewportRef}
            className={`flex max-h-full max-w-full items-center justify-center overflow-hidden select-none ${previewScale > 1 ? (previewDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"}`}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={handlePreviewMouseDown}
          >
            <div style={{ transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0)` }}>
              <img
                ref={previewImageRef}
                src={src}
                alt={alt || "image"}
                draggable={false}
                className="max-h-[88vh] max-w-[88vw] rounded-2xl border border-white/10 shadow-2xl transition-transform duration-100 ease-out"
                style={{ transform: `scale(${previewScale})`, transformOrigin: "center center" }}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  const normalizedText = normalizeMarkdownText(String(text ?? ""));
  return (
    <>
      <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeHighlight]}
      components={{
        h1: (props) => <h1 className="mt-4 text-base font-semibold text-ink-900" {...props} />,
        h2: (props) => <h2 className="mt-3 text-[15px] font-semibold text-ink-900" {...props} />,
        h3: (props) => <h3 className="mt-3 text-sm font-semibold text-ink-800" {...props} />,
        p: (props) => <p className="mt-2 text-sm leading-relaxed text-ink-700" {...props} />,
        ul: (props) => <ul className="mt-2 ml-4 grid list-disc gap-1 text-sm" {...props} />,
        ol: (props) => <ol className="mt-2 ml-4 grid list-decimal gap-1 text-sm" {...props} />,
        li: (props) => <li className="min-w-0 text-ink-700 leading-relaxed" {...props} />,
        strong: (props) => <strong className="text-ink-900 font-semibold" {...props} />,
        em: (props) => <em className="text-ink-800" {...props} />,
        pre: (props) => (
          <pre
            className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap rounded-xl bg-surface-tertiary p-3 text-[13px] leading-relaxed text-ink-700"
            {...props}
          />
        ),
        code: (props) => {
          const { children, className, node: _node, ...rest } = props as typeof props & { node?: unknown };
          const match = /language-(\w+)/.exec(className || "");
          const content = String(children);
          const isInline = !match && !content.includes("\n");
          const isFilePath = isInline && (
            /^\/[^\s]/.test(content) ||
            /^[A-Za-z]:[/\\]/.test(content)
          );

          if (isFilePath) {
            const fileName = content.split(/[/\\]/).filter(Boolean).pop() ?? content;
            return (
              <code
                className="inline-flex items-center gap-1 rounded bg-surface-tertiary px-1.5 py-0.5 text-accent font-mono text-[13px] cursor-pointer hover:bg-accent/10 hover:underline underline-offset-2 transition-colors"
                title={content}
                onClick={() => {
                  if (typeof window.electron?.showItemInFolder === "function") {
                    void window.electron.showItemInFolder(content);
                  } else {
                    void window.electron.openPath(content.split(/[/\\]/).slice(0, -1).join("/") || "/");
                  }
                }}
                {...rest}
              >
                <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
                  <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.08a1.5 1.5 0 0 1 1.06.44L6.5 3.5H11A1.5 1.5 0 0 1 12.5 5v5A1.5 1.5 0 0 1 11 11.5h-8.5A1.5 1.5 0 0 1 1 10V3.5Z" />
                </svg>
                {fileName}
              </code>
            );
          }

          return isInline ? (
            <code className="rounded bg-surface-tertiary px-1.5 py-0.5 text-accent font-mono text-[13px]" {...rest}>
              {children}
            </code>
          ) : (
            <code className={`${className} font-mono`} {...rest}>
              {children}
            </code>
          );
        },
        a: (props) => {
          const { href, onClick, ...rest } = props;
          const isWebLink = typeof href === "string" && /^https?:\/\//i.test(href);
          return (
            <a
              {...rest}
              href={href}
              target={isWebLink ? "_blank" : props.target}
              rel={isWebLink ? "noopener noreferrer" : props.rel}
              className={`text-accent underline underline-offset-2 hover:opacity-80 ${props.className ?? ""}`.trim()}
              onClick={(event) => {
                onClick?.(event);
                if (event.defaultPrevented || !isWebLink || !href) return;
                event.preventDefault();
                void window.electron.openExternalUrl(href);
              }}
            />
          );
        },
        table: (props) => (
          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-900/10">
            <table className="w-full text-sm" {...props} />
          </div>
        ),
        thead: (props) => (
          <thead className="bg-surface-tertiary border-b border-ink-900/10" {...props} />
        ),
        tbody: (props) => (
          <tbody className="divide-y divide-ink-900/5" {...props} />
        ),
        tr: (props) => (
          <tr className="hover:bg-surface-secondary/50 transition-colors" {...props} />
        ),
        th: (props) => (
          <th className="px-4 py-2.5 text-left font-medium text-ink-800 whitespace-nowrap" {...props} />
        ),
        td: (props) => (
          <td className="px-4 py-2.5 text-ink-700" {...props} />
        ),
        blockquote: (props) => (
          <blockquote className="mt-3 border-l-4 border-accent/30 bg-accent/5 pl-4 py-2 pr-3 rounded-r-lg text-sm text-ink-700 italic" {...props} />
        ),
        hr: () => (
          <hr className="my-4 border-t border-ink-900/10" />
        ),
        img: (props) => {
          const { src, alt, className: imgClassName } = props;
          const safeSrc = normalizeImageSrc(typeof src === "string" ? src : undefined);
          if (!safeSrc) return null;
          return <InlineImage src={safeSrc} alt={alt} className={imgClassName} />;
        },
      }}
      >
        {normalizedText}
      </ReactMarkdown>
    </>
  );
});

export const StreamingText = memo(function StreamingText({ text }: { text: string }) {
  const rawText = String(text ?? "");
  const normalizedText = normalizeMarkdownText(rawText);
  if (hasRenderableImageMarkdown(normalizedText)) {
    return <MarkdownContent text={normalizedText} />;
  }
  return (
    <div className="mt-2 text-sm leading-relaxed text-ink-700 whitespace-pre-wrap break-words">
      {rawText}
    </div>
  );
});

export default MarkdownContent;
