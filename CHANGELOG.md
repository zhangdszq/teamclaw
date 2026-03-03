# Changelog

All notable changes to VK-Cowork will be documented in this file.

---

## [0.0.51] - 2026-03-03 (开发中)

### 新功能
- SOP Hands 自动生成功能，支持 `smol-toml` 格式解析
- 技能目录支持分类浏览

### 修复
- **Windows 启动崩溃**：修复 tray 图标未打包导致所有 IPC handler 失效的严重问题

### 重构
- 提取 `bot-base.ts` 共享 Bot 工具模块，提升代码复用性

---

## [0.0.50] - 2026-02

### 新功能
- **SOP 自动化工作流**：基于 React Flow 的可视化工作流画布，支持 SOP 侧边栏列表
- **Goals 目标管理器**：目标设定与追踪功能
- **6551 内置 MCP 服务器**：集成 6551 平台内置 MCP 工具，扩展 Agent 能力
- **Telegram Bot**：新增 Telegram 机器人集成，支持技能名称配置
- **Google OAuth 登录**：支持 Google 账号第三方登录
- **冷启动欢迎页**：5 张插画幻灯片的启动动画
- **三层记忆架构**：长期记忆、日常记忆、会话记忆分层管理
- **Quick Window 重构**：后台会话支持，响应更快
- **助理人格深化**：认知风格、操作规范、关系字段等人格配置项
- **技能选择器重设计**：现代命令面板（Command Palette）风格
- **文件附件支持**：对话框支持拖拽批量上传文件、图片、文件夹
- **技能安装优化**：支持 curl/unzip 方式一键安装技能
- **MCP 工具全面启用**：所有 Runner 支持 MCP 工具和 Agent 探索模式
- **DingTalk 文件分析**：新增 `read_document` MCP 工具，优化钉钉标题生成

### 修复
- Bot 输入类型字段补全（userContext、cognitiveStyle、operatingGuidelines、relationship 等）
- 6551 API 响应解析修复，twitter_search 参数修正
- claudeSessionId 同步至 session store
- SopPage EdgeMarker 类型错误修复
- 多处 IPC 类型声明补全（splashSeen、coreValues、Goals）

---

## [0.0.29] - 2026-01

### 新功能
- **飞书 Bot 完整实现**：支持飞书消息收发与卡片推送
- **钉钉标题生成优化**
- 多项 UI/UX 改进与稳定性修复

---

## [0.0.27] - 2025-12

### 新功能
- Scheduler 任务调度器
- Sidebar 侧边栏
- 对话框多项交互优化

---

## [0.0.2] - 2025 早期

### 初始版本
- Electron 应用基础框架搭建
- Claude Code 集成环境配置
- 基础助理会话功能
