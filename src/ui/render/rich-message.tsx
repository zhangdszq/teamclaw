import { memo, useMemo } from "react";
import MarkdownContent from "./markdown";
import { WidgetRenderer } from "./WidgetRenderer";

// ─── Show-widget parsing ─────────────────────────────────────────────────────

export type TextSegment = { type: "text"; content: string };
export type WidgetSegment = {
  type: "widget";
  title: string;
  widgetCode: string;
};
export type MessageSegment = TextSegment | WidgetSegment;

const FENCE_RE = /```show-widget\s*\n([\s\S]*?)```/g;

/**
 * Parse a completed message into alternating text/widget segments.
 */
export function parseAllShowWidgets(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(FENCE_RE)) {
    const matchStart = match.index!;
    if (matchStart > lastIndex) {
      const t = text.slice(lastIndex, matchStart).trim();
      if (t) segments.push({ type: "text", content: t });
    }

    const parsed = tryParseWidgetJson(match[1]);
    if (parsed) {
      segments.push({ type: "widget", title: parsed.title, widgetCode: parsed.widget_code });
    } else {
      // Failed to parse JSON — render as code block
      segments.push({ type: "text", content: "```\n" + match[1] + "```" });
    }
    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < text.length) {
    const t = text.slice(lastIndex).trim();
    if (t) segments.push({ type: "text", content: t });
  }

  return segments;
}

/**
 * Extract widget_code from a truncated (unclosed) fence body during streaming.
 * Does NOT use JSON.parse — manually searches for the widget_code key.
 */
export function extractTruncatedWidget(
  fenceBody: string,
): { title: string; widget_code: string } | null {
  const wcKey = '"widget_code"';
  const wcIdx = fenceBody.indexOf(wcKey);
  if (wcIdx === -1) return null;

  // Find the colon after the key
  const colonIdx = fenceBody.indexOf(":", wcIdx + wcKey.length);
  if (colonIdx === -1) return null;

  // Find the opening quote of the value
  const quoteStart = fenceBody.indexOf('"', colonIdx + 1);
  if (quoteStart === -1) return null;

  // Walk to find the end of the JSON string value (unescaped quote)
  let i = quoteStart + 1;
  const chars: string[] = [];
  while (i < fenceBody.length) {
    if (fenceBody[i] === "\\") {
      // Handle escape sequences
      const next = fenceBody[i + 1];
      if (next === '"') chars.push('"');
      else if (next === "\\") chars.push("\\");
      else if (next === "n") chars.push("\n");
      else if (next === "t") chars.push("\t");
      else if (next === "/") chars.push("/");
      else chars.push(fenceBody[i], next ?? "");
      i += 2;
    } else if (fenceBody[i] === '"') {
      break; // End of string value
    } else {
      chars.push(fenceBody[i]);
      i++;
    }
  }

  if (chars.length === 0) return null;

  // Extract title
  let title = "widget";
  const titleMatch = fenceBody.match(/"title"\s*:\s*"([^"]+)"/);
  if (titleMatch) title = titleMatch[1];

  return { title, widget_code: chars.join("") };
}

/**
 * Compute a stable React key for a widget during streaming.
 * Uses the first 100 chars of widget_code so the key doesn't change
 * when the fence closes and more content is appended after it.
 */
export function computePartialWidgetKey(widgetCode: string, index: number): string {
  return `w-${index}-${simpleHash(widgetCode.slice(0, 100))}`;
}

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function tryParseWidgetJson(raw: string): { title: string; widget_code: string } | null {
  const trimmed = raw.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj.widget_code === "string") {
      return { title: obj.title || "widget", widget_code: obj.widget_code };
    }
  } catch {
    // Fall through to manual extraction
  }
  return extractTruncatedWidget(trimmed);
}

// ─── Detect unclosed show-widget fence during streaming ─────────────────────

const FENCE_OPEN_RE = /```show-widget\s*\n/g;
const FENCE_CLOSE_RE = /```/g;

function hasUnclosedShowWidget(text: string): {
  unclosed: boolean;
  beforePart: string;
  fenceBody: string;
} {
  let lastOpenIdx = -1;
  let lastOpenLength = 0;
  for (const m of text.matchAll(FENCE_OPEN_RE)) {
    lastOpenIdx = m.index!;
    lastOpenLength = m[0].length;
  }
  if (lastOpenIdx === -1) return { unclosed: false, beforePart: text, fenceBody: "" };

  const afterOpen = text.slice(lastOpenIdx + lastOpenLength);

  // Check if there's a closing ``` after the open
  FENCE_CLOSE_RE.lastIndex = 0;
  const closes = [...afterOpen.matchAll(FENCE_CLOSE_RE)];
  if (closes.length === 0) {
    return {
      unclosed: true,
      beforePart: text.slice(0, lastOpenIdx),
      fenceBody: afterOpen,
    };
  }

  return { unclosed: false, beforePart: text, fenceBody: "" };
}

// ─── RichMessageContent ─────────────────────────────────────────────────────

interface RichMessageContentProps {
  text: string;
  streaming?: boolean;
}

/**
 * Renders assistant message text, splitting out show-widget blocks
 * into WidgetRenderer components and passing the rest to MarkdownContent.
 * Falls back to plain MarkdownContent when no widgets are present.
 */
export const RichMessageContent = memo(function RichMessageContent({
  text,
  streaming = false,
}: RichMessageContentProps) {
  const hasWidget = text.includes("```show-widget");

  const segments = useMemo(() => {
    if (!hasWidget) return null;

    if (streaming) {
      return parseStreamingSegments(text);
    }
    return parseAllShowWidgets(text);
  }, [text, hasWidget, streaming]);

  // Fast path: no widgets
  if (!segments || segments.length === 0) {
    return <MarkdownContent text={text} />;
  }

  const lastWidgetIdx = segments.reduce(
    (last, seg, idx) => (seg.type === "widget" ? idx : last),
    -1,
  );

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === "text") {
          return <MarkdownContent key={`text-${idx}`} text={seg.content} />;
        }
        const isLastWidget = idx === lastWidgetIdx;
        const widgetStreaming = streaming && isLastWidget;
        return (
          <WidgetRenderer
            key={computePartialWidgetKey(seg.widgetCode, idx)}
            widgetCode={seg.widgetCode}
            isStreaming={widgetStreaming}
            showOverlay={widgetStreaming}
          />
        );
      })}
    </>
  );
});

function parseStreamingSegments(text: string): MessageSegment[] | null {
  const { unclosed, beforePart, fenceBody } = hasUnclosedShowWidget(text);

  if (!unclosed) {
    // All fences are closed — parse normally
    const segments = parseAllShowWidgets(text);
    return segments.length > 0 ? segments : null;
  }

  const segments: MessageSegment[] = [];

  // Parse any completed widgets in the beforePart
  if (beforePart.includes("```show-widget")) {
    segments.push(...parseAllShowWidgets(beforePart));
  } else if (beforePart.trim()) {
    segments.push({ type: "text", content: beforePart.trim() });
  }

  // Try to extract widget_code from the unclosed fence body
  const partial = extractTruncatedWidget(fenceBody);
  if (partial) {
    segments.push({
      type: "widget",
      title: partial.title,
      widgetCode: partial.widget_code,
    });
  }
  // If extraction fails, we just don't render the partial widget
  // (prefer "late appearance" over broken content)

  return segments.length > 0 ? segments : null;
}
