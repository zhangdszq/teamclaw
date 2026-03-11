# Slide Deck Outline

**Topic**: 记忆模块介绍
**Style**: blueprint
**Dimensions**: grid + cool + technical + balanced
**Audience**: beginners
**Language**: zh
**Slide Count**: 2 slides
**Generated**: 2026-03-10 00:00

---

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

## Slide 1 of 2

**Type**: Cover
**Filename**: 01-slide-cover.png

// NARRATIVE GOAL
让读者先理解记忆模块的目标、价值和核心结构，建立第一层心智模型。

// KEY CONTENT
Headline: 记忆模块：让 Agent 拥有跨会话记忆
Sub-headline: 用本地文件、索引与多入口接入，把偏好、上下文和工作现场持续保存
Body:
- 把长期偏好、当前任务和近期上下文沉淀下来，下一次会话可以直接接续。

// VISUAL
Top area shows the title and a concise subtitle. The main visual is a clean blueprint-style system map centered on a "记忆核心" hub. Around it, place three clearly grouped zones: "共享记忆", "私有记忆", and "知识库". Within the map, use three prominent cards labeled "长期记忆", "工作记忆", and "每日日志" to show the three main carriers. Add a small "索引 .abstract" badge above the hub to indicate discovery and retrieval. Add a short explanatory note band at the bottom in Chinese. Use thin engineering lines, boxed annotations, and restrained blue fills. The overall effect should feel like a simplified technical architecture poster for onboarding.

// LAYOUT
Layout: title-hero
Large title band at the top, system diagram occupying the center and lower two-thirds, with three grouped memory zones arranged in a balanced triangular composition.

---

## Slide 2 of 2

**Type**: Content
**Filename**: 02-slide-read-write-flow.png

// NARRATIVE GOAL
让读者看懂记忆模块如何在会话前读取上下文、在会话后写回结果，并通过后台任务持续维护。

// KEY CONTENT
Headline: 一条读路径，两条写路径，形成持续演化的闭环
Sub-headline: 新会话先读记忆，任务完成后再把结果写回长期记忆、工作记忆和日志
Body:
- Runner 在会话启动时调用 `buildSmartMemoryContext()`，读取索引、长期记忆、工作记忆、daily 与相关知识
- Agent 通过 MCP 写入记忆，Bot 与 App 会话结束后也会自动把摘要或对话落盘
- Heartbeat、Janitor、Weekly compaction 在后台持续巡检、归档和压缩，让记忆越用越完整
- 先读取与当前任务相关的记忆，再在任务结束后写回，后台任务继续做巡检、归档和压缩。

// VISUAL
Create a blueprint-style circular or left-to-right closed-loop flow. The left section is "读取上下文" with small source nodes for "索引 .abstract", "长期记忆", "工作记忆", "每日日志", and "知识库". The center is an active "会话运行" block. The right section is "写回记忆" with two branches: "记忆工具" writing long-term and working memory, and "机器人 / 应用" writing daily logs. Along the bottom or side, add a maintenance lane with three compact labeled modules: "心跳巡检", "过期归档", and "周期压缩". Add a short explanatory note band at the bottom in Chinese. Use arrows, bracket labels, and a highlighted loop arrow to emphasize continuous evolution.

// LAYOUT
Layout: circular-flow
Use a dominant loop path with clearly separated read, run, write, and maintain stages. Keep labels short and highly legible for beginners.
