Create a presentation slide image following these guidelines:

## Image Specifications

- **Type**: Presentation slide
- **Aspect Ratio**: 16:9 (landscape)
- **Style**: Professional slide deck

## Core Persona: The Architect

You are "The Architect" - a master visual storyteller creating presentation slides. Your slides:
- Tell a visual story that complements the narrative
- Use bold, confident visual language
- Balance information density with visual clarity
- Create memorable, impactful visuals

## Core Principles

- Hand-drawn quality throughout - NO realistic or photographic elements
- NO slide numbers, page numbers, footers, headers, or logos
- Clean, uncluttered layouts with clear visual hierarchy
- Each slide conveys ONE clear message

## Text Style

- Use concise Simplified Chinese for all visible text
- Keep labels short and highly legible
- Prefer 3-6 compact labels over long paragraphs
- Use direct, confident wording

---

## STYLE_INSTRUCTIONS

<STYLE_INSTRUCTIONS>
Design Aesthetic: A precise blueprint-style presentation for technical onboarding, using engineering-paper structure, cool analytical blues, and clean schematic composition. The visuals should feel authoritative and system-oriented, but simplified enough for beginners to understand at a glance. Prefer diagrammatic storytelling over dense prose.

Background:
  Texture: Subtle light-gray engineering grid overlay with technical drawing precision
  Base Color: Blueprint Paper (#FAF8F5)

Typography:
  Headlines: Bold geometric sans-serif with precise strokes, high contrast, and calm technical authority
  Body: Clean readable serif or neutral technical text style, compact but easy to scan in Chinese

Color Palette:
  Primary Text: Deep Slate (#334155) - headlines, labels, and body text
  Background: Blueprint Paper (#FAF8F5) - primary background
  Accent 1: Engineering Blue (#2563EB) - key paths, core modules, and emphasis
  Accent 2: Navy Blue (#1E3A5F) - secondary blocks and supporting structure
  Accent 3: Light Blue (#BFDBFE) - panels, fills, and grouping areas
  Accent 4: Amber (#F59E0B) - highlights for value, maintenance, or key actions

Visual Elements:
  - Technical schematics with thin line work and consistent stroke weights
  - Straight connector lines and 90-degree angles only
  - Simplified module cards, directory blocks, and flow arrows
  - Blueprint annotations, brackets, and subtle measurement marks
  - Clean infographic icons for memory, logs, tools, and background jobs

Density Guidelines:
  - Content per slide: 1 main idea plus 2-3 supporting blocks
  - Whitespace: generous margins, clear grouping, avoid dense paragraph text

Style Rules:
  Do: Maintain grid alignment, strong visual hierarchy, restrained palette, simplified architecture diagrams, beginner-friendly labeling.
  Don't: Use photos, hand-drawn effects, decorative flourishes, curved arrows, dense prose blocks, or UI screenshot aesthetics.
</STYLE_INSTRUCTIONS>

---

## SLIDE CONTENT

- Slide number: 2 of 2
- Filename: 02-slide-read-write-flow.png
- Type: Content

### Narrative Goal
让读者看懂记忆模块如何在会话前读取上下文、在会话后写回结果，并通过后台任务持续维护。

### Key Content
- Headline: 一条读路径，两条写路径，形成持续演化的闭环
- Sub-headline: 新会话先读记忆，任务完成后再把结果写回长期记忆、工作记忆和日志
- Bottom note: 先读取与当前任务相关的记忆，再在任务结束后写回，后台任务继续做巡检、归档和压缩。
- Supporting points:
  - Runner 读取 `.abstract`、长期记忆、工作记忆、daily 与知识
  - Agent 通过 MCP 写入记忆，Bot 与 App 会话结束后也会自动落盘
  - Heartbeat、Janitor、Compaction 在后台持续巡检、归档和压缩

### Visible Labels
- 读取上下文
- 会话运行
- 写回记忆
- 后台维护
- 索引 .abstract
- 长期记忆
- 工作记忆
- 每日日志
- 知识库
- 记忆工具
- 机器人 / 应用
- 心跳巡检
- 过期归档
- 周期压缩

### Visual Description
Create a clean blueprint-style process slide showing a continuous loop. The left side is "读取上下文" with small source nodes for "索引 .abstract", "长期记忆", "工作记忆", "每日日志", and "知识库", all feeding into the center. The center is a strong highlighted block labeled "会话运行". The right side is "写回记忆" with two branches: one for "记忆工具" writing back to memory cards, another for "机器人 / 应用" writing to "每日日志". Along the bottom, add a compact maintenance lane labeled "后台维护" with three small modules: "心跳巡检", "过期归档", and "周期压缩". All visible labels should be primarily Chinese. Add a short one-line explanation in a narrow band at the bottom of the slide: "先读取与当前任务相关的记忆，再在任务结束后写回，后台任务继续做巡检、归档和压缩。". Use a dominant loop arrow to show that memory is continuously read, updated, and maintained. Keep the slide crisp, beginner-friendly, and diagram-first.

### Layout Guidance
- Layout: circular-flow
- Clear separation of read, run, write, and maintain stages
- Dominant loop arrow with supporting branch arrows
- Labels should remain short and readable
