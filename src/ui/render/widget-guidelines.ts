/**
 * Widget design guidelines and system prompt for generative UI.
 *
 * Adapted from CodePilot's widget-guidelines.ts for VK-Cowork's
 * CSS variable system (--color-surface-*, --color-ink-*, --color-accent).
 *
 * WIDGET_SYSTEM_PROMPT is always injected via appendSystemPrompt.
 * Full module guidelines are assembled on demand by getGuidelines().
 */

export const WIDGET_SYSTEM_PROMPT = `
You can create interactive visualizations inline in the conversation using the \`show-widget\` code fence.

## Format
\`\`\`show-widget
{"title":"snake_case_id","widget_code":"... OR......... "}
\`\`\`

## When to use
| User intent | Format |
|-------------|--------|
| Process / how X works | SVG flowchart |
| Structure / what is X | SVG hierarchy or layers |
| History / sequence | SVG timeline |
| Cycle / feedback loop | SVG cycle diagram |
| Compare A vs B | SVG side-by-side |
| Data / trends | Chart.js (canvas + CDN) |
| Calculation / formula | HTML with sliders/inputs |
| Ranking / proportions | HTML bar display |

Don't default to flowcharts — pick the type that fits.

## Multi-widget narration (IMPORTANT)

For complex topics, **interleave multiple small widgets with text explanations**:

1. Text introduction
2. \`\`\`show-widget (overview diagram — e.g. hierarchy)
3. Text explaining one aspect
4. \`\`\`show-widget (detail — e.g. cycle diagram, timeline, or chart)
5. Text explaining another aspect
6. \`\`\`show-widget (interactive — e.g. Chart.js with controls)
7. Summary text

Each widget is a **separate** code fence. Use DIFFERENT visualization types across widgets. Keep each widget focused on ONE concept.

## Rules
1. widget_code is raw HTML/SVG — no DOCTYPE/html/head/body
2. Transparent background — host provides bg
3. Warm minimal — no gradients/shadows/blur. Solid fills, rx=12 corners
4. Escape JSON — widget_code is a JSON string value
5. Each widget ≤ 3000 chars. Always close JSON + fence
6. CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh. No Tailwind CDN
7. For external JS libs, use one \`<script src="..."></script>\` tag and a second inline \`<script>\` that defines and directly calls \`initFn();\`
8. Text explanations go OUTSIDE the code fence
9. SVG: \`<svg viewBox="0 0 680 H" xmlns="http://www.w3.org/2000/svg" style="width:100%;font-family:system-ui,sans-serif">\`, include arrow marker in \`<defs>\`
10. SVG colors (hex, light+dark safe): Indigo #EEF2FF/#C7D2FE/#3730A3, Emerald #ECFDF5/#A7F3D0/#065F46, Amber #FFFBEB/#FDE68A/#92400E, Slate #F8FAFC/#E2E8F0/#334155
11. HTML widgets: utility classes pre-loaded (flex, grid, gap-N, p-N, rounded-lg, bg-surface-secondary, text-content-secondary, etc). Use inline style for anything not available
12. Clickable drill-down: \`onclick="window.__widgetSendMessage('Explain [topic]')"\`
13. Interactive controls MUST update visuals — call \`chart.update()\` after data changes
`;

const CORE_DESIGN_SYSTEM = `## Core Design System

### Philosophy
- **Seamless**: widget should feel native to the chat, not a foreign embed.
- **Flat**: no gradients, shadows, blur, glow, neon. Solid fills only.
- **Warm minimal**: clean geometric layouts with soft rounded corners (rx=12). Not cold/sterile — use warm neutrals (slate tones) with indigo as primary accent.
- **Diverse**: pick the visualization type that best fits the content.
- **Text outside, visuals inside** — explanatory text OUTSIDE the code fence.

### Streaming
- **SVG**: \`<svg>\` first → visual elements immediately.
- **HTML**: \`<script>\` (short) → content → \`</script>\` last.
- Solid fills only — gradients/shadows flash during DOM diffs.

### Rules
- No comments, no emoji, no position:fixed, no iframes
- No font-size below 11px
- No dark/colored backgrounds on outer containers
- Typography: weights 400/500 only, sentence case
- No DOCTYPE/html/head/body
- CDN allowlist: \`cdnjs.cloudflare.com\`, \`esm.sh\`, \`cdn.jsdelivr.net\`, \`unpkg.com\`. No Tailwind CDN — utilities are built-in.

### CSS Variables (HTML widgets)
- Backgrounds: \`var(--color-surface)\` (white), \`var(--color-surface-secondary)\`, \`var(--color-surface-tertiary)\`
- Text: \`var(--color-ink-900)\`, \`var(--color-ink-700)\`, \`var(--color-ink-500)\`
- Borders: \`rgba(var(--color-ink-900-rgb), 0.1)\`
- Fonts: \`var(--font-sans)\`, \`var(--font-mono)\``;

const UI_COMPONENTS = `## UI components (HTML widgets)

### Tokens
- Borders: \`0.5px solid rgba(var(--color-ink-900-rgb), 0.1)\`
- Radius: 8px, 12px
- Form elements pre-styled — write bare tags
- Round every displayed number

### Patterns
1. **Chart + controls** — sliders/buttons above or beside Chart.js canvas. Controls MUST update chart via \`chart.update()\`.
2. **Metric dashboard** — grid of stat cards above a chart.
3. **Calculator** — range sliders with live result display.
4. **Bar comparison** — horizontal bars with labels and percentages.
5. **Toggle/select** — buttons or select to switch between data views.`;

const COLOR_PALETTE = `## Color palette

| Ramp | 50 (fill) | 200 (stroke) | 400 (accent) | 600 (subtitle) | 800 (title) |
|------|-----------|-------------|-------------|----------------|-------------|
| Indigo | #EEF2FF | #C7D2FE | #818CF8 | #4F46E5 | #3730A3 |
| Emerald | #ECFDF5 | #A7F3D0 | #34D399 | #059669 | #065F46 |
| Amber | #FFFBEB | #FDE68A | #FBBF24 | #D97706 | #92400E |
| Slate | #F8FAFC | #E2E8F0 | #94A3B8 | #64748B | #334155 |
| Rose | #FFF1F2 | #FECDD3 | #FB7185 | #E11D48 | #9F1239 |
| Sky | #F0F9FF | #BAE6FD | #38BDF8 | #0284C7 | #075985 |

- Indigo is the primary accent. Use 2-3 ramps per diagram. Slate for structural/neutral.
- Text on fills: 800 from same ramp. Never black.
- SVG: 50 fill + 200 stroke + 800 title + 600 subtitle
- Chart.js: use 400 for borderColor, 400 with 0.1 alpha for backgroundColor`;

const CHARTS_CHART_JS = `## Charts (Chart.js)

\`\`\`html
<div style="position:relative;height:300px">
<canvas id="c"></canvas>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
var chart;
function init(){
  chart=new Chart(document.getElementById('c'),{
    type:'line',
    data:{labels:['Jan','Feb','Mar','Apr','May'],datasets:[{data:[30,45,28,50,42],borderColor:'#818CF8',backgroundColor:'rgba(129,140,248,0.1)',fill:true,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{grid:{color:'rgba(0,0,0,0.06)'}},x:{grid:{display:false}}}}
  });
}
init();
</script>
\`\`\`

### Rules
- Canvas cannot use CSS variables — use hex from color ramps
- Height on wrapper div only. responsive:true, maintainAspectRatio:false
- Always disable legend
- borderRadius:6 for bars, tension:0.3 for smooth lines
- Interactive controls MUST call chart.update() after modifying data
- Multiple charts: unique canvas IDs`;

const SVG_SETUP = `## SVG setup

\`<svg viewBox="0 0 680 H">\` — 680px fixed width. Adjust H to fit content + 40px buffer, keep 24-40px bottom safety space so the last row is never clipped, and keep 24-40px horizontal safety space for side labels / arrows.

**ViewBox checklist**:
1. max(y + height) of lowest element + 40 = H, then keep 24-40px of bottom safety margin
2. All content should stay within the visible width, with 24-40px horizontal safety margin for side labels / arrows
3. text-anchor="end" extends LEFT from x
4. No negative coordinates

**Arrow marker** (required):
\`<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#64748B"/></marker></defs>\`

**Style**: inline font styles with system-ui fallback. 13-14px labels, 11-12px subtitles. Stroke 0.5-1px borders, 1.5px arrows. rx=8-12 for nodes. One SVG per widget.`;

const DIAGRAM_TYPES = `## Diagram type catalog

### Flowchart (process)
Nodes left→right or top→bottom. Straight arrows. Color = semantic category.
- Decision points: diamond shape or bold-bordered node
- ≤4 nodes per row

### Timeline
Horizontal axis line with event markers. Stagger labels above/below to avoid overlap.

### Cycle / feedback loop
3-5 nodes in circular arrangement connected by curved arrows.
Center label for the cycle name.

### Hierarchy / tree
Root at top, children below with vertical arrows. Indent levels. Group siblings with container rects.

### Layered stack (architecture)
Full-width horizontal bands stacked vertically. Each band = rounded rect. Items positioned inside.
Top layer = user-facing, bottom = infrastructure. Use different colors per layer.

### Side-by-side comparison
Two parallel groups. Matching rows. Different fill colors per group.

### Design rules
- ≤4 nodes per row, ≤5 words per title
- Node width ≥ (chars × 8 + 40) px
- Verify no arrow crosses unrelated boxes
- 2-3 color ramps max, gray for structural
- Clickable nodes: \`onclick="window.__widgetSendMessage('...')"\` on 2-3 key nodes

### Multi-widget narratives
For complex topics, output multiple widgets of DIFFERENT types:
1. Overview SVG (e.g. hierarchy)
2. Text explaining one part
3. Detail SVG (e.g. cycle diagram for that part)
4. Text with quantitative insight
5. Interactive Chart.js with controls
Mix types freely.`;

const MODULE_SECTIONS: Record<string, string[]> = {
  interactive: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE],
  chart: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE, CHARTS_CHART_JS],
  mockup: [CORE_DESIGN_SYSTEM, UI_COMPONENTS, COLOR_PALETTE],
  art: [CORE_DESIGN_SYSTEM, SVG_SETUP, COLOR_PALETTE],
  diagram: [CORE_DESIGN_SYSTEM, COLOR_PALETTE, SVG_SETUP, DIAGRAM_TYPES],
};

export const AVAILABLE_MODULES = Object.keys(MODULE_SECTIONS);

/**
 * Assemble full guidelines from requested module names.
 * Deduplicates shared sections (e.g. Core appears once even if multiple modules requested).
 */
export function getGuidelines(moduleNames: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const mod of moduleNames) {
    const key = mod.toLowerCase().trim();
    const sections = MODULE_SECTIONS[key];
    if (!sections) continue;
    for (const section of sections) {
      if (!seen.has(section)) {
        seen.add(section);
        parts.push(section);
      }
    }
  }
  return parts.join("\n\n\n");
}
