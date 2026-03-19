<div align="center">

# Teamclaw

**开源的桌面 AI 团队，永不下班。**

[![Release](https://img.shields.io/github/v/release/zhangdszq/teamclaw?style=flat-square)](https://github.com/zhangdszq/teamclaw/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square)](#快速开始)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)

[English](README.md)

![Teamclaw](assets/splash-1.jpg)

</div>

---

Teamclaw 是一个开源桌面应用，让你在本地组建、协作和运营一支 AI 助理团队。每个助理都有独立的人设、记忆、技能、工具和 IM 机器人绑定，你不必把所有事情都塞进一个对话里，而是可以让多个专长不同的代理 7x24 持续工作。

它当前基于 **Anthropic Claude**。如果你已经在用 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)，Teamclaw 可以复用它的本地配置和 MCP 设置；但 Claude Code 是可选项，不是硬性前置。

## 快速开始

### 使用发布版

1. 从 [Releases](https://github.com/zhangdszq/teamclaw/releases) 下载最新安装包。
2. 启动 Teamclaw 并完成引导配置。
3. 在 Teamclaw 内配置 Anthropic API Token，或可选复用现有 Claude Code 配置。

### 从源码运行

前置要求：

- [Bun](https://bun.sh/)
- 推荐 Node.js 20+，用于打包和 sidecar 构建
- `npm`，仅在打包应用或构建 `src-api` sidecar 时需要
- 可选：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)，仅当你希望 Teamclaw 复用其本地配置和 MCP 服务时需要

日常本地开发只需要 Bun：

```bash
bun install
bun run dev
```

常用验证命令：

```bash
bun run test
bun run build
```

发布打包命令会同时构建内置 sidecar API 和 CLI：

```bash
bun run dist:mac
bun run dist:win
bun run dist:linux
```

## 功能

### 多助理系统

创建多个 AI 助理，各自拥有独立身份：

- 自定义人设：名称、头像、性格、核心价值观、认知风格
- 按助理分配技能和 MCP 服务器（Model Context Protocol 工具服务）
- 隔离记忆：每个助理拥有独立记忆空间
- 心跳巡检：定期自检，自适应间隔

### 对话式 AI

- 流式输出，可视化推理过程
- Markdown 渲染，语法高亮代码
- 可折叠的工具调用过程组
- 敏感工具调用的权限控制
- 图片与文件输入：粘贴、选择或拖拽
- 会话管理与 SQLite 持久化

### IM 机器人集成

![IM 机器人集成](assets/splash-2.jpg)

将任意助理接入团队通讯平台：

| 平台 | 能力 |
|------|------|
| **钉钉** | 私聊与群聊、AI 流式卡片、媒体消息、主动推送、白名单策略 |
| **Telegram** | 私聊与群聊、@提及控制、主动推送、代理支持 |
| **飞书 / Lark** | 群聊、主动推送、自动重连 |

每个机器人继承助理的人设、技能和记忆，并支持私聊/群聊策略以及 Owner 主动通知。

### 记忆系统

多层结构化记忆：

| 层级 | 用途 |
|------|------|
| L0 - 索引 | 根索引，快速进行上下文检索 |
| L1 - 洞察 | 月度提炼的洞察与结构化经验 |
| L2 - 每日 | 原始日志与会话记录 |
| MEMORY.md | 长期记忆，带 P0/P1/P2 生命周期 |
| SESSION-STATE.md | 跨会话工作缓冲区 |
| SOPs | 自增长标准操作流程 |
| 作用域记忆 | 按助理隔离 |

### 知识库

- 从已完成会话自动抽取经验候选
- 审核流程：`draft -> verified -> archived`
- 手动知识文档管理
- AI 结构化精炼：场景、步骤、结果、风险

### 调度与自动化

![调度与自动化](assets/splash-5.jpg)

| 类型 | 说明 |
|------|------|
| 单次 | 在指定时间运行 |
| 间隔 | 每 N 分钟、小时、天或周重复 |
| 每日 | 固定时间，可配置星期几 |
| 心跳 | 定期自检，自适应间隔 |
| Hook | 由 `startup` 或 `session.complete` 事件触发 |

Hook 任务支持按助理、标题模式和仅错误触发过滤。

### 长期目标

定义跨多个会话持续推进的目标：

- 可配置重试间隔和最大运行次数
- 关联会话的进度日志，包含总结和下一步
- 连续失败后自动暂停
- 完成时通过事件通知

### SOP / Hands 工作流

以 `HAND.toml` 定义多阶段结构化工作流：

- 基于 ReactFlow 的可视化工作流编辑器
- 每阶段包含目标、检查项、工具和 MCP 服务器
- 支持从自然语言描述生成
- 计划表集成 `pending`、`in_progress`、`completed`、`failed` 状态

### 内置 MCP 工具

每个助理都可以使用共享 MCP 工具：

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
- 通过 GUI 添加、配置和删除 MCP 服务器
- 按助理分配技能
- AI 自动推荐技能标签

### 快速窗口

- 全局快捷键（默认 `Alt+Space`），可随时调起悬浮输入框
- 助理与技能选择器
- 无缝切换到主窗口

### 桌面体验

- 原生 Electron 应用，支持 macOS、Windows、Linux
- 系统托盘，点击恢复
- 平台自适应标题栏
- 内置自动更新
- 提供首次启动引导
- 提供环境检查和连通性校验

## 配置

当本机存在 Claude Code 配置时，Teamclaw 可以直接复用：

```
~/.claude/settings.json
```

这种复用是可选的，不是必需的。你直接在 Teamclaw 里填写的 Anthropic 凭证会优先于 `~/.claude/settings.json`；如果本机已有 Claude Code 的 MCP 配置，也可以一并复用。

## 参与贡献

欢迎提交 Issue 和 Pull Request。

如果是较大改动，建议先开 Issue 或 Discussion 对齐方向。项目刚开始对外开源，代码和打包配置里仍能看到 `vk-cowork`、`AI Team` 等历史命名，它们是内部阶段遗留标识，后续会逐步统一。

## 架构

| 层级 | 技术 |
|------|------|
| 框架 | Electron 39 |
| 前端 | React 19, Tailwind CSS 4 |
| 状态管理 | Zustand |
| 数据库 | better-sqlite3（WAL 模式） |
| AI | Claude Agent SDK |
| API | Hono（内嵌） |
| 构建 | Vite, electron-builder |

## 许可证

本项目采用 Apache License 2.0 开源，详见 [LICENSE](LICENSE)。
