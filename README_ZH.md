
<div align="center">

# Teamclaw

[![Version](https://img.shields.io/badge/version-0.0.62-blue.svg)](https://github.com/zhangdszq/teamclaw/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://github.com/zhangdszq/teamclaw/releases)

[English](README.md)

</div>

## ❤️ 合作

[![MiniMax](assets/partners/minimax_banner.jpg)](https://platform.minimaxi.com/subscribe/coding-plan?code=6uFnRx7O0W&source=link)

MiniMax-M2.1 是一款开源 SOTA 模型，在编程、数字环境操作和多步骤长流程任务方面表现出色。
通过 VK Cowork，M2.1 朝着"通用生产力 AI"的愿景迈出了坚实一步，让先进的 AI 能力真正触达每个人。

[点击](https://platform.minimaxi.com/subscribe/coding-plan?code=6uFnRx7O0W&source=link)即可享受 MiniMax 编程计划专属 12% 折扣

---

## 关于

一个**桌面 AI 团队**，远不止一个简单的 GUI 壳——它是一个功能完整的自主 Agent 平台，具备多助理编排、IM 机器人集成、定时自动化、记忆与知识管理、SOP 工作流等能力。

完全兼容 **Claude Code** 配置（`~/.claude/settings.json`），同时支持 **Anthropic Claude** 和 **OpenAI Codex** 双 AI 提供商。

> 不只是 GUI。
> 一支 AI 协作团队——7×24 运行，横跨桌面与 IM 通道。

一个整理本地文件夹的例子：


https://github.com/user-attachments/assets/8ce58c8b-4024-4c01-82ee-f8d8ed6d4bba


---

## ✨ 功能概览

### 🤖 多助理系统

创建和管理多个 AI 助理，每个都有独立的身份和能力：

- **自定义人设** — 名称、头像、性格、核心价值观、认知风格
- **独立技能** — 为每个助理分配不同的技能集和 MCP 服务器
- **提供商选择** — 每个助理可独立选择 Claude（Anthropic）或 Codex（OpenAI）
- **独立记忆** — 每个助理拥有自己的隔离记忆空间
- **心跳巡检** — 可配置的定期自检，支持自适应间隔和静默规则

---

### 💬 对话式 AI

- **流式输出** — 逐 Token 渲染，可视化推理过程
- **Markdown 渲染** — 语法高亮代码、表格、图片
- **工具调用可视化** — 可折叠的过程组，带状态指示器
- **权限控制** — 敏感操作需明确批准，按工具允许/拒绝
- **图片与文件输入** — 粘贴、选择或拖拽图片和文件到对话
- **会话管理** — 创建、恢复、删除；自定义工作目录；SQLite 持久化

---

### 🤝 IM 机器人集成

将任何助理变成团队通讯平台上的聊天机器人：

| 平台 | 能力 |
|------|------|
| **钉钉** | 私聊与群聊、AI 流式卡片、媒体消息、主动推送、白名单策略 |
| **Telegram** | 私聊与群聊、@提及控制、主动推送、代理支持 |
| **飞书 / Lark** | 群聊、主动推送、自动重连 |

每个机器人继承对应助理的人设、技能和记忆。可配置私聊/群聊策略和 Owner ID 以接收主动通知。

---

### 🧠 记忆系统

结构化多层记忆架构：

| 层级 | 用途 |
|------|------|
| **L0 — 索引** | 根索引，用于快速上下文检索 |
| **L1 — 洞察与教训** | 月度提炼的洞察和结构化经验 |
| **L2 — 每日** | 原始日志和会话记录 |
| **MEMORY.md** | 长期记忆，带生命周期管理（P0/P1/P2 优先级） |
| **SESSION-STATE.md** | 跨会话工作缓冲区 |
| **SOPs** | 自增长的标准操作流程 |
| **作用域记忆** | 按助理隔离，位于 `assistants/{id}/` |

---

### 📚 知识库

- **经验候选** — 从已完成的会话中通过 AI 自动抽取
- **审核流程** — draft → verified → archived 生命周期
- **知识文档** — 手动创建和管理参考文档
- **AI 精炼** — 结构化抽取标题、场景、步骤、结果和风险

---

### ⏰ 调度与自动化

| 类型 | 说明 |
|------|------|
| **单次** | 在指定时间运行 |
| **间隔** | 每 N 分钟/小时/天/周重复 |
| **每日** | 固定时间，可配置星期几 |
| **心跳** | 定期自检，自适应间隔 |
| **Hook** | 事件触发：`startup`（启动时）、`session.complete`（会话完成时） |

任务可指定助理和工作目录。Hook 任务支持按助理、标题模式和仅错误触发进行过滤。

---

### 🎯 长期目标

定义持久性目标，AI 跨多个会话持续推进：

- **自动重试** — 可配置重试间隔和最大运行次数
- **进度追踪** — 关联会话的进度日志，包含总结和下一步计划
- **错误处理** — 连续失败后自动暂停
- **完成通知** — 目标达成时事件驱动告警

---

### 📋 SOP / Hands 工作流

以 HAND.toml 定义的结构化多阶段工作流：

- **可视化编辑器** — 基于 ReactFlow 的工作流图
- **阶段管理** — 每个阶段有目标、检查项、工具和 MCP 服务器
- **AI 生成** — 用自然语言描述工作流，AI 自动生成 HAND.toml
- **计划表集成** — 计划项支持 pending/in_progress/completed/failed 状态
- **MCP 工具** — `upsert_plan_item`、`complete_plan_item`、`fail_plan_item`

---

### 🔧 内置 MCP 工具

每个助理都可使用丰富的共享 MCP 工具集：

| 类别 | 工具 |
|------|------|
| **调度** | `create_scheduled_task`、`list_scheduled_tasks`、`delete_scheduled_task` |
| **网络** | `web_search`、`web_fetch` |
| **新闻** | `news_latest`、`news_search` |
| **社交** | `twitter_user_tweets`、`twitter_search` |
| **SOP** | `save_sop`、`list_sops`、`read_sop`、`search_sops` |
| **记忆** | `distill_memory`、`read_document`、`append_daily_memory` |
| **桌面** | `take_screenshot`、`screen_analyze`、`desktop_control`、`clipboard` |
| **进程** | `process_control` |
| **系统** | `system_info` |
| **计划** | `upsert_plan_item`、`complete_plan_item`、`fail_plan_item` |
| **通知** | `send_notification`（钉钉 / Telegram / 飞书） |

---

### 🧩 技能与 MCP 管理

- **技能目录** — 浏览、安装、管理技能，支持分类和标签
- **MCP 服务器** — 通过 GUI 添加、配置和删除 MCP 服务器
- **按助理分配** — 为每个助理指定特定技能和技能标签
- **自动标签生成** — AI 根据人设和技能自动推荐相关标签

---

### ⚡ Quick Window 快速窗口

- **全局快捷键**（可配置，默认 `Alt+Space`）— 从任何地方召唤悬浮输入窗口
- **助理选择器** — 选择由哪个助理处理任务
- **技能选择器** — 为快速任务选择技能
- **无缝切换** — 需要时可展开为完整主窗口

---

### 🖥️ 桌面体验

- **原生应用** — 基于 Electron，支持 macOS、Windows 和 Linux
- **系统托盘** — 最小化到托盘，点击恢复
- **自定义标题栏** — 平台自适应（macOS 红绿灯按钮 / Windows 窗口控件）
- **自动更新** — 内置 electron-updater 更新机制
- **引导向导** — Anthropic 和 Codex 提供商的引导式配置
- **环境检查** — 验证 Claude CLI、Node.js、API 连通性

---

## 🔁 兼容 Claude Code 与 Codex

Teamclaw 与 Claude Code 共享配置：

```text
~/.claude/settings.json
```

这意味着：相同的 API 密钥、Base URL、模型、MCP 服务器和技能。

同时支持 **OpenAI Codex** OAuth 登录和 **Google OAuth** 可选认证。

---

## 🚀 快速开始

### 方式一：下载安装包

👉 [前往 Releases 下载](https://github.com/zhangdszq/teamclaw/releases)

---

### 方式二：从源码构建

#### 前置要求

- [Bun](https://bun.sh/) 或 Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装并完成认证

```bash
# 克隆仓库
git clone https://github.com/zhangdszq/teamclaw.git
cd teamclaw

# 安装依赖
bun install

# 开发模式运行
bun run dev

# 或构建生产版本
bun run dist:mac    # macOS
bun run dist:win    # Windows
bun run dist:linux  # Linux
```

---

## 🧩 架构

| 层级 | 技术 |
|------|------|
| 框架 | Electron 39 |
| 前端 | React 19, Tailwind CSS 4 |
| 状态管理 | Zustand |
| 数据库 | better-sqlite3（WAL 模式） |
| AI | Claude Agent SDK, OpenAI Codex SDK |
| API | Hono（内嵌，端口 2620） |
| 构建 | Vite, electron-builder |

---

## 🛠 开发

```bash
# 启动开发服务器（热重载）
bun run dev

# 类型检查 / 构建
bun run build

# 代码检查
bun run lint
```

---

## 🤝 贡献

欢迎提交 PR。

1. Fork 本仓库
2. 创建你的功能分支
3. 提交更改
4. 发起 Pull Request

---

## 许可证

MIT
