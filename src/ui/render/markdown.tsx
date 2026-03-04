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
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2">
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

// ─── Inline image with hover toolbar ────────────────────────────────────────

function InlineImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [hovered, setHovered] = useState(false);
  const [copyTip, setCopyTip] = useState<"idle" | "ok" | "err">("idle");

  const handleCopy = useCallback(async () => {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopyTip("ok");
      setTimeout(() => setCopyTip("idle"), 1800);
    } catch {
      setCopyTip("err");
      setTimeout(() => setCopyTip("idle"), 1800);
    }
  }, [src]);

  const handleDownload = useCallback(async () => {
    // Remote image (http/https/data) — let the browser handle the download
    if (/^(https?:\/\/|data:)/i.test(src)) {
      const name = src.split("/").pop()?.split("?")[0] || "image";
      const a = document.createElement("a");
      a.href = src;
      a.download = name;
      a.click();
      return;
    }

    // Local image via localfile:// — reconstruct fs path and use Electron save dialog
    let localPath = src;
    if (src.startsWith("localfile://")) {
      const url = new URL(src);
      localPath = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
      localPath = decodeURIComponent(localPath);
      // Windows: "/C:/path/file.png" → "C:/path/file.png"
      if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1);
    }

    const result = await window.electron.saveImage(localPath);
    if (result.ok) {
      const name = result.savedTo?.split(/[/\\]/).pop() ?? "图片";
      emitToast(`已保存：${name}`);
    } else if (result.reason && result.reason !== "canceled") {
      emitToast(`保存失败：${result.reason}`, "err");
    }
  }, [src]);

  return (
    <span
      className="relative mt-3 inline-block max-w-full"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={src}
        alt={alt || "image"}
        loading="lazy"
        className={`block max-w-full rounded-xl border border-ink-900/10 ${className ?? ""}`.trim()}
      />

      {/* Hover toolbar */}
      <span
        className={`absolute right-2 top-2 flex gap-1 rounded-lg bg-black/50 px-1 py-1 backdrop-blur-sm transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        aria-hidden={!hovered}
      >
        {/* Copy button */}
        <button
          title={copyTip === "ok" ? "已复制" : copyTip === "err" ? "复制失败" : "复制图片"}
          onClick={handleCopy}
          className="flex h-6 w-6 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        >
          {copyTip === "ok" ? (
            // Checkmark
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 8 6.5 12 13 4" />
            </svg>
          ) : (
            // Copy icon
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" />
            </svg>
          )}
        </button>

        {/* Download button */}
        <button
          title="下载图片"
          onClick={handleDownload}
          className="flex h-6 w-6 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v8M5 7l3 3 3-3" />
            <path d="M2 12h12" />
          </svg>
        </button>
      </span>
    </span>
  );
}

export default memo(function MDContent({ text }: { text: string }) {
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
          const { children, className, ...rest } = props;
          const match = /language-(\w+)/.exec(className || "");
          const isInline = !match && !String(children).includes("\n");

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
      {String(text ?? "")}
    </ReactMarkdown>
    </>
  );
});
