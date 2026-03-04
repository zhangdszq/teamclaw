
<div align="center">

# Teamclaw

[![Version](https://img.shields.io/badge/version-0.0.62-blue.svg)](https://github.com/zhangdszq/teamclaw/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://github.com/zhangdszq/teamclaw/releases)

[简体中文](README_ZH.md)

</div>

## ❤️ Collaboration

[![MiniMax](assets/partners/minimax_banner.jpg)](https://platform.minimax.io/subscribe/coding-plan?code=5q2B2ljfdw&source=link)

MiniMax-M2.1 is an open-source SOTA model that excels at coding, navigating digital environments, and handling long, multi-step tasks.
With VK Cowork, M2.1 takes a concrete step toward our long-term vision of general-purpose productivity, making advanced AI capabilities accessible to everyone.

[Click ](https://platform.minimax.io/subscribe/coding-plan?code=5q2B2ljfdw&source=link) to get an exclusive 12% off the MiniMax Coding Plan

---

## About

A **desktop AI team** that goes far beyond a simple GUI wrapper — it is a full-featured autonomous agent platform with multi-assistant orchestration, IM bot integration, scheduled automation, memory & knowledge management, and SOP workflows.

Fully compatible with **Claude Code** configuration (`~/.claude/settings.json`), and supports both **Anthropic Claude** and **OpenAI Codex** as AI providers.

> Not just a GUI.
> A team of AI collaboration partners — running 24/7, across desktop and IM channels.

An example of organizing a local folder:


https://github.com/user-attachments/assets/8ce58c8b-4024-4c01-82ee-f8d8ed6d4bba


---

## ✨ Feature Overview

### 🤖 Multi-Assistant System

Create and manage multiple AI assistants, each with its own identity and capabilities:

- **Custom persona** — name, avatar, personality, core values, cognitive style
- **Per-assistant skills** — assign different skill sets and MCP servers to each assistant
- **Provider choice** — Claude (Anthropic) or Codex (OpenAI) per assistant
- **Dedicated memory** — each assistant has its own scoped memory space
- **Heartbeat** — configurable periodic self-check with adaptive intervals and suppression rules

---

### 💬 Conversational AI

- **Streaming output** — token-by-token rendering with reasoning visualization
- **Markdown rendering** — syntax-highlighted code, tables, images
- **Tool call visualization** — collapsible process groups with status indicators
- **Permission control** — explicit approval for sensitive actions, per-tool allow/deny
- **Image & file input** — paste, select, or drag-and-drop images and files into conversations
- **Session management** — create, resume, delete; custom working directories; SQLite persistence

---

### 🤝 IM Bot Integration

Turn any assistant into a chatbot on your team's messaging platform:

| Platform | Capabilities |
|----------|-------------|
| **DingTalk (钉钉)** | Private & group chat, AI streaming cards, media messages, proactive push, allowlist policies |
| **Telegram** | Private & group chat, @mention control, proactive push, proxy support |
| **Feishu (飞书/Lark)** | Group chat, proactive push, auto-reconnect |

Each bot inherits the assistant's persona, skills, and memory. Configure DM/group policies and owner IDs for proactive notifications.

---

### 🧠 Memory System

A structured, multi-layer memory architecture:

| Layer | Purpose |
|-------|---------|
| **L0 — Abstract** | Root index for fast context retrieval |
| **L1 — Insights & Lessons** | Monthly distilled insights and structured learnings |
| **L2 — Daily** | Raw daily logs and session records |
| **MEMORY.md** | Long-term memory with lifecycle (P0/P1/P2 priority) |
| **SESSION-STATE.md** | Cross-session working buffer |
| **SOPs** | Self-growing standard operating procedures |
| **Scoped Memory** | Per-assistant isolated memory under `assistants/{id}/` |

---

### 📚 Knowledge Base

- **Experience candidates** — automatically extracted from completed sessions via AI
- **Review workflow** — draft → verified → archived lifecycle
- **Knowledge documents** — manually create and manage reference docs
- **AI refinement** — structured extraction of title, scenario, steps, result, and risk

---

### ⏰ Scheduler & Automation

| Type | Description |
|------|-------------|
| **Once** | Run at a specific time |
| **Interval** | Repeat every N minutes/hours/days/weeks |
| **Daily** | Fixed time, configurable days of week |
| **Heartbeat** | Periodic self-check with adaptive intervals |
| **Hook** | Triggered by events: `startup`, `session.complete` |

Tasks can target specific assistants and working directories. Hook tasks support filters by assistant, title pattern, and error-only triggers.

---

### 🎯 Long-Term Goals

Define persistent objectives that the AI pursues across multiple sessions:

- **Auto-retry** — configurable retry interval and max runs
- **Progress tracking** — session-linked progress log with summaries and next steps
- **Error handling** — auto-pause after consecutive failures
- **Completion notification** — event-driven alerts when goals are achieved

---

### 📋 SOP / Hands Workflow

Structured multi-stage workflows defined in HAND.toml:

- **Visual editor** — ReactFlow-based workflow graph
- **Stage management** — each stage has goals, checklist items, tools, and MCP servers
- **AI generation** — describe a workflow in natural language, AI generates the HAND.toml
- **Plan table integration** — plan items with pending/in_progress/completed/failed states
- **MCP tools** — `upsert_plan_item`, `complete_plan_item`, `fail_plan_item`

---

### 🔧 Built-in MCP Tools

Every assistant has access to a rich set of shared MCP tools:

| Category | Tools |
|----------|-------|
| **Scheduling** | `create_scheduled_task`, `list_scheduled_tasks`, `delete_scheduled_task` |
| **Web** | `web_search`, `web_fetch` |
| **News** | `news_latest`, `news_search` |
| **Social** | `twitter_user_tweets`, `twitter_search` |
| **SOP** | `save_sop`, `list_sops`, `read_sop`, `search_sops` |
| **Memory** | `distill_memory`, `read_document`, `append_daily_memory` |
| **Desktop** | `take_screenshot`, `screen_analyze`, `desktop_control`, `clipboard` |
| **Process** | `process_control` |
| **System** | `system_info` |
| **Plan** | `upsert_plan_item`, `complete_plan_item`, `fail_plan_item` |
| **Notification** | `send_notification` (DingTalk / Telegram / Feishu) |

---

### 🧩 Skills & MCP Management

- **Skill catalog** — browse, install, and manage skills with categories and tags
- **MCP servers** — add, configure, and remove MCP servers from the GUI
- **Per-assistant assignment** — assign specific skills and skill tags to each assistant
- **Auto skill-tag generation** — AI suggests relevant tags based on persona and skills

---

### ⚡ Quick Window

- **Global shortcut** (configurable, default `Alt+Space`) — summon a floating input window from anywhere
- **Assistant selector** — pick which assistant handles the task
- **Skill picker** — choose skills for the quick task
- **Seamless handoff** — expand to full main window when needed

---

### 🖥️ Desktop Experience

- **Native app** — Electron-based, runs on macOS, Windows, and Linux
- **System tray** — minimize to tray, click to restore
- **Custom title bar** — platform-adaptive (traffic lights on macOS, window controls on Windows)
- **Auto-updater** — built-in update mechanism via electron-updater
- **Onboarding wizard** — guided setup for Anthropic and Codex providers
- **Environment check** — validates Claude CLI, Node.js, API connectivity

---

## 🔁 Compatible with Claude Code & Codex

Teamclaw shares configuration with Claude Code:

```text
~/.claude/settings.json
```

This means: same API keys, base URL, models, MCP servers, and skills.

Additionally supports **OpenAI Codex** with OAuth login and **Google OAuth** for optional authentication.

---

## 🚀 Quick Start

### Option 1: Download a Release

👉 [Go to Releases](https://github.com/zhangdszq/teamclaw/releases)

---

### Option 2: Build from Source

#### Prerequisites

- [Bun](https://bun.sh/) or Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

```bash
# Clone the repository
git clone https://github.com/zhangdszq/teamclaw.git
cd teamclaw

# Install dependencies
bun install

# Run in development mode
bun run dev

# Or build production binaries
bun run dist:mac    # macOS
bun run dist:win    # Windows
bun run dist:linux  # Linux
```

---

## 🧩 Architecture

| Layer | Technology |
|-------|-----------|
| Framework | Electron 39 |
| Frontend | React 19, Tailwind CSS 4 |
| State | Zustand |
| Database | better-sqlite3 (WAL mode) |
| AI | Claude Agent SDK, OpenAI Codex SDK |
| API | Hono (embedded, port 2620) |
| Build | Vite, electron-builder |

---

## 🛠 Development

```bash
# Start development server (hot reload)
bun run dev

# Type checking / build
bun run build

# Lint
bun run lint
```

---

## 🤝 Contributing

Pull requests are welcome.

1. Fork this repository
2. Create your feature branch
3. Commit your changes
4. Open a Pull Request

---

## License

MIT
