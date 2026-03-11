# Memory Module Deck Analysis

**Topic**: 记忆模块（Memory Module）
**Topic Slug**: `memory-module`
**Content Type**: 技术架构介绍 / 系统说明
**Source**: `tech-doc/memory-module.md`
**Audience**: beginners
**Language**: zh
**Recommended Style**: blueprint
**Alternative Style**: editorial-infographic
**Recommended Slide Count**: 2
**Detected Length**: 1897 words / 18526 chars

## Core Message

记忆模块把本地文件、索引、知识库和多种接入入口连接起来，让 Agent 能跨会话持续获得上下文并把新经验写回系统。

## Supporting Points

1. 记忆模块解决跨会话持久化问题，承载用户偏好、项目决策、近期上下文和工作现场。
2. 它以本地文件系统为核心，按共享层、私有层和知识层组织数据。
3. 新会话会先通过 `buildSmartMemoryContext()` 读取记忆，再由 MCP、Bot 和 App 会话把结果写回。
4. `.abstract`、Heartbeat、Janitor 和 Weekly Compaction 让系统可以被检索、巡检、归档和持续压缩。

## Audience Notes

- 受众为初学者，需要减少实现细节，强调“是什么、为什么、怎么流动”。
- 重点是建立系统心智模型，而不是覆盖全部 API 或全部文件格式。
- 视觉上应优先使用结构图和流程图，少量精炼文字辅助理解。

## Content Signals

- architecture
- system design
- technical documentation
- workflow
- local file persistence
- shared/private memory

## Keep / Simplify / Omit

### Keep

- 模块目标与定位
- 共享/私有/知识层磁盘结构
- 读路径与写路径
- 后台任务的整体作用

### Simplify

- 把具体函数、接口、目录细节收敛为更易懂的概念块
- 把三条写路径合并成一张闭环图
- 把多个后台任务压缩为“巡检 / 归档 / 压缩”三个动作

### Omit

- 详细接口枚举
- 迁移脚本与兼容层的细枝末节
- 各章节中的完整 mermaid 细节

## Visual Opportunity Map

- Slide 1 must visualize: 模块目标 + 结构分层 + 三类主要载体
- Slide 2 must visualize: 读路径 + 写路径 + 后台维护闭环

## Call To Action

读者看完后应该能回答三个问题：

1. 记忆模块在系统中解决什么问题？
2. 它把哪些内容存到哪里？
3. 新会话如何读取记忆，结果又如何写回记忆？
