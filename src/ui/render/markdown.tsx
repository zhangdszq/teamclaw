import { memo, useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { useAppStore } from "../store/useAppStore";

const LazyRichMessageContent = lazy(() =>
  import("./rich-message").then((m) => ({ default: m.RichMessageContent })),
);

// Mermaid lazy init — only loaded when a mermaid code block is encountered
let mermaidInitialized = false;
let mermaidInstance: typeof import("mermaid").default | null = null;
let mermaidIdCounter = 0;

async function getMermaid() {
  if (!mermaidInstance) {
    const mod = await import("mermaid");
    mermaidInstance = mod.default;
  }
  if (!mermaidInitialized) {
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
      securityLevel: "strict",
    });
    mermaidInitialized = true;
  }
  return mermaidInstance;
}

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRendered(false);

    (async () => {
      try {
        const mermaid = await getMermaid();
        const id = `mermaid-${++mermaidIdCounter}`;
        const { svg } = await mermaid.render(id, code.trim());
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setRendered(true);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Mermaid 语法错误");
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div>
        <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap rounded-xl bg-surface-tertiary p-3 text-[13px] leading-relaxed text-ink-700">
          <code className="font-mono">{code}</code>
        </pre>
        <div className="mt-1 text-xs text-ink-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div
        ref={containerRef}
        className={`overflow-x-auto ${rendered ? "" : "h-20 animate-pulse rounded-xl bg-surface-tertiary"}`}
      />
    </div>
  );
}

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

export function normalizeImageSrc(src?: string): string | undefined {
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
const SKILL_COMMAND_RE = /(^|[^\w/])(\/([a-z0-9][\w-]*))(?=[\s.,!?;:，。！？；：]|$)/gi;
const SKILL_COMMAND_EXCLUDED_NODES = new Set(["code", "inlineCode", "html", "link", "linkReference"]);

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

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function replaceSkillCommandTextNode(node: { type: "text"; value: string }, installedSkillNames: Set<string>) {
  const value = String(node.value ?? "");
  const parts: Array<{ type: "text"; value: string } | { type: "html"; value: string }> = [];
  let cursor = 0;

  for (const match of value.matchAll(SKILL_COMMAND_RE)) {
    const prefix = match[1] ?? "";
    const slashCommand = match[2] ?? "";
    const skillName = match[3] ?? "";
    if (!skillName || !installedSkillNames.has(skillName)) continue;

    const matchIndex = match.index ?? 0;
    const commandIndex = matchIndex + prefix.length;

    if (matchIndex > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, matchIndex) });
    }
    if (prefix) {
      parts.push({ type: "text", value: prefix });
    }

    parts.push({
      type: "html",
      value: `<span data-skill-chip="${escapeHtmlAttribute(skillName)}"></span>`,
    });
    cursor = commandIndex + slashCommand.length;
  }

  if (parts.length === 0) return [node];
  if (cursor < value.length) {
    parts.push({ type: "text", value: value.slice(cursor) });
  }
  return parts;
}

function transformSkillCommands(node: any, installedSkillNames: Set<string>) {
  if (!node || SKILL_COMMAND_EXCLUDED_NODES.has(node.type) || !Array.isArray(node.children)) return;

  const nextChildren: any[] = [];
  for (const child of node.children) {
    if (child?.type === "text") {
      nextChildren.push(...replaceSkillCommandTextNode(child, installedSkillNames));
      continue;
    }
    transformSkillCommands(child, installedSkillNames);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function createSkillChipRemarkPlugin(installedSkillNames: Set<string>) {
  return function remarkSkillChipPlugin() {
    return (tree: any) => {
      if (installedSkillNames.size === 0) return;
      transformSkillCommands(tree, installedSkillNames);
    };
  };
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

function SkillChip({
  skillName,
  skillLabel,
  skillDescription,
}: {
  skillName: string;
  skillLabel?: string;
  skillDescription?: string;
}) {
  const displayName = (skillLabel || "").trim() || skillName;
  const title = [skillLabel, skillDescription].filter(Boolean).join(" · ") || `/${skillName}`;
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded-full border border-accent/15 bg-accent/10 px-2 py-[3px] align-middle text-[12px] font-medium leading-none text-accent"
      title={title}
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 18h6M10 22h4M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
      </svg>
      <span>{displayName}</span>
    </span>
  );
}

// ─── Reusable image preview overlay (fullscreen lightbox with zoom/drag) ─────

export function ImagePreviewOverlay({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [controlsVisible, setControlsVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const clearControlsTimer = useCallback(() => {
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    clearControlsTimer();
    controlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
      controlsTimerRef.current = null;
    }, 1400);
  }, [clearControlsTimer]);

  const clampOffset = useCallback((next: { x: number; y: number }, s: number = scale) => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image || s <= 1) return { x: 0, y: 0 };
    const maxX = Math.max(0, (image.offsetWidth * s - viewport.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * s - viewport.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, [scale]);

  const stopDrag = useCallback(() => {
    dragStartRef.current = null;
    setDragging(false);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await copyImageFromSrc(src);
      emitToast("复制成功");
    } catch {
      emitToast("复制失败", "err");
    }
  }, [src]);

  const handleDownload = useCallback(async () => {
    await downloadImageFromSrc(src);
  }, [src]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      stopDrag();
      clearControlsTimer();
    };
  }, [onClose, clearControlsTimer, stopDrag]);

  useEffect(() => {
    setOffset((prev) => clampOffset(prev, scale));
  }, [scale, clampOffset]);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseUp = () => stopDrag();
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [dragging, stopDrag]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY < 0 ? 0.16 : -0.16;
    setScale((prev) => Math.min(4, Math.max(1, Number((prev + delta).toFixed(2)))));
    revealControls();
  }, [revealControls]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || scale <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
    setDragging(true);
    revealControls();
  }, [scale, offset.x, offset.y, revealControls]);

  const handleMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    revealControls();
    const drag = dragStartRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const next = {
      x: drag.offsetX + (event.clientX - drag.x),
      y: drag.offsetY + (event.clientY - drag.y),
    };
    setOffset(clampOffset(next, scale));
  }, [clampOffset, scale, revealControls]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/78 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "图片预览"}
      onClick={onClose}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        stopDrag();
        clearControlsTimer();
        setControlsVisible(false);
      }}
      onMouseUp={stopDrag}
      onWheel={handleWheel}
    >
      <div
        className={`absolute right-4 top-4 flex items-center gap-2 transition-opacity duration-200 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
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
            onClose();
          }}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </ImageActionButton>
      </div>

      <div
        ref={viewportRef}
        className={`flex max-h-full max-w-full items-center justify-center overflow-hidden select-none ${scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"}`}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={handleMouseDown}
      >
        <div style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}>
          <img
            ref={imageRef}
            src={src}
            alt={alt || "image"}
            draggable={false}
            className="max-h-[88vh] max-w-[88vw] rounded-2xl border border-white/10 shadow-2xl transition-transform duration-100 ease-out"
            style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Inline image with hover toolbar ────────────────────────────────────────

function InlineImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [hovered, setHovered] = useState(false);
  const [copyTip, setCopyTip] = useState<"idle" | "ok" | "err">("idle");
  const [previewOpen, setPreviewOpen] = useState(false);

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

      {previewOpen && <ImagePreviewOverlay src={src} alt={alt} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  const skills = useAppStore((state) => state.skills);
  const normalizedText = normalizeMarkdownText(String(text ?? ""));
  const skillMap = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const skill of skills) {
      map.set(skill.name, skill);
    }
    return map;
  }, [skills]);
  const remarkSkillChipPlugin = useMemo(
    () => createSkillChipRemarkPlugin(new Set(skillMap.keys())),
    [skillMap]
  );
  return (
    <>
      <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkSkillChipPlugin]}
      rehypePlugins={[rehypeRaw, rehypeHighlight]}
      components={{
        h1: (props) => <h1 className="mt-4 text-base font-semibold text-ink-900" {...props} />,
        h2: (props) => <h2 className="mt-3 text-[15px] font-semibold text-ink-900" {...props} />,
        h3: (props) => <h3 className="mt-3 text-sm font-semibold text-ink-800" {...props} />,
        p: (props) => <p className="mt-2 text-sm leading-relaxed text-ink-700" {...props} />,
        span: (props) => {
          const extraProps = props as typeof props & Record<string, unknown>;
          const skillName = typeof extraProps["data-skill-chip"] === "string" ? extraProps["data-skill-chip"] : undefined;
          if (skillName) {
            const skill = skillMap.get(skillName);
            return (
              <SkillChip
                skillName={skillName}
                skillLabel={skill?.label}
                skillDescription={skill?.description}
              />
            );
          }
          return <span {...props} />;
        },
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

          // Mermaid diagram rendering
          if (match?.[1] === "mermaid" && content.trim()) {
            return <MermaidDiagram code={content} />;
          }

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

  // Widget rendering takes priority — delegate to RichMessageContent (lazy to avoid circular dep)
  if (rawText.includes("```show-widget")) {
    return (
      <Suspense fallback={<div className="mt-2 text-sm text-ink-500">加载中…</div>}>
        <LazyRichMessageContent text={normalizedText} streaming />
      </Suspense>
    );
  }

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
