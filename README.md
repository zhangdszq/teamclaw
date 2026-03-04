<div align="center">

# Teamclaw

**Your desktop AI team that never sleeps.**

[![Release](https://img.shields.io/github/v/release/zhangdszq/teamclaw?style=flat-square)](https://github.com/zhangdszq/teamclaw/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](#quick-start)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

[简体中文](README_ZH.md)

![Teamclaw](assets/splash-1.jpg)

</div>

---

Teamclaw is a desktop application that lets you build a team of AI assistants. Each assistant has its own persona, memory, skills, and can be connected to messaging platforms like DingTalk, Telegram, and Feishu — operating autonomously around the clock.

It is fully compatible with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) configuration and supports both **Anthropic Claude** and **OpenAI Codex** as AI providers.

## Quick Start

**Download a release:**
[github.com/zhangdszq/teamclaw/releases](https://github.com/zhangdszq/teamclaw/releases)

**Or build from source:**

```bash
git clone https://github.com/zhangdszq/teamclaw.git && cd teamclaw
bun install
bun run dev
```

Build for production:

```bash
bun run dist:mac      # macOS (arm64)
bun run dist:win      # Windows (x64)
bun run dist:linux    # Linux (x64)
```

Prerequisites: [Bun](https://bun.sh/) or Node.js 18+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed.

---

## Features

### Multi-Assistant System

Create multiple AI assistants, each with its own identity:

- Custom persona — name, avatar, personality, core values, cognitive style
- Per-assistant skills and MCP servers
- Independent provider choice — Claude or Codex per assistant
- Scoped memory — each assistant maintains isolated memory
- Heartbeat — periodic self-check with adaptive intervals

### Conversational AI

- Streaming output with reasoning visualization
- Markdown rendering with syntax-highlighted code
- Collapsible tool call process groups
- Permission control — approve or deny sensitive tool calls
- Image and file input via paste, select, or drag-and-drop
- Session management with SQLite persistence

### IM Bot Integration

![IM Bot Integration](assets/splash-2.jpg)

Connect any assistant to your team's messaging platform:

| Platform | Capabilities |
|----------|-------------|
| **DingTalk** | Private & group chat, AI streaming cards, media messages, proactive push, allowlist policies |
| **Telegram** | Private & group chat, @mention control, proactive push, proxy support |
| **Feishu / Lark** | Group chat, proactive push, auto-reconnect |

Each bot inherits the assistant's persona, skills, and memory. Supports DM/group policies and owner-based proactive notifications.

### Memory System

Multi-layer structured memory:

| Layer | Purpose |
|-------|---------|
| L0 — Abstract | Root index for fast context retrieval |
| L1 — Insights | Monthly distilled insights and structured lessons |
| L2 — Daily | Raw daily logs and session records |
| MEMORY.md | Long-term memory with P0/P1/P2 lifecycle |
| SESSION-STATE.md | Cross-session working buffer |
| SOPs | Self-growing standard operating procedures |
| Scoped | Per-assistant isolated memory |

### Knowledge Base

- Auto-extraction of experience candidates from completed sessions
- Review workflow: draft → verified → archived
- Manual knowledge documents
- AI-powered structured refinement (scenario, steps, result, risk)

### Scheduler & Automation

![Scheduler & Automation](assets/splash-5.jpg)

| Type | Description |
|------|-------------|
| Once | Run at a specific time |
| Interval | Repeat every N minutes/hours/days/weeks |
| Daily | Fixed time, configurable days of week |
| Heartbeat | Periodic self-check with adaptive intervals |
| Hook | Triggered by `startup` or `session.complete` events |

Hook tasks support filters by assistant, title pattern, and error-only triggers.

### Long-Term Goals

Define persistent objectives pursued across multiple sessions:

- Configurable retry interval and max runs
- Session-linked progress log with summaries and next steps
- Auto-pause after consecutive failures
- Completion notification via events

### SOP / Hands Workflow

Structured multi-stage workflows defined in HAND.toml:

- ReactFlow-based visual workflow editor
- Per-stage goals, checklist items, tools, and MCP servers
- AI generation from natural language descriptions
- Plan table with pending/in_progress/completed/failed states

### Built-in MCP Tools

Every assistant has access to shared MCP tools:

| Category | Tools |
|----------|-------|
| Scheduling | `create_scheduled_task`, `list_scheduled_tasks`, `delete_scheduled_task` |
| Web | `web_search`, `web_fetch` |
| News | `news_latest`, `news_search` |
| Social | `twitter_user_tweets`, `twitter_search` |
| SOP | `save_sop`, `list_sops`, `read_sop`, `search_sops` |
| Memory | `distill_memory`, `read_document`, `append_daily_memory` |
| Desktop | `take_screenshot`, `screen_analyze`, `desktop_control`, `clipboard` |
| Process | `process_control` |
| System | `system_info` |
| Plan | `upsert_plan_item`, `complete_plan_item`, `fail_plan_item` |
| Notification | `send_notification` (DingTalk / Telegram / Feishu) |

### Skills & MCP Management

- Skill catalog with categories and tags
- GUI for adding, configuring, and removing MCP servers
- Per-assistant skill assignment
- AI-powered skill tag suggestions

### Quick Window

- Global shortcut (default `Alt+Space`) — floating input from anywhere
- Assistant and skill picker
- Seamless handoff to main window

### Desktop Experience

- Native Electron app — macOS, Windows, Linux
- System tray with click-to-restore
- Platform-adaptive title bar
- Built-in auto-updater
- Onboarding wizard for provider setup
- Environment validation (Claude CLI, Node.js, API connectivity)

---

## Configuration

Teamclaw shares configuration with Claude Code:

```
~/.claude/settings.json
```

Same API keys, base URL, models, MCP servers, and skills. Also supports OpenAI Codex OAuth and Google OAuth.

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Framework | Electron 39 |
| Frontend | React 19, Tailwind CSS 4 |
| State | Zustand |
| Database | better-sqlite3 (WAL mode) |
| AI | Claude Agent SDK, OpenAI Codex SDK |
| API | Hono (embedded) |
| Build | Vite, electron-builder |

---

## Development

```bash
bun run dev       # Dev server with hot reload
bun run build     # Type check and build
bun run lint      # Lint
```

---

## Contributing

1. Fork this repository
2. Create your feature branch
3. Commit your changes
4. Open a Pull Request

---

## License

MIT
