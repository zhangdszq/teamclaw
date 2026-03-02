# VVIP EduCare 领域知识库

## 1. Zoom API 操作参考

### 创建固定课程链接（Recurring Meeting, No Fixed Time）

```
POST https://api.zoom.us/v2/users/me/meetings
Authorization: Bearer {access_token}

{
  "topic": "{student_name} - VK VVIP English Course",
  "type": 3,  // Recurring meeting with no fixed time
  "settings": {
    "join_before_host": true,
    "waiting_room": false,
    "auto_recording": "cloud",
    "meeting_authentication": false
  }
}
```

### 获取云端录制

```
GET https://api.zoom.us/v2/meetings/{meetingId}/recordings
```

录制文件下载需使用 `download_url` + `?access_token={token}`，token 有效期 24 小时。

### Server-to-Server OAuth Token 获取

```
POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id={ZOOM_ACCOUNT_ID}
Authorization: Basic base64({ZOOM_CLIENT_ID}:{ZOOM_CLIENT_SECRET})
```

## 2. 飞书文档 API 操作参考

### 创建文件夹

```
POST https://open.feishu.cn/open-apis/drive/v1/files/create_folder
{
  "name": "{student_name} VVIP 学习档案",
  "folder_token": "{parent_folder_token}"
}
```

### 上传文件（课程回放）

分片上传适用于大文件（>20MB 的视频回放）：
1. `POST /open-apis/drive/v1/medias/upload_all` (小文件)
2. `POST /open-apis/drive/v1/medias/upload_prepare` → `upload_part` → `upload_finish` (大文件)

### 创建文档

```
POST https://open.feishu.cn/open-apis/docx/v1/documents
{
  "title": "2026年3月 月度学习报告 - {student_name}",
  "folder_token": "{monthly_report_folder_token}"
}
```

## 3. 教材体系参考

### Cambridge Unlock 系列

| 级别 | CEFR | 适合年级 | 核心能力 |
|------|------|----------|----------|
| Unlock 1 | A1 | G4-G5 | 基础听说读写 |
| Unlock 2 | A2 | G5-G6 | 日常交际 |
| Unlock 3 | B1 | G7-G8 | 学术英语入门、批判性思维 |
| Unlock 4 | B2 | G8-G9 | 学术写作、演讲逻辑 |
| Unlock 5 | C1 | G10+ | 高阶学术英语 |

### 课程单元结构（以 Unlock 3 为例）

每单元包含：
- **Watch and Listen** — 视频导入
- **Reading** — 学术阅读 + 阅读策略
- **Critical Thinking** — 思维框架练习
- **Grammar** — 语法点（与单元主题整合）
- **Writing** — 学术写作任务
- **Vocabulary** — 核心词汇 + 学术词汇表（AWL）

## 4. 标化考试对标

### 雅思分数与能力矩阵

| 雅思 | CEFR | 典型能力描述 |
|------|------|------------|
| 5.0-5.5 | B1+ | 能应对日常话题但学术场景吃力 |
| 6.0-6.5 | B2 | 能理解复杂文本，参与学术讨论 |
| 7.0-7.5 | C1 | 流利准确表达，处理高阶学术任务 |
| 8.0+ | C2 | 接近母语水平 |

### UWC 面试评估维度

1. **学术潜力** — 好奇心、批判性思维、学习能力
2. **多元文化意识** — 对不同文化的理解和尊重
3. **社区服务** — 主动服务社区的经历
4. **个人品质** — 韧性、领导力、团队协作
5. **英语能力** — 口语表达的逻辑性和流利度

## 5. AI 补位资源库

### 听力推荐源

| 资源 | 难度 | 时长 | 适合 |
|------|------|------|------|
| BBC 6 Minute English | B1-B2 | 6 min | 日常话题泛听 |
| BBC Learning English | A2-B2 | 3-10 min | 分级精听 |
| TED-Ed | B1-C1 | 5 min | 学术话题 + 动画 |
| Crash Course | B2-C1 | 10-15 min | 学科知识英语 |
| VOA Learning English | A2-B1 | 5-10 min | 慢速新闻 |

### 词汇工具

- **Quizlet** — 创建课程配套词汇卡组
- **Vocabulary.com** — 语境化词汇练习
- **AWL Highlighter** — 学术词汇表检测工具

### 阅读推荐源

| 资源 | 难度 | 类型 |
|------|------|------|
| Newsela | A2-C1 | 分级新闻（可调难度） |
| ReadWorks | B1-B2 | 学术阅读 + 理解题 |
| CommonLit | B1-C1 | 文学与非虚构 |
| National Geographic Kids | A2-B1 | 科学主题 |

## 6. 沟通话术模板

### 课前提醒（T-1 温馨版）

```
{parent_name}，明天晚上 {time} 是 {foreign_teacher} 老师的课哦 📚
课前资料已发到群里，{student_name} 可以先看一下预习词汇表~
记得提前 5 分钟进入 Zoom 测试一下设备 🎧
```

### 课前提醒（T-0 行动版）

```
{student_name}，今晚 {time} 上课啦 💪
Zoom 链接：{zoom_link}
记得提前5分钟进入，戴好耳机~
```

### 课后反馈（表扬+改进）

```
{parent_name}，{student_name} 今天课程反馈来啦 ✨

🌟 亮点：
{praise_points}

📈 成长空间 + 我们的方案：
{improvement_with_plan}

📝 课后任务：
{homework}

有任何问题随时沟通～
```

### 月度报告开头

```
{parent_name}，{student_name} {month}月学习报告 📊

本月共完成 {lesson_count} 节课，出勤率 {attendance}%。

🌟 重点进步：
结合{student_name}的长期目标（{student_goal}），这个月在 {foreign_teacher} 老师的辅导下，{progress_summary}

🎯 下月重点：
基于这个月的学习表现，下月重点将放在 {next_focus}，
中教 {chinese_teacher} 会加大 {specific_training} 的训练……
```

### 异常沟通（缺课）

```
{parent_name}，注意到 {student_name} 已经连续 {count} 次未能出席课程。
我们非常理解可能有特殊情况，想了解一下是否需要调整上课时间？
如果 {student_name} 身体不舒服或者学校事情比较多，我们可以灵活安排补课。
课程回放已上传到飞书，{student_name} 可以先看回放保持进度 💪
```
