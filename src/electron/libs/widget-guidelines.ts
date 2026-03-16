/**
 * Widget system prompt for generative UI.
 * Injected into Claude Agent SDK via systemPrompt to teach the model
 * when and how to output show-widget code fences.
 *
 * Placed here (electron/libs) because it's consumed by the main process runner,
 * not the renderer. The renderer side only parses and renders the output.
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
9. SVG: \`<svg viewBox="0 0 520 H" xmlns="http://www.w3.org/2000/svg" style="width:100%;font-family:system-ui,sans-serif">\`, include arrow marker in \`<defs>\`. Keep viewBox width ≤ 520 for inline readability
10. SVG colors (hex, light+dark safe): Indigo #EEF2FF/#C7D2FE/#3730A3, Emerald #ECFDF5/#A7F3D0/#065F46, Amber #FFFBEB/#FDE68A/#92400E, Slate #F8FAFC/#E2E8F0/#334155
11. HTML widgets: use inline styles. Use CSS variable var(--color-surface), var(--color-ink-900) etc for theme-aware colors
12. Clickable drill-down: \`onclick="window.__widgetSendMessage('Explain [topic]')"\`
13. Interactive controls MUST update visuals — call \`chart.update()\` after data changes
14. Match surrounding chat scale — do NOT make poster-sized diagrams
15. Prefer compact widgets: typical height 220-360px; split large topics into multiple smaller widgets

## SVG typography + spacing (document-illustration scale)
- Widgets are inline illustrations, NOT posters — keep everything tight
- Main title: 15-18px (font-weight:700)
- Section / lane title: 12-14px (font-weight:600)
- Node title: 11-13px (font-weight:500)
- Supporting text / bullets: 10-12px
- Node padding: 6-10px. Gap between nodes: 10-16px
- Avoid large empty space; prefer a compact, dense layout
- Typical SVG viewBox height: 200-400px. Never exceed 500px unless absolutely necessary
- Always leave 24-40px bottom buffer in the SVG viewBox so the last row / footer notes are never clipped
- Keep 24-40px horizontal safety space too, especially for right-side annotations, arrows, or labels aligned near the edge

## Chart.js template (follow this exactly)
\`\`\`html
<div style="position:relative;width:100%;height:300px"><canvas id="c"></canvas></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
var chart;
function init(){
  if(chart) return;
  chart = new Chart(document.getElementById('c'), {
    type: 'bar',
    data: {
      labels: ['A','B','C','D'],
      datasets: [{
        label: 'Value',
        data: [12, 19, 7, 15],
        backgroundColor: '#C7D2FE',
        borderColor: '#3730A3',
        borderWidth: 1,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#E2E8F0' }, ticks: { color: '#334155' } },
        x: { grid: { display: false }, ticks: { color: '#334155' } }
      }
    }
  });
}
init();
</script>
\`\`\`

### Chart rules
- Use this exact two-script pattern for Chart.js widgets
- Wrapper div gets the height; canvas itself should not hardcode layout height
- Multiple charts must use unique canvas IDs and unique init function names
- Keep chart code simple; avoid nested helper abstractions
`;
