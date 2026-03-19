<div align="center">

# Teamclaw

**An open-source desktop AI team that never sleeps.**

[![Release](https://img.shields.io/github/v/release/zhangdszq/teamclaw?style=flat-square)](https://github.com/zhangdszq/teamclaw/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](#quick-start)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)

[简体中文](README_ZH.md)

![Teamclaw](assets/splash-1.jpg)

</div>

---

Teamclaw is an open-source desktop application for building, coordinating, and operating a team of AI assistants on your own machine. Each assistant has its own persona, memory, skills, tools, and IM bot bindings, so you can run specialized agents around the clock instead of squeezing everything into a single chat.

It is built around **Anthropic Claude**. If you already use [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Teamclaw can reuse its local configuration and MCP setup, but Claude Code is optional rather than required.

## Quick Start

### Use a release build

1. Download the latest package from [Releases](https://github.com/zhangdszq/teamclaw/releases).
2. Launch Teamclaw and finish the onboarding flow.
3. Configure Anthropic access inside Teamclaw, or optionally reuse an existing Claude Code setup.

### Run from source

Prerequisites:

- [Bun](https://bun.sh/)
- Node.js 20+ recommended for packaging and sidecar builds
- `npm` only if you want to package the app or build the `src-api` sidecar
- Optional: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) if you want Teamclaw to reuse its local configuration and MCP servers

For everyday local development, Bun is enough:

```bash
bun install
bun run dev
```

Useful verification commands:

```bash
bun run test
bun run build
```

Release packaging commands also build the bundled sidecar API and CLI:

```bash
bun run dist:mac
bun run dist:win
bun run dist:linux
```

## Features

### Multi-Assistant System

Create multiple AI assistants, each with its own identity:

- Custom persona: name, avatar, personality, core values, cognitive style
- Per-assistant skills and MCP servers (Model Context Protocol tool servers)
- Scoped memory: each assistant keeps isolated memory
- Heartbeat: periodic self-check with adaptive intervals

### Conversational AI

- Streaming output with reasoning visualization
- Markdown rendering with syntax-highlighted code
- Collapsible tool call process groups
- Permission control for sensitive tool calls
- Image and file input via paste, select, or drag-and-drop
- Session management with SQLite persistence

### IM Bot Integration

![IM Bot Integration](assets/splash-2.jpg)

Connect any assistant to your team's messaging platform:

| Platform | Capabilities |
|----------|-------------|
| **DingTalk** | Private and group chat, AI streaming cards, media messages, proactive push, allowlist policies |
| **Telegram** | Private and group chat, @mention control, proactive push, proxy support |
| **Feishu / Lark** | Group chat, proactive push, auto-reconnect |

Each bot inherits the assistant's persona, skills, and memory. DM/group policies and owner-based proactive notifications are supported.

### Memory System

Multi-layer structured memory:

| Layer | Purpose |
|-------|---------|
| L0 - Abstract | Root index for fast context retrieval |
| L1 - Insights | Monthly distilled insights and structured lessons |
| L2 - Daily | Raw daily logs and session records |
| MEMORY.md | Long-term memory with P0/P1/P2 lifecycle |
| SESSION-STATE.md | Cross-session working buffer |
| SOPs | Self-growing standard operating procedures |
| Scoped | Per-assistant isolated memory |

### Knowledge Base

- Auto-extraction of experience candidates from completed sessions
- Review workflow: `draft -> verified -> archived`
- Manual knowledge documents
- AI-powered structured refinement for scenario, steps, result, and risk

### Scheduler and Automation

![Scheduler & Automation](assets/splash-5.jpg)

| Type | Description |
|------|-------------|
| Once | Run at a specific time |
| Interval | Repeat every N minutes, hours, days, or weeks |
| Daily | Fixed time, configurable days of week |
| Heartbeat | Periodic self-check with adaptive intervals |
| Hook | Triggered by `startup` or `session.complete` events |

Hook tasks support filters by assistant, title pattern, and error-only triggers.

### Long-Term Goals

Define persistent objectives pursued across multiple sessions:

- Configurable retry interval and max runs
- Session-linked progress log with summaries and next steps
- Auto-pause after consecutive failures
- Completion notifications via events

### SOP / Hands Workflow

Structured multi-stage workflows defined in `HAND.toml`:

- ReactFlow-based visual workflow editor
- Per-stage goals, checklist items, tools, and MCP servers
- AI generation from natural language descriptions
- Plan table with `pending`, `in_progress`, `completed`, and `failed` states

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

### Skills and MCP Management

- Skill catalog with categories and tags
- GUI for adding, configuring, and removing MCP servers
- Per-assistant skill assignment
- AI-powered skill tag suggestions

### Quick Window

- Global shortcut (default `Alt+Space`) for floating input anywhere
- Assistant and skill picker
- Seamless handoff to the main window

### Desktop Experience

- Native Electron app for macOS, Windows, and Linux
- System tray with click-to-restore
- Platform-adaptive title bar
- Built-in auto-updater
- Onboarding wizard for first-run setup
- Environment validation and connectivity checks

## Configuration

Teamclaw can reuse configuration from Claude Code when it is present:

```
~/.claude/settings.json
```

This reuse is optional. Anthropic credentials configured inside Teamclaw take priority over `~/.claude/settings.json`, and MCP servers plus related settings from Claude Code can also be reused when available.

## Contributing

Issues and pull requests are welcome.

For larger changes, please open an issue or discussion first so the direction stays aligned. As the project is being opened up, you will still see some legacy names such as `vk-cowork` and `AI Team` in parts of the codebase and packaging. They are historical internal identifiers and will be cleaned up incrementally.

## Architecture

| Layer | Technology |
|-------|-----------|
| Framework | Electron 39 |
| Frontend | React 19, Tailwind CSS 4 |
| State | Zustand |
| Database | better-sqlite3 (WAL mode) |
| AI | Claude Agent SDK |
| API | Hono (embedded) |
| Build | Vite, electron-builder |

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
