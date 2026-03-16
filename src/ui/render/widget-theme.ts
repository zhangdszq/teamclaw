/**
 * CSS variable bridge: resolves VK-Cowork's theme variables into a string
 * that can be injected into the widget iframe srcdoc.
 *
 * VK-Cowork uses:
 *   --color-surface, --color-surface-secondary, --color-surface-tertiary
 *   --color-ink-900 .. --color-ink-400
 *   --color-accent, --color-accent-hover
 *   --color-muted
 * Dark mode: html.dark class toggle
 */

const VARS_TO_RESOLVE = [
  "--color-surface",
  "--color-surface-secondary",
  "--color-surface-tertiary",
  "--color-ink-900",
  "--color-ink-800",
  "--color-ink-700",
  "--color-ink-600",
  "--color-ink-500",
  "--color-ink-400",
  "--color-accent",
  "--color-accent-hover",
  "--color-muted",
  "--color-error",
  "--color-success",
  "--color-info",
] as const;

/**
 * Resolve current CSS variable values from the document root and return
 * a CSS string suitable for injection into iframe :root.
 */
export function resolveThemeVars(): string {
  const style = getComputedStyle(document.documentElement);
  const lines: string[] = [];
  for (const varName of VARS_TO_RESOLVE) {
    const value = style.getPropertyValue(varName).trim();
    if (value) {
      lines.push(`  ${varName}: ${value};`);
    }
  }
  // Generate RGB triplet for ink-900 (used for rgba borders in widgets)
  const ink900 = style.getPropertyValue("--color-ink-900").trim();
  if (ink900) {
    const rgb = hexToRgb(ink900);
    if (rgb) {
      lines.push(`  --color-ink-900-rgb: ${rgb};`);
    }
  }
  return lines.join("\n");
}

function hexToRgb(hex: string): string | null {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  return `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}`;
}

/**
 * Check if dark mode is currently active.
 */
export function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark");
}
