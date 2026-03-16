import { memo, useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  sanitizeForStreaming,
  sanitizeForIframe,
  truncateUnclosedScript,
} from "./widget-sanitizer";
import { resolveThemeVars } from "./widget-theme";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";

const FINALIZE_TIMEOUT_MS = 10_000;
const DEBOUNCE_MS = 120;
const CAPTURE_TIMEOUT_MS = 5_000;
const IMAGE_LOAD_TIMEOUT_MS = 10_000;
const HEIGHT_CACHE_LIMIT = 200;

// Module-level height cache to prevent jumps on remount (streaming -> persisted)
const _heightCache = new Map<string, number>();

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(code: string): string {
  return `${code.length}:${hashString(code)}`;
}

function readCachedHeight(key: string): number | undefined {
  const value = _heightCache.get(key);
  if (value === undefined) return undefined;
  _heightCache.delete(key);
  _heightCache.set(key, value);
  return value;
}

function writeCachedHeight(key: string, height: number): void {
  if (_heightCache.has(key)) {
    _heightCache.delete(key);
  }
  _heightCache.set(key, height);
  while (_heightCache.size > HEIGHT_CACHE_LIMIT) {
    const oldestKey = _heightCache.keys().next().value;
    if (!oldestKey) break;
    _heightCache.delete(oldestKey);
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    throw new Error("invalid_data_url");
  }
  const mimeType = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes], { type: mimeType });
}

interface WidgetRendererProps {
  widgetCode: string;
  isStreaming: boolean;
  showOverlay?: boolean;
}

const WidgetRendererInner = memo(function WidgetRendererInner({
  widgetCode,
  isStreaming,
  showOverlay = false,
}: WidgetRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeReadyRef = useRef(false);
  const finalizedRef = useRef(false);
  const heightLockedRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestHeightRef = useRef(200);

  const heightCacheKey = useMemo(() => cacheKey(widgetCode), [widgetCode]);
  const cachedHeight = readCachedHeight(heightCacheKey);
  const [iframeHeight, setIframeHeight] = useState(cachedHeight ?? 200);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    latestHeightRef.current = iframeHeight;
  }, [iframeHeight]);

  // Receiver HTML is served as a static file with its own CSP context,
  // avoiding the parent page's strict script-src 'self' that blocks inline scripts.
  const receiverUrl = new URL("./widget-receiver.html", window.location.href).href;

  const postToIframe = useCallback(
    (data: Record<string, unknown>) => {
      if (!iframeRef.current?.contentWindow) return;
      iframeRef.current.contentWindow.postMessage(data, "*");
    },
    [],
  );

  // Send streaming updates (debounced)
  useEffect(() => {
    if (!isStreaming || !iframeReadyRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = setTimeout(() => {
      const { html } = truncateUnclosedScript(widgetCode);
      const safe = sanitizeForStreaming(html);
      postToIframe({ type: "widget:update", html: safe });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [widgetCode, isStreaming, postToIframe]);

  // Send finalize when streaming ends
  useEffect(() => {
    if (isStreaming || finalizedRef.current || !iframeReadyRef.current) return;
    finalizedRef.current = true;
    heightLockedRef.current = true;

    const safe = sanitizeForIframe(widgetCode);
    postToIframe({ type: "widget:finalize", html: safe });

    // Unlock height after a short delay to allow initial layout
    unlockTimerRef.current = setTimeout(() => {
      heightLockedRef.current = false;
    }, 300);

    // Timeout: if no resize comes within FINALIZE_TIMEOUT_MS, show error
    timeoutTimerRef.current = setTimeout(() => {
      if (latestHeightRef.current <= 10) {
        setLoadError("Widget 加载超时，CDN 脚本可能无法访问");
      }
    }, FINALIZE_TIMEOUT_MS);

    return () => {
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    };
  }, [isStreaming, widgetCode, postToIframe]);

  // Listen for messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (iframeRef.current?.contentWindow && e.source !== iframeRef.current.contentWindow) {
        return;
      }
      const { data } = e;
      if (!data?.type) return;

      if (data.type === "widget:ready") {
        iframeReadyRef.current = true;
        // Send current theme immediately so first paint matches host
        const cssVars = resolveThemeVars();
        postToIframe({ type: "widget:theme", cssVars });
        // Then send content
        if (isStreaming) {
          const { html } = truncateUnclosedScript(widgetCode);
          const safe = sanitizeForStreaming(html);
          postToIframe({ type: "widget:update", html: safe });
        } else if (!finalizedRef.current) {
          finalizedRef.current = true;
          const safe = sanitizeForIframe(widgetCode);
          postToIframe({ type: "widget:finalize", html: safe });
        }
      }

      if (data.type === "widget:resize" && typeof data.height === "number") {
        const h = Math.max(40, Math.ceil(data.height));
        if (timeoutTimerRef.current) {
          clearTimeout(timeoutTimerRef.current);
          timeoutTimerRef.current = null;
        }
        setLoadError(null);
        setIframeHeight((prev) => {
          if ((heightLockedRef.current || isStreaming) && h < prev) return prev;
          if (h === prev) return prev;
          latestHeightRef.current = h;
          writeCachedHeight(heightCacheKey, h);
          return h;
        });
      }

      if (data.type === "widget:error" && typeof data.message === "string") {
        if (timeoutTimerRef.current) {
          clearTimeout(timeoutTimerRef.current);
          timeoutTimerRef.current = null;
        }
        setLoadError(`Widget 脚本错误: ${data.message}`);
      }

      if (data.type === "widget:link" && typeof data.href === "string") {
        if (typeof window.electron?.openExternalUrl === "function") {
          void window.electron.openExternalUrl(data.href);
        } else {
          window.open(data.href, "_blank");
        }
      }

      if (data.type === "widget:sendMessage" && typeof data.message === "string") {
        // Dispatch custom event for the chat to pick up
        window.dispatchEvent(
          new CustomEvent("widget:sendMessage", { detail: data.message }),
        );
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [heightCacheKey, widgetCode, isStreaming, postToIframe]);

  // Theme sync: watch for dark mode toggle
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const cssVars = resolveThemeVars();
      postToIframe({ type: "widget:theme", cssVars });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, [postToIframe]);

  // Iframe onLoad fallback for widget:ready
  const handleIframeLoad = useCallback(() => {
    if (!iframeReadyRef.current) {
      iframeReadyRef.current = true;
      if (!isStreaming && !finalizedRef.current) {
        finalizedRef.current = true;
        const safe = sanitizeForIframe(widgetCode);
        postToIframe({ type: "widget:finalize", html: safe });
      }
    }
  }, [isStreaming, widgetCode, postToIframe]);

  if (loadError) {
    return (
      <div className="mt-2 rounded-xl border border-ink-900/10 bg-surface-secondary p-3">
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <svg viewBox="0 0 16 16" className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="7" />
            <path d="M8 5v3" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.5" fill="currentColor" />
          </svg>
          <span>{loadError}</span>
          <button
            onClick={() => setShowSource(!showSource)}
            className="ml-auto text-xs text-accent hover:text-accent-hover transition-colors"
          >
            {showSource ? "隐藏源码" : "查看源码"}
          </button>
        </div>
        {showSource && (
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-tertiary p-2 text-xs text-ink-600 font-mono whitespace-pre-wrap">
            {widgetCode}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="relative my-4 overflow-hidden" style={{ isolation: "isolate" }}>
      {showOverlay && (
        <div
          className="absolute inset-0 z-[1] rounded-xl bg-surface-secondary/30 flex items-end justify-center pointer-events-none"
        >
          <div className="flex items-center gap-2 text-xs text-ink-400 pb-2">
            <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-ink-300 border-t-transparent" />
            <span>渲染中…</span>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={receiverUrl}
        sandbox="allow-scripts"
        onLoad={handleIframeLoad}
        className="w-full rounded-xl border border-ink-900/8"
        style={{
          height: `${iframeHeight}px`,
          transition: cachedHeight ? "height 0.15s ease-out" : "none",
          overflow: "hidden",
          border: "none",
        }}
        title="widget"
      />
    </div>
  );
});

export function WidgetRenderer(props: WidgetRendererProps) {
  return (
    <WidgetErrorBoundary>
      <WidgetRendererInner {...props} />
    </WidgetErrorBoundary>
  );
}

async function captureIframe(
  iframe: HTMLIFrameElement,
): Promise<string | null> {
  const win = iframe.contentWindow;
  if (!win) return null;
  const id = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<string | null>((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(null);
    }, CAPTURE_TIMEOUT_MS);
    const handler = (e: MessageEvent) => {
      if (e.source !== win) return;
      const d = e.data as { type?: string; requestId?: string; ok?: boolean; dataUrl?: string } | undefined;
      if (d?.type !== "widget:capture:result" || d.requestId !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", handler);
      resolve(d.ok ? d.dataUrl ?? null : null);
    };
    window.addEventListener("message", handler);
    win.postMessage({ type: "widget:capture", requestId: id }, "*");
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("image_load_timeout"));
    }, IMAGE_LOAD_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error("image_load_failed"));
    };
    img.src = src;
  });
}

async function writeImageDataUrlToClipboard(dataUrl: string): Promise<boolean> {
  if (typeof window.electron?.copyImageDataUrlToClipboard === "function") {
    const result = await window.electron.copyImageDataUrlToClipboard(dataUrl);
    return result.ok;
  }
  const blob = dataUrlToBlob(dataUrl);
  await navigator.clipboard.write([
    new ClipboardItem({ [blob.type || "image/png"]: blob }),
  ]);
  return true;
}

function inlineComputedStyles(source: HTMLElement, clone: HTMLElement): void {
  const srcStyle = getComputedStyle(source);
  const props = [
    "font-family", "font-size", "font-weight", "font-style",
    "color", "background-color", "background",
    "margin", "padding", "border", "border-radius",
    "display", "position", "top", "right", "bottom", "left", "z-index",
    "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
    "align-items", "align-self", "justify-content", "justify-self", "order", "gap",
    "row-gap", "column-gap",
    "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
    "width", "max-width", "min-width", "height", "min-height", "max-height",
    "line-height", "letter-spacing", "text-align", "text-decoration",
    "list-style-type", "list-style-position",
    "overflow", "white-space", "word-break", "box-sizing",
    "box-shadow", "transform", "transform-origin", "opacity",
  ];
  for (const p of props) {
    const v = srcStyle.getPropertyValue(p);
    if (v) (clone as HTMLElement).style.setProperty(p, v);
  }
  const srcChildren = source.children;
  const cloneChildren = clone.children;
  for (let i = 0; i < srcChildren.length && i < cloneChildren.length; i++) {
    if (srcChildren[i] instanceof HTMLElement && cloneChildren[i] instanceof HTMLElement) {
      inlineComputedStyles(srcChildren[i] as HTMLElement, cloneChildren[i] as HTMLElement);
    }
  }
}

export async function copyMessageAsCompositeImage(
  container: HTMLElement,
): Promise<boolean> {
  const dpr = window.devicePixelRatio || 2;
  const containerWidth = container.clientWidth || 600;

  const iframes = Array.from(
    container.querySelectorAll("iframe[title='widget']"),
  ) as HTMLIFrameElement[];

  const capturedImages = await Promise.all(iframes.map(captureIframe));

  const clone = container.cloneNode(true) as HTMLElement;

  inlineComputedStyles(container, clone);

  const clonedIframes = Array.from(
    clone.querySelectorAll("iframe[title='widget']"),
  );
  for (let i = 0; i < clonedIframes.length; i++) {
    const iframeEl = clonedIframes[i];
    const wrapper = iframeEl.parentElement;
    if (!wrapper) continue;
    const dataUrl = capturedImages[i];
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.style.width = "100%";
      img.style.height = "auto";
      img.style.display = "block";
      img.style.borderRadius = "12px";
      wrapper.replaceChild(img, iframeEl);
    } else {
      iframeEl.remove();
    }
  }

  clone.querySelectorAll("button, [class*='animate']").forEach((el) => el.remove());
  clone.removeAttribute("class");

  const wrapper = document.createElement("div");
  wrapper.style.width = containerWidth + "px";
  wrapper.style.display = "flow-root";
  wrapper.style.background = "#fff";
  wrapper.style.padding = "0";
  wrapper.style.margin = "0";

  clone.style.width = "100%";
  clone.style.display = "flow-root";
  clone.style.margin = "0";
  clone.style.background = "transparent";

  wrapper.appendChild(clone);
  wrapper.style.position = "absolute";
  wrapper.style.left = "-9999px";
  wrapper.style.top = "0";
  document.body.appendChild(wrapper);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const contentHeight = wrapper.scrollHeight || clone.scrollHeight || 400;
  document.body.removeChild(wrapper);

  const xmlns = "http://www.w3.org/1999/xhtml";
  wrapper.setAttribute("xmlns", xmlns);
  wrapper.style.position = "";
  wrapper.style.left = "";
  wrapper.style.top = "";
  const serialized = new XMLSerializer().serializeToString(wrapper);

  const pad = 12;
  const svgW = containerWidth + pad * 2;
  const svgH = contentHeight + pad * 2;

  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">
<foreignObject x="${pad}" y="${pad}" width="${containerWidth}" height="${contentHeight}">
${serialized}
</foreignObject>
</svg>`;

  const svgDataUrl =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgMarkup);

  const svgImg = await loadImage(svgDataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(svgW * dpr);
  canvas.height = Math.ceil(svgH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  ctx.drawImage(svgImg, 0, 0, svgW, svgH);

  const finalDataUrl = canvas.toDataURL("image/png");
  return writeImageDataUrlToClipboard(finalDataUrl);
}

export async function copyWidgetsAsImage(container: HTMLElement): Promise<boolean> {
  const iframes = Array.from(
    container.querySelectorAll("iframe[title='widget']"),
  ) as HTMLIFrameElement[];
  if (!iframes.length) return false;

  const captured = (await Promise.all(iframes.map(captureIframe))).filter(
    (v): v is string => Boolean(v),
  );
  if (!captured.length) return false;

  const images = await Promise.all(captured.map(loadImage));
  const pad = 12;
  const gap = 12;
  const dpr = window.devicePixelRatio || 1;
  const maxWidth = Math.max(
    ...images.map((img) => (img.naturalWidth || img.width) / dpr),
  );
  const totalHeight =
    images.reduce((sum, img) => sum + (img.naturalHeight || img.height) / dpr, 0) +
    gap * Math.max(0, images.length - 1);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((maxWidth + pad * 2) * dpr);
  canvas.height = Math.ceil((totalHeight + pad * 2) * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  let y = pad;
  for (const img of images) {
    const w = (img.naturalWidth || img.width) / dpr;
    const h = (img.naturalHeight || img.height) / dpr;
    const x = Math.round((maxWidth - w) / 2) + pad;
    ctx.drawImage(img, x, y, w, h);
    y += h + gap;
  }

  return writeImageDataUrlToClipboard(canvas.toDataURL("image/png"));
}
