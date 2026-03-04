<div align="center">

# Teamclaw

**永不下班的桌面 AI 团队。**

[![Release](https://img.shields.io/github/v/release/zhangdszq/teamclaw?style=flat-square)](https://github.com/zhangdszq/teamclaw/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](#快速开始)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

[English](README.md)

![Teamclaw](screenshots/02-main-page.png)

</div>

---

Teamclaw 是一个桌面应用，让你组建一支 AI 助理团队。每个助理有独立的人设、记忆、技能，并可接入钉钉、Telegram、飞书等通讯平台，7×24 自主运行。

完全兼容 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 配置，同时支持 **Anthropic Claude** 和 **OpenAI Codex** 双 AI 引擎。

## 快速开始

**下载安装包：**
[github.com/zhangdszq/teamclaw/releases](https://github.com/zhangdszq/teamclaw/releases)

**从源码构建：**

```bash
git clone https://github.com/zhangdszq/teamclaw.git && cd teamclaw
bun install
bun run dev
```

构建生产版本：

```bash
bun run dist:mac      # macOS (arm64)
bun run dist:win      # Windows (x64)
bun run dist:linux    # Linux (x64)
```

前置要求：[Bun](https://bun.sh/) 或 Node.js 18+，已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。

---

## 功能

### 多助理系统

创建多个 AI 助理，各自拥有独立身份：

- 自定义人设 — 名称、头像、性格、核心价值观、认知风格
- 按助理分配技能和 MCP 服务器
- 独立选择引擎 — 每个助理可选 Claude 或 Codex
- 隔离记忆 — 每个助理独立的记忆空间
- 心跳巡检 — 定期自检，自适应间隔

### 对话式 AI

- 流式输出，可视化推理过程
- Markdown 渲染，语法高亮代码
- 可折叠的工具调用过程组
- 权限控制 — 敏感工具调用需逐条审批
- 图片与文件输入：粘贴、选择或拖拽
- 会话管理，SQLite 持久化

### IM 机器人集成

将任意助理接入团队通讯平台：

| 平台 | 能力 |
|------|------|
| **钉钉** | 私聊与群聊、AI 流式卡片、媒体消息、主动推送、白名单策略 |
| **Telegram** | 私聊与群聊、@提及控制、主动推送、代理支持 |
| **飞书 / Lark** | 群聊、主动推送、自动重连 |

每个机器人继承助理的人设、技能和记忆。支持私聊/群聊策略及 Owner 主动通知。

### 记忆系统

多层结构化记忆：

| 层级 | 用途 |
|------|------|
| L0 — 索引 | 根索引，快速上下文检索 |
| L1 — 洞察 | 月度提炼的洞察和结构化教训 |
| L2 — 每日 | 原始日志和会话记录 |
| MEMORY.md | 长期记忆，P0/P1/P2 生命周期 |
| SESSION-STATE.md | 跨会话工作缓冲区 |
| SOPs | 自增长标准操作流程 |
| 作用域记忆 | 按助理隔离 |

### 知识库

- 从已完成会话自动抽取经验候选
- 审核流程：draft → verified → archived
- 手动知识文档管理
- AI 结构化精炼（场景、步骤、结果、风险）

### 调度与自动化

| 类型 | 说明 |
|------|------|
| 单次 | 指定时间运行 |
| 间隔 | 每 N 分钟/小时/天/周重复 |
| 每日 | 固定时间，可选星期几 |
| 心跳 | 定期自检，自适应间隔 |
| Hook | 由 `startup` 或 `session.complete` 事件触发 |

Hook 任务支持按助理、标题模式和仅错误触发过滤。

### 长期目标

定义跨多个会话持续推进的目标：

- 可配置重试间隔和最大运行次数
- 关联会话的进度日志，含总结和下一步
- 连续失败后自动暂停
- 完成时事件通知

### SOP / Hands 工作流

以 HAND.toml 定义的多阶段结构化工作流：

- 基于 ReactFlow 的可视化工作流编辑器
- 每阶段含目标、检查项、工具和 MCP 服务器
- 自然语言描述，AI 自动生成
- 计划表集成，pending/in_progress/completed/failed 状态

### 内置 MCP 工具

每个助理共享的工具集：

| 类别 | 工具 |
|------|------|
| 调度 | `create_scheduled_task`、`list_scheduled_tasks`、`delete_scheduled_task` |
| 网络 | `web_search`、`web_fetch` |
| 新闻 | `news_latest`、`news_search` |
| 社交 | `twitter_user_tweets`、`twitter_search` |
| SOP | `save_sop`、`list_sops`、`read_sop`、`search_sops` |
| 记忆 | `distill_memory`、`read_document`、`append_daily_memory` |
| 桌面 | `take_screenshot`、`screen_analyze`、`desktop_control`、`clipboard` |
| 进程 | `process_control` |
| 系统 | `system_info` |
| 计划 | `upsert_plan_item`、`complete_plan_item`、`fail_plan_item` |
| 通知 | `send_notification`（钉钉 / Telegram / 飞书） |

### 技能与 MCP 管理

- 技能目录，支持分类和标签
- GUI 添加、配置、删除 MCP 服务器
- 按助理分配技能
- AI 自动推荐技能标签

### 快速窗口

- 全局快捷键（默认 `Alt+Space`）— 随时召唤悬浮输入框
- 助理和技能选择器
- 无缝切换到主窗口

### 桌面体验

- 原生 Electron 应用 — macOS、Windows、Linux
- 系统托盘，点击恢复
- 平台自适应标题栏
- 内置自动更新
- 引导向导配置引擎
- 环境检查（Claude CLI、Node.js、API 连通性）

---

## 配置

Teamclaw 与 Claude Code 共享配置：

```
~/.claude/settings.json
```

相同的 API 密钥、Base URL、模型、MCP 服务器和技能。同时支持 OpenAI Codex OAuth 和 Google OAuth。

---

## 架构

| 层级 | 技术 |
|------|------|
| 框架 | Electron 39 |
| 前端 | React 19, Tailwind CSS 4 |
| 状态管理 | Zustand |
| 数据库 | better-sqlite3（WAL 模式） |
| AI | Claude Agent SDK, OpenAI Codex SDK |
| API | Hono（内嵌） |
| 构建 | Vite, electron-builder |

---

## 开发

```bash
bun run dev       # 开发服务器，热重载
bun run build     # 类型检查与构建
bun run lint      # 代码检查
```

---

## 贡献

1. Fork 本仓库
2. 创建功能分支
3. 提交更改
4. 发起 Pull Request

---

## 许可证

MIT
