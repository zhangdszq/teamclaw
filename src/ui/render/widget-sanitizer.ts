/**
 * Two-stage HTML sanitizer for widget code + receiver iframe srcdoc builder.
 *
 * Stage 1 (streaming): strips scripts, event handlers, dangerous tags — safe
 *   to inject as visual-only preview during streaming.
 * Stage 2 (finalized): strips only nesting/escape tags (iframe, object, embed, etc.)
 *   but keeps scripts and event handlers — runs inside sandbox iframe.
 */

export const CDN_ALLOWLIST = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
];

const DANGEROUS_TAGS_STREAMING =
  /(<\/?)(script|iframe|object|embed|applet|meta|link|base|form|style)\b[^>]*>/gi;

const ON_HANDLER_RE = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const DANGEROUS_URLS_RE = /(href|src|action)\s*=\s*["']?\s*(javascript:|data:text\/html)/gi;

const NESTING_TAGS_RE =
  /(<\/?)(iframe|object|embed|applet|meta|link|base|form)\b[^>]*>/gi;

export function sanitizeForStreaming(html: string): string {
  return html
    .replace(DANGEROUS_TAGS_STREAMING, "")
    .replace(ON_HANDLER_RE, "")
    .replace(DANGEROUS_URLS_RE, '$1=""');
}

export function sanitizeForIframe(html: string): string {
  return html.replace(NESTING_TAGS_RE, "");
}

/**
 * Truncate an unclosed <script> during streaming to prevent raw JS from
 * showing as visible text. Returns the html with incomplete script blocks removed.
 */
export function truncateUnclosedScript(html: string): { html: string; truncated: boolean } {
  const lowerHtml = html.toLowerCase();
  const lastOpenScript = lowerHtml.lastIndexOf("<script");
  if (lastOpenScript === -1) return { html, truncated: false };
  const afterOpen = html.indexOf(">", lastOpenScript);
  if (afterOpen === -1) {
    return { html: html.slice(0, lastOpenScript), truncated: true };
  }
  const closeIdx = lowerHtml.indexOf("</script>", afterOpen);
  if (closeIdx === -1) {
    return { html: html.slice(0, lastOpenScript), truncated: true };
  }
  return { html, truncated: false };
}

