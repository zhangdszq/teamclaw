/**
 * Shared MCP server for all agent contexts (main window, DingTalk, Feishu).
 * Exposes common tools: scheduler, web_search, web_fetch, take_screenshot,
 * news_search, news_latest (6551 OpenNews), twitter_user_tweets, twitter_search
 * (6551 OpenTwitter).
 *
 * Claude provider: injected via mcpServers option in query().
 * Codex provider: tools are accessible via bash directly (no MCP needed).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import os from "os";
import { parse as parseToml } from "smol-toml";
import { app } from "electron";
import {
  addScheduledTask,
  loadScheduledTasks,
  deleteScheduledTask,
  updateScheduledTask,
} from "./scheduler/index.js";
import {
  writeWorkingMemory,
  readWorkingMemory,
  readSop,
  appendDailyMemory,
  writeLongTermMemory,
  readLongTermMemory,
  listAssistantIds,
  ScopedMemory,
} from "./memory-store.js";
import {
  loadPlanItems,
  upsertPlanItem,
  updatePlanItem,
  type PlanItem,
} from "./plan-store.js";
import { sendProactiveDingtalkMessage, getDingtalkBotStatus, getAnyConnectedDingtalkAssistantId } from "./dingtalk-bot.js";
import { sendProactiveTelegramMessage, getTelegramBotStatus, getAnyConnectedTelegramAssistantId } from "./telegram-bot.js";
import { sendProactiveFeishuMessage, getFeishuBotStatus, getAnyConnectedFeishuAssistantId } from "./feishu-bot.js";
import { sendProactiveQQMessage, getQQBotStatus, getAnyConnectedQQBotAssistantId } from "./qqbot-bot.js";
import { appendNotified } from "./notification-log.js";
import { createKnowledgeCandidate } from "./knowledge-store.js";
import { loadAssistantsConfig } from "./assistants-config.js";
import { loadUserSettings } from "./user-settings.js";
import { resolveAppAsset } from "../pathResolver.js";
import { ensurePyPackages, ensurePythonEnv, getManagedPythonInfo, getPythonEnvDir } from "./python-env.js";

// ── Helpers ────────────────────────────────────────────────────────────────

// ── 6551 API (OpenNews + OpenTwitter) ───────────────────────────────────────

const API_BASE = "https://ai.6551.io";
let _cached6551Token: string | null = null;

function get6551Token(): string {
  if (_cached6551Token) return _cached6551Token;
  try {
    const configPath = resolveAppAsset("config", "builtin-mcp-servers.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { token?: string };
      if (cfg.token) {
        _cached6551Token = cfg.token;
        return cfg.token;
      }
    }
  } catch { /* ignore */ }
  return "";
}

async function api6551<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = get6551Token();
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`6551 API ${method} ${path} → HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const WEB_FETCH_SCRIPT = String.raw`import json
import sys

import html2text
from scrapling.fetchers import Fetcher


def decode_body(page):
    encoding = page.encoding or "utf-8"
    try:
        return page.body.decode(encoding, errors="replace")
    except LookupError:
        return page.body.decode("utf-8", errors="replace")


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    url = str(payload.get("url") or "").strip()
    max_chars = int(payload.get("max_chars") or 8000)

    if not url:
        raise ValueError("url is required")

    page = Fetcher.get(url, timeout=15)
    content_type = str(page.headers.get("content-type") or "").lower()
    text = decode_body(page)

    if "text/html" in content_type:
        converter = html2text.HTML2Text()
        converter.ignore_images = True
        converter.body_width = 0
        text = converter.handle(text)

    sys.stdout.write(text[:max_chars])


if __name__ == "__main__":
    main()
`;

async function ensureManagedToolScript(filename: string, source: string): Promise<string> {
  const fs = await import("fs");
  const path = await import("path");
  const toolsDir = path.join(getPythonEnvDir(), "tool-scripts");
  if (!fs.existsSync(toolsDir)) fs.mkdirSync(toolsDir, { recursive: true });
  const scriptPath = path.join(toolsDir, filename);
  const current = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : null;
  if (current !== source) fs.writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

async function runManagedWebFetch(url: string, maxChars: number): Promise<string> {
  const pythonPath = await ensurePythonEnv();
  if (!pythonPath) throw new Error("托管 Python 环境初始化失败");

  const packagesReady = await ensurePyPackages(["scrapling[fetchers]", "html2text"]);
  if (!packagesReady) throw new Error("托管 Python 依赖安装失败");

  const scriptPath = await ensureManagedToolScript("web_fetch.py", WEB_FETCH_SCRIPT);
  const { spawn } = await import("child_process");

  return await new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [scriptPath], {
      shell: false,
      windowsHide: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handler();
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(() => reject(new Error("托管 Python 抓取超时")));
    }, 30_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      finish(() => reject(err));
    });

    proc.on("close", (code) => {
      finish(() => {
        if ((code ?? -1) === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `托管 Python 进程退出码: ${code ?? -1}`));
      });
    });

    proc.stdin?.end(JSON.stringify({ url, max_chars: maxChars }));
  });
}

async function webFetch(url: string, maxChars = 8_000): Promise<string> {
  try {
    return await runManagedWebFetch(url, maxChars);
  } catch {
    // Fall back to the built-in fetch implementation.
  }

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  const contentType = resp.headers.get("content-type") ?? "";
  const text = await resp.text();
  if (contentType.includes("text/html")) {
    return stripHtml(text).slice(0, maxChars);
  }
  return text.slice(0, maxChars);
}

async function webSearch(query: string, maxResults = 5): Promise<string> {
  // 1. DuckDuckGo Instant Answer API
  try {
    const iaUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(iaUrl, {
      headers: { "User-Agent": "VK-Cowork-Bot/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        Answer?: string;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
      };
      const parts: string[] = [];
      if (data.Answer) parts.push(`**答案**: ${data.Answer}`);
      if (data.AbstractText) {
        parts.push(`**摘要**: ${data.AbstractText}`);
        if (data.AbstractURL) parts.push(`来源: ${data.AbstractURL}`);
      }
      if (data.Results && data.Results.length > 0) {
        parts.push("\n**搜索结果**:");
        for (const r of data.Results.slice(0, maxResults)) {
          if (r.Text && r.FirstURL) parts.push(`- ${r.Text.slice(0, 200)}\n  ${r.FirstURL}`);
        }
      }
      const flatTopics = (data.RelatedTopics ?? []).filter(
        (t): t is { Text: string; FirstURL: string } => !!(t.Text && t.FirstURL),
      );
      if (flatTopics.length > 0) {
        parts.push("\n**相关话题**:");
        for (const t of flatTopics.slice(0, maxResults)) {
          parts.push(`- ${(t.Text ?? "").slice(0, 200)}\n  ${t.FirstURL}`);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
  } catch {
    /* fall through to HTML scraping */
  }

  // 2. DuckDuckGo HTML scraping fallback
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);

  const html = await resp.text();
  const titleRe = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const urlRe = /uddg=([^&"]+)/g;

  const titles: string[] = [];
  const snippets: string[] = [];
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) titles.push(stripHtml(m[1]).slice(0, 120));
  while ((m = snippetRe.exec(html)) !== null) snippets.push(stripHtml(m[1]).slice(0, 250));
  while ((m = urlRe.exec(html)) !== null) {
    try {
      urls.push(decodeURIComponent(m[1]));
    } catch {
      urls.push(m[1]);
    }
  }

  const count = Math.min(maxResults, titles.length);
  if (count === 0) {
    return `未找到"${query}"相关结果，建议使用 web_fetch 直接访问相关网址。`;
  }
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    const snippet = snippets[i] ? `\n${snippets[i]}` : "";
    const url = urls[i] ? `\n${urls[i]}` : "";
    results.push(`**${i + 1}. ${titles[i]}**${snippet}${url}`);
  }
  return `🔍 搜索"${query}"结果：\n\n${results.join("\n\n")}`;
}

/** Wrap a plain string result into MCP CallToolResult format. */
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── Tool definitions ────────────────────────────────────────────────────────

// ── OpenNews tools ──────────────────────────────────────────────────────────

const newsLatestTool = tool(
  "news_latest",
  "获取最新加密货币/财经资讯（来自 6551 OpenNews）。返回文章标题、AI 评分、交易信号（多/空/中性）和摘要。" +
  "适合场景：了解市场最新动态、查看重要新闻、获取 AI 评级的高影响力资讯。",
  {
    limit: z.number().optional().describe("返回条数，默认 10，最大 50"),
    coin: z.string().optional().describe("按代币筛选，如 BTC、ETH、SOL（可选）"),
    signal: z.enum(["long", "short", "neutral"]).optional().describe("按交易信号筛选（可选）"),
    min_score: z.number().optional().describe("最低 AI 评分（0-100），只返回高于此分的资讯（可选）"),
  },
  async (input) => {
    try {
      const limit = Math.min(Number(input.limit ?? 10), 50);
      const body: Record<string, unknown> = { limit, page: 1 };
      if (input.coin) body.coins = [String(input.coin).toUpperCase()];

      const data = await api6551<{ data?: unknown[] }>("POST", "/open/news_search", body);
      let items = (data?.data ?? []) as Array<{
        text?: string; ts?: number; newsType?: string; engineType?: string;
        aiRating?: { score?: number; signal?: string; summary?: string; enSummary?: string };
        link?: string; coins?: Array<{ symbol?: string }>;
      }>;

      if (input.signal) items = items.filter(i => i.aiRating?.signal === input.signal);
      if (input.min_score != null) items = items.filter(i => (i.aiRating?.score ?? 0) >= Number(input.min_score));

      if (items.length === 0) return ok("暂无符合条件的资讯。");

      const lines = items.slice(0, limit).map((item, idx) => {
        const time = item.ts ? new Date(item.ts).toLocaleString("zh-CN", { hour12: false }) : "";
        const score = item.aiRating?.score != null ? `评分:${item.aiRating.score}` : "";
        const signal = item.aiRating?.signal ? `信号:${item.aiRating.signal}` : "";
        const coins = item.coins?.map(c => c.symbol).filter(Boolean).join("/") ?? "";
        const summary = item.aiRating?.summary || item.aiRating?.enSummary || "";
        const meta = [score, signal, coins, item.newsType, time].filter(Boolean).join(" | ");
        return `**${idx + 1}. ${item.text ?? ""}**\n${meta}${summary ? `\n${summary}` : ""}${item.link ? `\n${item.link}` : ""}`;
      });
      return ok(`📰 最新资讯（${lines.length} 条）\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`获取资讯失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const newsSearchTool = tool(
  "news_search",
  "按关键词搜索加密货币/财经资讯（来自 6551 OpenNews）。支持关键词、代币、评分过滤。",
  {
    query: z.string().describe("搜索关键词"),
    coin: z.string().optional().describe("按代币筛选，如 BTC、ETH（可选）"),
    limit: z.number().optional().describe("返回条数，默认 10，最大 30"),
  },
  async (input) => {
    try {
      const query = String(input.query ?? "").trim();
      if (!query) return ok("搜索词不能为空");
      const limit = Math.min(Number(input.limit ?? 10), 30);
      const body: Record<string, unknown> = { q: query, limit, page: 1 };
      if (input.coin) body.coins = [String(input.coin).toUpperCase()];

      const data = await api6551<{ data?: unknown[] }>("POST", "/open/news_search", body);
      const items = (data?.data ?? []) as Array<{
        text?: string; ts?: number; newsType?: string;
        aiRating?: { score?: number; signal?: string; summary?: string };
        link?: string; coins?: Array<{ symbol?: string }>;
      }>;

      if (items.length === 0) return ok(`未找到"${query}"相关资讯。`);

      const lines = items.map((item, idx) => {
        const score = item.aiRating?.score != null ? `评分:${item.aiRating.score}` : "";
        const signal = item.aiRating?.signal ? `信号:${item.aiRating.signal}` : "";
        const coins = item.coins?.map(c => c.symbol).filter(Boolean).join("/") ?? "";
        const meta = [score, signal, coins, item.newsType].filter(Boolean).join(" | ");
        return `**${idx + 1}. ${item.text ?? ""}**\n${meta}${item.aiRating?.summary ? `\n${item.aiRating.summary}` : ""}`;
      });
      return ok(`🔍 "${query}" 相关资讯（${lines.length} 条）\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`搜索资讯失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// ── OpenTwitter tools ────────────────────────────────────────────────────────

const twitterUserTweetsTool = tool(
  "twitter_user_tweets",
  "获取指定 Twitter/X 用户的最近推文（来自 6551 OpenTwitter）。",
  {
    username: z.string().describe("Twitter 用户名，不带 @ 符号，如 elonmusk"),
    limit: z.number().optional().describe("返回条数，默认 10，最大 50"),
    include_retweets: z.boolean().optional().describe("是否包含转推，默认 false"),
  },
  async (input) => {
    try {
      const username = String(input.username ?? "").replace(/^@/, "").trim();
      if (!username) return ok("用户名不能为空");
      const limit = Math.min(Number(input.limit ?? 10), 50);

      const data = await api6551<{ data?: unknown[] }>("POST", "/open/twitter_user_tweets", {
        username,
        maxResults: limit,
        product: "Latest",
        includeReplies: false,
        includeRetweets: input.include_retweets ?? false,
      });
      const tweets = (data?.data ?? []) as Array<{
        id?: string; text?: string; createdAt?: string;
        retweetCount?: number; favoriteCount?: number; replyCount?: number;
      }>;

      if (tweets.length === 0) return ok(`@${username} 暂无推文。`);

      const lines = tweets.map((t, idx) => {
        const time = t.createdAt ? new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
        const stats = [`❤️ ${t.favoriteCount ?? 0}`, `🔁 ${t.retweetCount ?? 0}`, `💬 ${t.replyCount ?? 0}`].join("  ");
        return `**${idx + 1}.** ${t.text ?? ""}\n${stats}  ${time}`;
      });
      return ok(`🐦 @${username} 最近 ${lines.length} 条推文\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`获取推文失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const twitterSearchTool = tool(
  "twitter_search",
  "搜索 Twitter/X 推文（来自 6551 OpenTwitter）。支持关键词、用户、话题标签、互动量过滤。",
  {
    keywords: z.string().optional().describe("搜索关键词（可选）"),
    from_user: z.string().optional().describe("指定发推用户，不带 @（可选）"),
    hashtag: z.string().optional().describe("话题标签，不带 #（可选）"),
    min_likes: z.number().optional().describe("最低点赞数，用于筛选热门推文（可选）"),
    limit: z.number().optional().describe("返回条数，默认 10，最大 50"),
    product: z.enum(["Top", "Latest"]).optional().describe("排序方式：Top=热门，Latest=最新，默认 Top"),
  },
  async (input) => {
    try {
      const limit = Math.min(Number(input.limit ?? 10), 50);
      const body: Record<string, unknown> = {
        maxResults: limit,
        product: input.product ?? "Top",
      };
      if (input.keywords) body.keywords = String(input.keywords);
      if (input.from_user) body.fromUser = String(input.from_user).replace(/^@/, "");
      if (input.hashtag) body.hashtag = String(input.hashtag).replace(/^#/, "");
      if (input.min_likes) body.minLikes = Number(input.min_likes);

      if (!body.keywords && !body.fromUser && !body.hashtag) {
        return ok("请至少提供 keywords、from_user 或 hashtag 之一");
      }

      const data = await api6551<{ data?: unknown[] }>("POST", "/open/twitter_search", body);
      const tweets = (data?.data ?? []) as Array<{
        id?: string; text?: string; createdAt?: string; userScreenName?: string;
        retweetCount?: number; favoriteCount?: number; replyCount?: number;
      }>;

      if (tweets.length === 0) return ok("未找到相关推文。");

      const lines = tweets.map((t, idx) => {
        const user = t.userScreenName ? `@${t.userScreenName}` : "";
        const time = t.createdAt ? new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
        const stats = [`❤️ ${t.favoriteCount ?? 0}`, `🔁 ${t.retweetCount ?? 0}`].join("  ");
        return `**${idx + 1}.** ${t.text ?? ""}\n${user}  ${stats}  ${time}`;
      });

      const desc = [input.keywords, input.from_user ? `@${input.from_user}` : "", input.hashtag ? `#${input.hashtag}` : ""].filter(Boolean).join(" + ");
      return ok(`🔍 "${desc}" 推文（${lines.length} 条）\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`搜索推文失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

function createScheduledTaskTool(workflowSopId?: string) {
  return tool(
    "create_scheduled_task",
    "创建一个定时任务。\n\n" +
      (workflowSopId
        ? "【注意】当前在 SOP 工作流中，创建的定时任务将自动关联到该 SOP（hidden=true，不显示在日历中）。\n\n"
        : "") +
      "**重要：prompt vs notifyText 二选一**\n" +
      "- notifyText（优先推荐）：用户说「提醒我XXX」「X分钟后提醒我」等简单文字提醒 → 填 notifyText，到期直接推送文字到用户的消息渠道（Telegram/飞书/钉钉），不启动 AI 会话，秒级送达。\n" +
      "- prompt：用户说「帮我执行XXX」「每天分析XXX」等需要 AI 思考和操作的复杂任务 → 填 prompt，到期启动完整 AI 会话执行。\n\n" +
      "scheduleType 选择规则（必须严格遵守）：\n" +
      "- once：用户说「X 分钟/小时后」「明天 X 点」「X 号 X 点」等一次性时间 → 单次执行\n" +
      "- interval：用户说「每隔 X 分钟/小时」「每 X 分钟重复」等周期性 → 间隔重复，必填 intervalValue + intervalUnit\n" +
      "- daily：用户说「每天 X 点」「每周一/三/五 X 点」→ 每日固定时间，必填 dailyTime\n\n" +
      "once 类型时间填写规则（二选一）：\n" +
      "- 相对时间（推荐）：填 delay_minutes（相对现在的分钟数），服务器自动计算准确时间。「5分钟后」→ delay_minutes=5，「2小时后」→ delay_minutes=120\n" +
      "- 绝对时间：填 scheduledTime，格式 'YYYY-MM-DDTHH:MM:SS'（本地时间，不加Z）\n\n" +
      "示例：\n" +
      "「3分钟后提醒我喝水」→ once，delay_minutes=3，notifyText='该喝水啦～记得喝水哦'\n" +
      "「每天早上9点提醒我站起来活动」→ daily，dailyTime='09:00'，notifyText='该站起来活动一下啦！'\n" +
      "「每2分钟检查邮件」→ interval，intervalValue=2，intervalUnit=minutes，prompt='检查邮件并汇报'\n" +
      "「每天早上9点汇报」→ daily，dailyTime='09:00'，prompt='总结最新消息并汇报'",
    {
      name: z.string().describe("任务名称，简短描述任务用途"),
      notifyText: z
        .string()
        .optional()
        .describe("【简单提醒专用，优先使用】到期直接推送此文字到用户的消息渠道，不启动 AI 会话。适用于「提醒我喝水」「提醒我开会」等。用自然、友好的语气撰写提醒内容。"),
      prompt: z
        .string()
        .optional()
        .describe("【复杂任务专用】任务执行时发送给 AI 的指令内容。仅当任务需要 AI 思考、调用工具时才填此字段。与 notifyText 二选一。"),
      scheduleType: z
        .enum(["once", "interval", "daily"])
        .describe("调度类型：once=单次、interval=间隔重复、daily=每日固定时间"),
      delay_minutes: z
        .number()
        .optional()
        .describe("【once 类型专用，推荐使用】从现在起延迟执行的分钟数，服务器自动换算为准确时间。优先级高于 scheduledTime。"),
      scheduledTime: z
        .string()
        .optional()
        .describe("单次执行的本地绝对时间，格式 'YYYY-MM-DDTHH:MM:SS'（不加 Z），仅当无法用 delay_minutes 表达时才填"),
      intervalValue: z.number().optional().describe("间隔数值，scheduleType=interval 时必填"),
      intervalUnit: z
        .enum(["minutes", "hours", "days", "weeks"])
        .optional()
        .describe("间隔单位，scheduleType=interval 时必填"),
      dailyTime: z.string().optional().describe("每日执行时间，格式 HH:MM，scheduleType=daily 时必填"),
      dailyDays: z
        .array(z.number())
        .optional()
        .describe("指定星期几执行（0=周日，1=周一…6=周六），不填则每天执行，scheduleType=daily 时可选"),
      assistantId: z.string().optional().describe("指定执行任务的助理 ID（可选）"),
      cwd: z.string().optional().describe("任务执行时的工作目录（可选）"),
    },
    async (input) => {
      try {
        const scheduleType = input.scheduleType;
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const refNow = Date.now();

        let scheduledTime: string | undefined;
        if (scheduleType === "once") {
          if (input.delay_minutes != null && Number(input.delay_minutes) > 0) {
            scheduledTime = new Date(refNow + Number(input.delay_minutes) * 60 * 1000).toISOString();
          } else if (input.scheduledTime) {
            const parsed = new Date(String(input.scheduledTime));
            if (isNaN(parsed.getTime())) {
              return ok(
                `创建失败：scheduledTime 格式无效（${input.scheduledTime}）。请改用 delay_minutes 指定延迟分钟数。`,
              );
            }
            if (parsed.getTime() <= refNow) {
              const nowStr = new Date(refNow).toLocaleString("zh-CN", { timeZone: tz, hour12: false });
              return ok(
                `创建失败：指定时间 ${parsed.toLocaleString("zh-CN", { timeZone: tz, hour12: false })} 已经过去（当前时间：${nowStr}）。\n请改用 delay_minutes 参数指定从现在起延迟的分钟数，例如 delay_minutes=2 表示2分钟后。`,
              );
            }
            scheduledTime = parsed.toISOString();
          } else {
            return ok(`创建失败：once 类型必须提供 delay_minutes（推荐）或 scheduledTime。`);
          }
        }

        const notifyText = input.notifyText ? String(input.notifyText).trim() : undefined;
        const prompt = input.prompt ? String(input.prompt).trim() : "";
        if (!notifyText && !prompt) {
          return ok("创建失败：必须提供 notifyText（简单提醒）或 prompt（AI 任务），不能都为空。");
        }

        const task = await addScheduledTask({
          name: String(input.name ?? ""),
          prompt,
          notifyText,
          enabled: true,
          scheduleType,
          assistantId: input.assistantId,
          cwd: input.cwd ? String(input.cwd) : undefined,
          scheduledTime,
          intervalValue: input.intervalValue ? Number(input.intervalValue) : undefined,
          intervalUnit: input.intervalUnit ?? undefined,
          dailyTime: input.dailyTime ? String(input.dailyTime) : undefined,
          dailyDays: Array.isArray(input.dailyDays) ? input.dailyDays : undefined,
          // Auto-inject SOP context when running inside a workflow — hides task from calendar
          ...(workflowSopId ? { sopId: workflowSopId, hidden: true } : {}),
        });

        const nextRunStr = task.nextRun
          ? new Date(task.nextRun).toLocaleString("zh-CN", { timeZone: tz, hour12: false })
          : "未知";
        const modeLabel = notifyText ? "直推提醒" : "AI 任务";

        return ok(
          `定时任务已创建！\n- 名称：${task.name}\n- 模式：${modeLabel}\n- 类型：${task.scheduleType}\n- 下次执行：${nextRunStr}\n- 任务 ID：${task.id}`,
        );
      } catch (err) {
        return ok(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

const listScheduledTasksTool = tool(
  "list_scheduled_tasks",
  "获取所有已创建的定时任务列表，返回名称、调度类型、启用状态和下次执行时间。",
  {},
  async () => {
    try {
      const tasks = loadScheduledTasks();
      if (tasks.length === 0) return ok("当前没有任何定时任务。");

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: tz, hour12: false });

      const lines = tasks.map((t) => {
        const status = t.enabled ? "✅ 启用" : "⏸ 停用";
        const nextRun = t.nextRun ? fmt(t.nextRun) : "无";
        let schedule = "";
        if (t.scheduleType === "once") schedule = `单次 @ ${t.scheduledTime ? fmt(t.scheduledTime) : "未知"}`;
        else if (t.scheduleType === "interval") schedule = `每 ${t.intervalValue} ${t.intervalUnit}`;
        else if (t.scheduleType === "daily")
          schedule = `每天 ${t.dailyTime}${t.dailyDays?.length ? `（周${t.dailyDays.join("/")}）` : ""}`;

        return `- **${t.name}** [${status}]\n  调度：${schedule}\n  下次：${nextRun}\n  ID：\`${t.id}\``;
      });

      return ok(`**定时任务列表（共 ${tasks.length} 个）**\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`获取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const deleteScheduledTaskTool = tool(
  "delete_scheduled_task",
  "删除指定 ID 的定时任务。可先用 list_scheduled_tasks 查看任务 ID。",
  {
    task_id: z.string().describe("要删除的任务 ID"),
  },
  async (input) => {
    try {
      const taskId = String(input.task_id ?? "");
      if (!taskId) return ok("任务 ID 不能为空");

      const tasks = loadScheduledTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return ok(`未找到 ID 为 ${taskId} 的任务`);

      const success = await deleteScheduledTask(taskId);
      return ok(success ? `已删除定时任务：${task.name}` : `删除失败，请重试`);
    } catch (err) {
      return ok(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// ─── register_sop_schedule ────────────────────────────────────────────────────
// Helper: find sopId (folder name) by matching sop name from HAND.toml files.
function findSopIdByName(sopName: string): string | null {
  const handsDir = join(os.homedir(), ".vk-cowork", "hands");
  if (!existsSync(handsDir)) return null;
  try {
    for (const entry of readdirSync(handsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tomlPath = join(handsDir, entry.name, "HAND.toml");
      if (!existsSync(tomlPath)) continue;
      try {
        const data = parseToml(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
        const name = typeof data.name === "string" ? data.name : "";
        if (name === sopName || entry.name === sopName) return entry.name;
      } catch {
        // skip malformed HAND.toml
      }
    }
  } catch {
    // ignore fs errors
  }
  return null;
}

function createRegisterSopScheduleTool(workflowSopId?: string) {
  return tool(
    "register_sop_schedule",
    "为指定 SOP 设置或更新定时调度（幂等：同 SOP 已有调度则更新，否则新建）。调度为隐藏任务，不显示在日历中。",
    {
      sop_name: z.string().describe("SOP 名称（HAND.toml 中的 name 字段，或文件夹名）"),
      schedule_type: z.enum(["daily", "interval"]).describe("调度类型：daily=每日固定时刻，interval=固定间隔"),
      daily_time: z.string().optional().describe("schedule_type=daily 时必填，格式 HH:MM"),
      daily_days: z.array(z.number().int().min(0).max(6)).optional().describe("每周执行的天（0=周日…6=周六），不填=每天"),
      interval_value: z.number().optional().describe("schedule_type=interval 时必填，间隔数量"),
      interval_unit: z.enum(["minutes", "hours", "days"]).optional().describe("间隔单位"),
    },
    async (input) => {
      try {
        const sopName = String(input.sop_name ?? "").trim();
        if (!sopName) return ok("sop_name 不能为空");

        const sopId = findSopIdByName(sopName);
        if (!sopId) return ok(`未找到名为「${sopName}」的 SOP，请确认名称是否正确`);

        const scheduleType = input.schedule_type as "daily" | "interval";

        if (scheduleType === "daily" && !input.daily_time) {
          return ok("schedule_type=daily 时必须提供 daily_time（格式 HH:MM）");
        }
        if (scheduleType === "interval" && !input.interval_value) {
          return ok("schedule_type=interval 时必须提供 interval_value");
        }

        const updates = {
          scheduleType,
          dailyTime: input.daily_time,
          dailyDays: input.daily_days,
          intervalValue: input.interval_value,
          intervalUnit: input.interval_unit,
        } as const;

        // Idempotent: find existing SOP-level schedule (no stageId)
        const existing = loadScheduledTasks().find(
          (t) => t.sopId === sopId && !t.stageId
        );

        if (existing) {
          await updateScheduledTask(existing.id, updates);
          return ok(`已更新 SOP「${sopName}」的定时调度（任务 ID：${existing.id}）`);
        } else {
          const task = await addScheduledTask({
            name: `SOP: ${sopName}`,
            enabled: true,
            prompt: "",
            sopId,
            hidden: true,
            ...updates,
          });
          return ok(`已为 SOP「${sopName}」创建定时调度（任务 ID：${task.id}）`);
        }
      } catch (err) {
        return ok(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

const webSearchTool = tool(
  "web_search",
  "通过 DuckDuckGo 搜索网络，返回 top 5 搜索结果（标题、摘要、URL）。如需查看某个结果的详细内容，再用 web_fetch 工具抓取对应 URL。",
  {
    query: z.string().describe("搜索关键词或问题"),
    max_results: z.number().optional().describe("最多返回结果数，默认 5，最大 10"),
  },
  async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) return ok("搜索词不能为空");
    const maxResults = Math.min(Number(input.max_results ?? 5), 10);
    try {
      return ok(await webSearch(query, maxResults));
    } catch (err) {
      return ok(`搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const webFetchTool = tool(
  "web_fetch",
  "抓取指定 URL 的内容并以纯文本返回。HTML 页面会自动清除标签，返回可读正文。可用于查看文章、文档、API 响应等。默认最多返回 8000 字符。",
  {
    url: z.string().describe("要抓取的 HTTP/HTTPS URL"),
    max_chars: z.number().optional().describe("最多返回字符数，默认 8000，最大 20000"),
  },
  async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return ok("URL 不能为空");
    const maxChars = Math.min(Number(input.max_chars ?? 8_000), 20_000);
    try {
      return ok(await webFetch(url, maxChars));
    } catch (err) {
      return ok(`抓取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const readDocumentTool = tool(
  "read_document",
  "读取本地文件内容并返回纯文本。支持 PDF、Word（.docx）、Excel（.xlsx/.xls）、纯文本、CSV 等格式。" +
  "收到文件路径时必须优先调用此工具获取实际内容，不得凭猜测或训练数据捏造文件内容。",
  {
    file_path: z.string().describe("本地文件的绝对路径"),
    max_chars: z.number().optional().describe("最多返回字符数，默认 20000"),
  },
  async (input) => {
    const filePath = String(input.file_path ?? "").trim();
    if (!filePath) return ok("file_path 不能为空");
    const maxChars = Math.min(Number(input.max_chars ?? 20_000), 60_000);

    const fs = await import("fs");
    if (!fs.existsSync(filePath)) return ok(`文件不存在: ${filePath}`);

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

    try {
      // PDF
      if (ext === "pdf") {
        const { createRequire } = await import("module");
        const require = createRequire(import.meta.url);
        const pdfParse = require("pdf-parse");
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        const text = (data.text as string).trim();
        if (!text) return ok("PDF 内容为空或无法提取文本（可能是扫描件图片 PDF）");
        return ok(text.slice(0, maxChars));
      }

      // Word (.docx)
      if (ext === "docx") {
        const { createRequire } = await import("module");
        const require = createRequire(import.meta.url);
        try {
          const mammoth = require("mammoth");
          const result = await mammoth.extractRawText({ path: filePath });
          return ok((result.value as string).trim().slice(0, maxChars));
        } catch {
          return ok("需要安装 mammoth 包以读取 .docx 文件：npm install mammoth");
        }
      }

      // Plain text / CSV / JSON / XML / Markdown etc.
      const textExts = ["txt", "csv", "json", "xml", "md", "yaml", "yml", "log", "html", "htm"];
      if (textExts.includes(ext) || ext === "") {
        const content = fs.readFileSync(filePath, "utf8");
        return ok(content.slice(0, maxChars));
      }

      return ok(`不支持的文件类型: .${ext}。支持: pdf, docx, txt, csv, json, xml, md 等文本格式。`);
    } catch (err) {
      return ok(`读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const takeScreenshotTool = tool(
  "take_screenshot",
  "截取当前桌面屏幕截图。返回截图的临时文件路径，之后可用 send_file 发送给用户。",
  {},
  async () => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    const filePath = path.join(os.tmpdir(), `vk-shot-${Date.now()}.png`);

    const platform = process.platform;
    if (platform === "darwin") {
      await execAsync(`screencapture -x "${filePath}"`);
    } else if (platform === "win32") {
      await execAsync(
        `powershell -command "Add-Type -AssemblyName System.Windows.Forms; ` +
          `$b=New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
          `$g=[System.Drawing.Graphics]::FromImage($b); ` +
          `$g.CopyFromScreen(0,0,0,0,$b.Size); ` +
          `$b.Save('${filePath}')"`,
      );
    } else {
      await execAsync(`gnome-screenshot -f "${filePath}" 2>/dev/null || scrot "${filePath}"`);
    }

    if (!fs.existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: "截图文件未生成" }], isError: true };
    }
    return ok(filePath);
  },
);

// ── Experience Tool (writes to knowledge/experience/) ─

function createSaveExperienceTool(sourceSessionId?: string, assistantId?: string) {
  return tool(
    "save_experience",
    "将操作经验沉淀为可复用的经验文档。完成复杂任务后调用此工具，记录经过验证的操作步骤和踩坑点。\n\n" +
      "写入知识库的「经验候选」（draft），用户可在知识库页面审核后升级为正式知识文档。\n" +
      "只记录经过实践验证成功的流程，不要记录未验证的猜测。",
    {
      title: z.string().describe("经验标题，简要描述任务（如「配置 Docker Compose 多服务编排」）"),
      scenario: z.string().describe("适用场景，说明什么情况下需要此经验"),
      steps: z.string().describe("关键步骤（按顺序），包含踩坑点和注意事项"),
      result: z.string().describe("最终结果/解决方案"),
      risk: z.string().optional().describe("风险和注意事项（可选）"),
    },
    async (input) => {
      try {
        const title = String(input.title ?? "").trim();
        if (!title) return ok("标题不能为空");
        const steps = String(input.steps ?? "").trim();
        if (!steps) return ok("步骤不能为空");

        const candidate = createKnowledgeCandidate({
          title,
          scenario: String(input.scenario ?? "").trim(),
          steps,
          result: String(input.result ?? "").trim(),
          risk: String(input.risk ?? "").trim() || "待人工审核",
          sourceSessionId: sourceSessionId ?? "",
          assistantId,
        });

        return ok(`经验已保存为候选（draft）：${candidate.title}\nID：${candidate.id}\n可在知识库页面查看和审核。`);
      } catch (err) {
        return ok(`保存经验失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ── Working Memory Tools (factory — uses assistantId via closure) ────────────

function createSaveWorkingMemoryTool(assistantId?: string) {
  return tool(
    "save_working_memory",
    "保存工作记忆检查点。在执行长任务时，定期保存关键上下文（当前任务、关键信息、操作历史），" +
      "确保跨会话的连续性。下次新会话会自动加载这些信息。\n\n" +
      "适合保存的内容：当前任务目标和进展、关键中间结果、重要决策、相关 SOP 名称。\n" +
      "不适合保存的内容：临时变量、完整代码、推理过程。",
    {
      key_info: z.string().describe("关键上下文信息：当前进展、重要决策、环境事实等"),
      current_task: z.string().optional().describe("当前正在执行的任务描述"),
      related_sops: z.array(z.string()).optional().describe("相关的 SOP 名称列表"),
      history: z.array(z.string()).optional().describe("最近的操作历史摘要（每条一句话）"),
    },
    async (input) => {
      try {
        const keyInfo = String(input.key_info ?? "").trim();
        if (!keyInfo) return ok("key_info 不能为空");

        const checkpoint = {
          keyInfo,
          currentTask: input.current_task ? String(input.current_task) : undefined,
          relatedSops: input.related_sops as string[] | undefined,
          history: input.history as string[] | undefined,
        };

        if (assistantId) {
          new ScopedMemory(assistantId).writeWorkingMemory(checkpoint);
        } else {
          writeWorkingMemory(checkpoint);
        }

        return ok(`工作记忆已保存。内容将在下次会话中自动加载。\n- 关键信息：${keyInfo.slice(0, 100)}...`);
      } catch (err) {
        return ok(`保存工作记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

function createReadWorkingMemoryTool(assistantId?: string) {
  return tool(
    "read_working_memory",
    "读取当前的工作记忆检查点，查看上次保存的任务上下文和进展。",
    {},
    async () => {
      try {
        const content = assistantId
          ? new ScopedMemory(assistantId).readWorkingMemory()
          : readWorkingMemory();
        if (!content?.trim()) return ok("暂无保存的工作记忆。");
        return ok(content);
      } catch (err) {
        return ok(`读取工作记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ── Save Memory (scoped — private by default) ──────────────────────────────

function createSaveMemoryTool(assistantId?: string) {
  return tool(
    "save_memory",
    "保存长期记忆条目。默认写入你的专属记忆（仅你可见），只有团队级信息才设 scope 为 shared。\n\n" +
      "专属记忆（scope: private）：你与用户的交互偏好、项目决策、技术方案、环境配置\n" +
      "共享记忆（scope: shared）：用户身份变更、团队级决策、用户明确要求所有助理知道的信息\n\n" +
      "格式（每条必须以 '- ' 或 '* ' 开头）：\n" +
      "  - [P0] 永久条目\n" +
      "  - [P1|expire:YYYY-MM-DD] 90天条目\n" +
      "  - [P2|expire:YYYY-MM-DD] 30天条目\n" +
      "禁止使用 XML 闭合标签（如 [/P0]）",
    {
      content: z.string().describe("记忆条目，每行以 '- [P0]' / '- [P1|expire:YYYY-MM-DD]' / '- [P2|expire:YYYY-MM-DD]' 或 '* ' 开头，禁止 [/P0] 等闭合标签"),
      scope: z.enum(["private", "shared"]).default("private").describe("写入范围：private（专属，默认）或 shared（团队共享）"),
    },
    async (input) => {
      try {
        let content = String(input.content ?? "").trim();
        if (!content) return ok("content 不能为空");

        // Auto-fix: strip XML-style closing tags (e.g. [/P0], [/P1|expire:...])
        content = content.replace(/\[\/P[012][^\]]*\]/g, "").replace(/\s+$/, "");

        // Auto-fix: ensure lines with lifecycle tags start with "- "
        content = content.split("\n").map(line => {
          const stripped = line.trimStart();
          if (/^\[P[012][\]|]/.test(stripped) && !/^[-*]\s/.test(line)) {
            return "- " + stripped.trimEnd();
          }
          return line.trimEnd();
        }).join("\n").trim();

        const taggedMemoryPattern = /^[-*]\s+\[(?:P0|P1\|expire:\d{4}-\d{2}-\d{2}|P2\|expire:\d{4}-\d{2}-\d{2})\]\s+/m;
        if (!taggedMemoryPattern.test(content)) {
          return ok("保存失败：每个条目必须以 '- [P0] ' / '- [P1|expire:YYYY-MM-DD] ' / '- [P2|expire:YYYY-MM-DD] ' 开头。");
        }

        const settings = loadUserSettings();
        const memoryIsolation = settings.memoryIsolationV3 !== false; // default: on
        const requestedScope = input.scope ?? "private";
        const scope = memoryIsolation ? requestedScope : "shared";

        if (scope === "shared") {
          const existing = readLongTermMemory();
          const newContent = existing.trim() ? existing.trimEnd() + "\n" + content : content;
          writeLongTermMemory(newContent);
          if (!memoryIsolation && requestedScope === "private") {
            return ok("memoryIsolationV3 已关闭，private 写入已自动回退到共享 MEMORY.md。");
          }
          return ok(`已写入团队共享记忆 (MEMORY.md)。所有助理将在下次会话中看到此条目。`);
        }

        if (!assistantId) {
          return ok("保存失败：scope=private 需要 assistantId。请重试并携带 assistantId，或显式使用 scope=\"shared\"。");
        }

        new ScopedMemory(assistantId).appendLongTermMemory(content);
        return ok("已写入你的专属记忆。仅你可见，不会影响其他助理。");
      } catch (err) {
        return ok(`保存记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ── Query Team Memory (read-only cross-assistant search) ────────────────────

function createQueryTeamMemoryTool(assistantId?: string) {
  return tool(
    "query_team_memory",
    "跨助理搜索记忆（只读）。搜索其他助理的专属记忆中与关键词匹配的条目。\n" +
      "用途：当你在共享日志或索引中发现其他助理处理过相关话题时，用此工具获取详细上下文。\n" +
      "注意：只返回匹配的条目，不会修改任何记忆。",
    {
      query: z.string().describe("搜索关键词（支持多个词，空格分隔，任一匹配即返回）"),
      target_assistant_id: z.string().optional().describe("指定搜索某个助理的记忆（可选，不指定则搜索所有其他助理）"),
    },
    async (input) => {
      try {
        const query = String(input.query ?? "").trim();
        if (!query) return ok("query 不能为空");

        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const { assistants } = loadAssistantsConfig();
        const nameMap = new Map(assistants.map(a => [a.id, a.name]));

        const allIds = listAssistantIds();
        const targetIds = input.target_assistant_id
          ? allIds.filter(id => id === input.target_assistant_id)
          : allIds.filter(id => id !== assistantId);

        if (targetIds.length === 0) return ok("未找到匹配的助理。");

        const results: string[] = [];
        for (const id of targetIds) {
          const scoped = new ScopedMemory(id);
          const lt = scoped.readLongTermMemory();
          if (!lt.trim()) continue;

          const matchedLines = lt.split("\n").filter(line => {
            const lower = line.toLowerCase();
            return terms.some(t => lower.includes(t));
          });

          if (matchedLines.length > 0) {
            const name = nameMap.get(id) ?? id;
            results.push(`### ${name} (${id})\n${matchedLines.slice(0, 10).join("\n")}`);
          }
        }

        if (results.length === 0) return ok(`未找到与"${query}"相关的团队记忆。`);
        return ok(`**团队记忆搜索结果（关键词: ${query}）**\n\n${results.join("\n\n")}`);
      } catch (err) {
        return ok(`搜索团队记忆失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ── Memory Distillation ─────────────────────────────────────────────────────

const distillMemoryTool = tool(
  "distill_memory",
  "任务完成后调用此工具，触发结构化记忆蒸馏。系统会引导你提取本次任务中值得长期保留的信息。\n" +
    "适合时机：完成复杂任务后、发现重要环境事实后、踩坑并找到解决方案后。",
  {},
  async () => {
    const managementSop = readSop("memory-management");
    const sopSection = managementSop
      ? `\n以下是你的记忆管理 SOP，请严格遵循：\n${managementSop}\n`
      : "";

    return ok(
      `[记忆蒸馏启动]${sopSection}\n` +
      `请回顾本次任务，用 save_memory 工具按以下规则提取信息：\n\n` +
      `1. **环境事实**（路径/凭证/配置）→ save_memory(scope:"private", content:"- [P1|expire:YYYY-MM-DD] 内容")\n` +
      `   （YYYY-MM-DD 填今日+90天的日期，如今天是 ${new Date().toLocaleDateString("zh-CN", {year:"numeric",month:"2-digit",day:"2-digit"}).replace(/\//g,"-")}，则填 ${new Date(Date.now()+90*864e5).toISOString().slice(0,10)}）\n` +
      `2. **用户在你领域的偏好/决策** → save_memory(scope:"private", content:"- [P0] 内容")\n` +
      `3. **用户身份变更/团队级决策** → save_memory(scope:"shared", content:"- [P0] 内容")\n` +
      `4. **复杂任务流程**（多步骤、有踩坑点）→ 用 save_experience 沉淀为经验候选\n` +
      `5. **未完成任务/下次需继续的上下文** → 用 save_working_memory 保存\n` +
      `   （daily 日志由系统自动写入，无需手动处理）\n\n` +
      `━━ 分流判断 ━━\n` +
      `默认写专属记忆（private）。只有当信息对所有助理都有用时才写共享（shared）。\n\n` +
      `━━ 禁止记忆 ━━\n` +
      `- 临时变量、具体推理过程\n` +
      `- 未经验证的猜测\n` +
      `- 通用常识（你本来就知道的）\n` +
      `- 可以轻松复现的细节\n\n` +
      `请立即执行上述操作，完成后无需报告。`
    );
  },
);

// ── Atomic Power Tools (inspired by GenericAgent) ───────────────────────────

function createRunScriptTool(sessionCwd?: string) {
  return tool(
  "run_script",
  "执行脚本代码（Python / PowerShell / Node.js），支持超时控制。\n\n" +
    "适合场景：安装依赖、数据处理、系统操作、调用 API、运行复杂脚本。\n" +
    "与 Bash 工具的区别：支持多行脚本、超时保护、丰富的输出格式化。\n\n" +
    "注意：Python 脚本会优先使用应用托管的虚拟环境执行（自动初始化并复用已安装包），PowerShell/Node 直接执行。",
  {
    code: z.string().describe("要执行的代码"),
    language: z.enum(["python", "powershell", "node"]).describe("脚本语言"),
    timeout: z.number().optional().describe("超时秒数，默认 60 秒，最大 300 秒"),
    cwd: z.string().optional().describe("工作目录（可选）"),
  },
  async (input) => {
    const { exec, spawn } = await import("child_process");
    const { promisify } = await import("util");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const code = String(input.code ?? "").trim();
    if (!code) return ok("代码不能为空");

    const language = input.language ?? "python";
    const timeout = Math.min(Number(input.timeout ?? 60), 300) * 1000;
    const cwd = input.cwd ? String(input.cwd) : (sessionCwd || os.homedir());

    let cmd: string[];
    let tmpFile: string | null = null;

    if (language === "python") {
      tmpFile = path.join(os.tmpdir(), `vk-script-${Date.now()}.py`);
      fs.writeFileSync(tmpFile, code, "utf8");
      const pythonCmd = await ensurePythonEnv();
      if (!pythonCmd) {
        const hint = process.platform === "darwin"
          ? "macOS 请先安装 Homebrew，或手动安装 Python 3 后重试。"
          : process.platform === "win32"
            ? "Windows 请确认 winget 可用，或手动安装 Python 3 后重试。"
            : "请手动安装 Python 3 后重试。";
        return ok(`Python 未安装，且自动初始化托管环境失败。\n${hint}`);
      }
      cmd = [pythonCmd, "-X", "utf8", "-u", tmpFile];
    } else if (language === "powershell") {
      if (process.platform === "win32") {
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", code];
      } else {
        cmd = ["pwsh", "-NoProfile", "-NonInteractive", "-Command", code];
      }
    } else {
      cmd = ["node", "-e", code];
    }

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
          cwd,
          timeout,
          shell: false,
          windowsHide: true,
          env: process.env,
        });

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

        proc.on("close", (exitCode) => {
          resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
        });

        proc.on("error", (err) => {
          resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: -1 });
        });
      });

      const maxLen = 8000;
      let output = result.stdout;
      if (result.stderr) output += (output ? "\n" : "") + `[STDERR]\n${result.stderr}`;
      if (output.length > maxLen) {
        output = output.slice(0, maxLen / 2) + "\n...[truncated]...\n" + output.slice(-maxLen / 2);
      }

      const status = result.exitCode === 0 ? "✅" : "❌";
      return ok(`${status} Exit code: ${result.exitCode}\n\n${output || "(no output)"}`);
    } catch (err) {
      return ok(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }
  },
);
}

const desktopControlTool = tool(
  "desktop_control",
  "发送键盘输入或执行桌面自动化操作。\n\n" +
    "支持的操作类型：\n" +
    "- type: 输入文字\n" +
    "- key: 按下特定按键（如 Enter, Tab, Escape, ctrl+c, alt+f4）\n" +
    "- mouse_click: 在指定坐标点击（x, y）\n" +
    "- mouse_move: 移动鼠标到指定坐标\n\n" +
    "注意：操作直接作用于桌面，请确认目标窗口已获得焦点。",
  {
    action: z.enum(["type", "key", "mouse_click", "mouse_move"]).describe("操作类型"),
    text: z.string().optional().describe("要输入的文字（action=type 时必填）"),
    key: z.string().optional().describe("按键名（action=key 时必填，如 'Enter', 'Tab', 'ctrl+c', 'alt+f4'）"),
    x: z.number().optional().describe("鼠标 X 坐标（mouse 操作时必填）"),
    y: z.number().optional().describe("鼠标 Y 坐标（mouse 操作时必填）"),
    button: z.enum(["left", "right", "middle"]).optional().describe("鼠标按钮，默认 left"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const action = input.action;
    const platform = process.platform;

    try {
      if (platform === "win32") {
        return ok(await desktopControlWindows(execAsync, action, input));
      } else if (platform === "darwin") {
        return ok(await desktopControlMac(execAsync, action, input));
      } else {
        return ok(await desktopControlLinux(execAsync, action, input));
      }
    } catch (err) {
      return ok(`桌面操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

async function desktopControlWindows(
  execAsync: ExecFn,
  action: string,
  input: { text?: string; key?: string; x?: number; y?: number; button?: string },
): Promise<string> {
  if (action === "type" && input.text) {
    const escaped = input.text.replace(/'/g, "''");
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`,
    );
    return `已输入文字: ${input.text.slice(0, 50)}`;
  }

  if (action === "key" && input.key) {
    const keyMap: Record<string, string> = {
      enter: "{ENTER}", tab: "{TAB}", escape: "{ESC}", backspace: "{BS}",
      delete: "{DEL}", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
      home: "{HOME}", end: "{END}", "page_up": "{PGUP}", "page_down": "{PGDN}",
      f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}",
      space: " ",
    };
    let sendKey = input.key.toLowerCase();

    if (sendKey.includes("+")) {
      const parts = sendKey.split("+");
      const modifiers = parts.slice(0, -1);
      const baseKey = parts[parts.length - 1];
      let prefix = "";
      for (const m of modifiers) {
        if (m === "ctrl") prefix += "^";
        else if (m === "alt") prefix += "%";
        else if (m === "shift") prefix += "+";
      }
      sendKey = prefix + (keyMap[baseKey] ?? baseKey);
    } else {
      sendKey = keyMap[sendKey] ?? sendKey;
    }

    const escaped = sendKey.replace(/'/g, "''");
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`,
    );
    return `已按下: ${input.key}`;
  }

  if (action === "mouse_click" && input.x != null && input.y != null) {
    const btn = input.button === "right" ? 2 : 0;
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${input.x},${input.y}); ` +
        `Add-Type @'
using System; using System.Runtime.InteropServices;
public class MouseOp { [DllImport(\\"user32.dll\\")] public static extern void mouse_event(int f,int dx,int dy,int d,int e); }
'@; ` +
        `[MouseOp]::mouse_event(${btn === 0 ? "0x0002,0,0,0,0); [MouseOp]::mouse_event(0x0004" : "0x0008,0,0,0,0); [MouseOp]::mouse_event(0x0010"},0,0,0,0)"`,
    );
    return `已点击 (${input.x}, ${input.y}) [${input.button ?? "left"}]`;
  }

  if (action === "mouse_move" && input.x != null && input.y != null) {
    await execAsync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${input.x},${input.y})"`,
    );
    return `鼠标已移动到 (${input.x}, ${input.y})`;
  }

  return "无效操作，请检查参数";
}

async function desktopControlMac(
  execAsync: ExecFn,
  action: string,
  input: { text?: string; key?: string; x?: number; y?: number; button?: string },
): Promise<string> {
  if (action === "type" && input.text) {
    const escaped = input.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
    return `已输入文字: ${input.text.slice(0, 50)}`;
  }

  if (action === "key" && input.key) {
    const keyMap: Record<string, number> = {
      enter: 36, tab: 48, escape: 53, backspace: 51, delete: 117,
      up: 126, down: 125, left: 123, right: 124, space: 49,
      home: 115, end: 119,
    };
    let keyLower = input.key.toLowerCase();
    const parts = keyLower.split("+");

    if (parts.length > 1) {
      const modifiers = parts.slice(0, -1);
      const baseKey = parts[parts.length - 1];
      const modStr = modifiers.map(m => {
        if (m === "ctrl") return "control down";
        if (m === "alt" || m === "option") return "option down";
        if (m === "shift") return "shift down";
        if (m === "cmd" || m === "command") return "command down";
        return "";
      }).filter(Boolean).join(", ");

      const code = keyMap[baseKey];
      if (code !== undefined) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code} using {${modStr}}'`);
      } else {
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "${baseKey}" using {${modStr}}'`);
      }
    } else {
      const code = keyMap[keyLower];
      if (code !== undefined) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code}'`);
      } else {
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "${keyLower}"'`);
      }
    }
    return `已按下: ${input.key}`;
  }

  if ((action === "mouse_click" || action === "mouse_move") && input.x != null && input.y != null) {
    if (action === "mouse_click") {
      await execAsync(
        `osascript -e 'tell application "System Events" to click at {${input.x}, ${input.y}}'`,
      );
      return `已点击 (${input.x}, ${input.y})`;
    }
    return "macOS 不支持 osascript 移动鼠标，建议安装 cliclick";
  }

  return "无效操作，请检查参数";
}

async function desktopControlLinux(
  execAsync: ExecFn,
  action: string,
  input: { text?: string; key?: string; x?: number; y?: number; button?: string },
): Promise<string> {
  if (action === "type" && input.text) {
    const escaped = input.text.replace(/'/g, "'\\''");
    await execAsync(`xdotool type -- '${escaped}'`);
    return `已输入文字: ${input.text.slice(0, 50)}`;
  }

  if (action === "key" && input.key) {
    const keyStr = input.key.replace(/\+/g, "+");
    await execAsync(`xdotool key -- ${keyStr}`);
    return `已按下: ${input.key}`;
  }

  if (action === "mouse_click" && input.x != null && input.y != null) {
    const btn = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
    await execAsync(`xdotool mousemove ${input.x} ${input.y} click ${btn}`);
    return `已点击 (${input.x}, ${input.y}) [${input.button ?? "left"}]`;
  }

  if (action === "mouse_move" && input.x != null && input.y != null) {
    await execAsync(`xdotool mousemove ${input.x} ${input.y}`);
    return `鼠标已移动到 (${input.x}, ${input.y})`;
  }

  return "无效操作，请检查参数。Linux 需要安装 xdotool: sudo apt install xdotool";
}

const screenAnalyzeTool = tool(
  "screen_analyze",
  "截取桌面屏幕截图并返回文件路径和基本信息。\n" +
    "比 take_screenshot 更强大：支持指定区域截图、自动记录截图时的活动窗口信息。\n" +
    "截图保存为临时文件，可用于后续分析或发送给用户。",
  {
    region: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional().describe("截取区域（可选，不填则截全屏）"),
    description: z.string().optional().describe("截图目的描述（用于记录）"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");

    const filePath = path.join(os.tmpdir(), `vk-screen-${Date.now()}.png`);
    const platform = process.platform;

    try {
      let activeWindow = "unknown";

      if (platform === "darwin") {
        try {
          const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`);
          activeWindow = stdout.trim();
        } catch { /* ignore */ }

        if (input.region) {
          const r = input.region;
          await execAsync(`screencapture -R${r.x},${r.y},${r.width},${r.height} -x "${filePath}"`);
        } else {
          await execAsync(`screencapture -x "${filePath}"`);
        }
      } else if (platform === "win32") {
        try {
          const { stdout } = await execAsync(
            `powershell -Command "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object CPU -Descending | Select-Object -First 1).MainWindowTitle"`,
          );
          activeWindow = stdout.trim();
        } catch { /* ignore */ }

        if (input.region) {
          const r = input.region;
          await execAsync(
            `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
              `$b=New-Object System.Drawing.Bitmap(${r.width},${r.height}); ` +
              `$g=[System.Drawing.Graphics]::FromImage($b); ` +
              `$g.CopyFromScreen(${r.x},${r.y},0,0,[System.Drawing.Size]::new(${r.width},${r.height})); ` +
              `$b.Save('${filePath}')"`,
          );
        } else {
          await execAsync(
            `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
              `$b=New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
              `$g=[System.Drawing.Graphics]::FromImage($b); ` +
              `$g.CopyFromScreen(0,0,0,0,$b.Size); ` +
              `$b.Save('${filePath}')"`,
          );
        }
      } else {
        try {
          const { stdout } = await execAsync(`xdotool getactivewindow getwindowname`);
          activeWindow = stdout.trim();
        } catch { /* ignore */ }

        if (input.region) {
          const r = input.region;
          await execAsync(`gnome-screenshot -a -f "${filePath}" 2>/dev/null || scrot -a ${r.x},${r.y},${r.width},${r.height} "${filePath}"`);
        } else {
          await execAsync(`gnome-screenshot -f "${filePath}" 2>/dev/null || scrot "${filePath}"`);
        }
      }

      if (!fs.existsSync(filePath)) {
        return { content: [{ type: "text" as const, text: "截图文件未生成" }], isError: true };
      }

      const stat = fs.statSync(filePath);
      const info: string[] = [
        `截图已保存: ${filePath}`,
        `文件大小: ${(stat.size / 1024).toFixed(1)}KB`,
        `活动窗口: ${activeWindow}`,
        `时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ];
      if (input.region) {
        info.push(`区域: (${input.region.x},${input.region.y}) ${input.region.width}x${input.region.height}`);
      }
      if (input.description) {
        info.push(`用途: ${input.description}`);
      }

      return ok(info.join("\n"));
    } catch (err) {
      return ok(`截图失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const processControlTool = tool(
  "process_control",
  "管理系统进程：列出进程、终止进程、检查端口占用。\n\n" +
    "适合场景：排查端口冲突、关闭僵尸进程、查看资源占用。",
  {
    action: z.enum(["list", "kill", "find_by_port"]).describe("操作类型"),
    pid: z.number().optional().describe("进程 PID（action=kill 时必填）"),
    port: z.number().optional().describe("端口号（action=find_by_port 时必填）"),
    filter: z.string().optional().describe("进程名过滤（action=list 时可选）"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const platform = process.platform;

    try {
      if (input.action === "list") {
        const filter = input.filter ? String(input.filter) : "";
        let cmd: string;
        if (platform === "win32") {
          cmd = filter
            ? `tasklist /FI "IMAGENAME eq *${filter}*" /FO CSV /NH`
            : `powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Id,ProcessName,CPU,WorkingSet | Format-Table -AutoSize"`;
        } else {
          cmd = filter
            ? `ps aux | grep -i "${filter}" | head -20`
            : `ps aux --sort=-%cpu | head -20`;
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout || "无结果");
      }

      if (input.action === "kill" && input.pid != null) {
        if (platform === "win32") {
          await execAsync(`taskkill /PID ${input.pid} /F`);
        } else {
          await execAsync(`kill -9 ${input.pid}`);
        }
        return ok(`进程 ${input.pid} 已终止`);
      }

      if (input.action === "find_by_port" && input.port != null) {
        let cmd: string;
        if (platform === "win32") {
          cmd = `netstat -ano | findstr :${input.port}`;
        } else {
          cmd = `lsof -i :${input.port} 2>/dev/null || netstat -tlnp 2>/dev/null | grep :${input.port}`;
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout || `端口 ${input.port} 未被占用`);
      }

      return ok("无效操作，请检查参数");
    } catch (err) {
      return ok(`进程操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const clipboardTool = tool(
  "clipboard",
  "读取或写入系统剪贴板内容。\n\n" +
    "适合场景：获取用户复制的内容、将结果放入剪贴板方便粘贴。",
  {
    action: z.enum(["read", "write"]).describe("操作类型"),
    content: z.string().optional().describe("要写入剪贴板的内容（action=write 时必填）"),
  },
  async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const platform = process.platform;

    try {
      if (input.action === "read") {
        let cmd: string;
        if (platform === "win32") {
          cmd = `powershell -Command "Get-Clipboard"`;
        } else if (platform === "darwin") {
          cmd = "pbpaste";
        } else {
          cmd = "xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output";
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout || "(剪贴板为空)");
      }

      if (input.action === "write" && input.content) {
        const content = input.content;
        if (platform === "win32") {
          const escaped = content.replace(/'/g, "''");
          await execAsync(`powershell -Command "Set-Clipboard -Value '${escaped}'"`);
        } else if (platform === "darwin") {
          const escaped = content.replace(/'/g, "'\\''");
          await execAsync(`echo '${escaped}' | pbcopy`);
        } else {
          const escaped = content.replace(/'/g, "'\\''");
          await execAsync(`echo '${escaped}' | xclip -selection clipboard 2>/dev/null || echo '${escaped}' | xsel --clipboard --input`);
        }
        return ok(`已写入剪贴板: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
      }

      return ok("无效操作，请检查参数");
    } catch (err) {
      return ok(`剪贴板操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const systemInfoTool = tool(
  "system_info",
  "获取系统环境信息：OS 版本、CPU/内存使用、磁盘空间、网络接口、已安装的工具版本。\n" +
    "适合场景：环境检查、排障、了解当前系统状态。",
  {
    category: z.enum(["overview", "disk", "network", "tools"]).optional().describe("信息类别，默认 overview"),
  },
  async (input) => {
    const os = await import("os");
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const category = input.category ?? "overview";

    try {
      if (category === "overview") {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const info = [
          `平台: ${os.platform()} ${os.arch()} ${os.release()}`,
          `主机名: ${os.hostname()}`,
          `CPU: ${cpus[0]?.model ?? "unknown"} (${cpus.length} cores)`,
          `内存: ${(freeMem / 1024 / 1024 / 1024).toFixed(1)}GB 可用 / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB 总计`,
          `运行时间: ${(os.uptime() / 3600).toFixed(1)} 小时`,
        ];
        return ok(info.join("\n"));
      }

      if (category === "disk") {
        let cmd: string;
        if (process.platform === "win32") {
          cmd = `powershell -Command "Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free,@{Name='Size(GB)';Expression={[math]::Round(($_.Used+$_.Free)/1GB,1)}} -AutoSize"`;
        } else {
          cmd = "df -h";
        }
        const { stdout } = await execAsync(cmd);
        return ok(stdout);
      }

      if (category === "network") {
        const interfaces = os.networkInterfaces();
        const lines: string[] = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
          if (!addrs) continue;
          for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
              lines.push(`${name}: ${addr.address}`);
            }
          }
        }
        return ok(lines.length ? lines.join("\n") : "无活动网络接口");
      }

      if (category === "tools") {
        const checks = [
          { name: "Node.js", cmd: "node --version" },
          { name: "npm", cmd: "npm --version" },
          { name: "Git", cmd: "git --version" },
          { name: "Docker", cmd: "docker --version" },
        ];
        const results: string[] = [];
        for (const check of checks) {
          try {
            const { stdout } = await execAsync(check.cmd);
            results.push(`${check.name}: ${stdout.trim()}`);
          } catch {
            results.push(`${check.name}: 未安装`);
          }
        }

        const managedPython = await getManagedPythonInfo();
        if (managedPython.version && managedPython.path) {
          results.push(`Python (managed): ${managedPython.version}`);
          results.push(`Python env: ${managedPython.path}`);
        } else {
          results.push("Python (managed): 未初始化");
          results.push(`Python env: ${getPythonEnvDir()}`);
        }
        results.push(
          `Python packages: ${managedPython.packages.length ? managedPython.packages.join(", ") : "(none)"}`,
        );

        try {
          const systemPythonCmd = process.platform === "win32" ? "python --version" : "python3 --version";
          const { stdout, stderr } = await execAsync(systemPythonCmd);
          const version = `${stdout}\n${stderr}`.trim();
          results.push(`Python (system): ${version || "已安装"}`);
        } catch {
          results.push("Python (system): 未安装");
        }

        return ok(results.join("\n"));
      }

      return ok("未知类别");
    } catch (err) {
      return ok(`获取系统信息失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// ── Plan Table Tools ─────────────────────────────────────────────────────────

function createUpsertPlanItemTool(assistantId?: string, contextScheduledTaskId?: string) {
  return tool(
    "upsert_plan_item",
    "创建或更新一条计划项。用于在执行 SOP 过程中记录计划步骤和进度。\n" +
      "如果已存在相同 sopName + assistantId + targetId 的计划项，则更新；否则创建新项。\n" +
      "当 SOP 针对多个目标（如多个学生）时，必须传入 target_id 和 target_name 以区分。\n\n" +
      "使用时机：\n" +
      "- 开始执行 SOP 某步骤前，创建计划项（status=pending 或 in_progress）\n" +
      "- 步骤进展中更新状态和内容",
    {
      sop_name: z.string().describe("SOP 步骤名称，如 'T-1 课前准备'、'月度结算'"),
      category: z.enum(["客户服务", "情报监控", "内部运营", "增长销售"]).optional().describe("一级分类，建议始终传入"),
      target_id: z.string().optional().describe("目标 ID，用于去重匹配，如 'student-001'。同一 SOP 针对不同目标时必填"),
      target_name: z.string().optional().describe("目标显示名称，如 '张三'。留空则使用 target_id"),
      content: z.string().describe("具体执行内容描述"),
      scheduled_time: z.string().optional().describe("计划执行时间，ISO 格式（可选）"),
      status: z.enum(["pending", "in_progress", "human_review", "completed", "failed"]).optional().describe("状态，默认 pending"),
      result: z.string().optional().describe("执行结果摘要（可选）"),
      session_id: z.string().optional().describe("关联的会话 ID（可选）"),
    },
    async (input) => {
      try {
        const item = upsertPlanItem({
          sopName: String(input.sop_name),
          category: input.category ?? undefined,
          targetId: input.target_id ? String(input.target_id) : undefined,
          targetName: input.target_name ? String(input.target_name) : undefined,
          assistantId: assistantId ?? "",
          content: String(input.content),
          scheduledTime: input.scheduled_time ? String(input.scheduled_time) : undefined,
          status: input.status ?? "pending",
          result: input.result ? String(input.result) : undefined,
          sessionId: input.session_id ? String(input.session_id) : undefined,
          scheduledTaskId: contextScheduledTaskId,
        });
        const targetLabel = item.targetName ? `\n- 目标：${item.targetName}` : "";
        const categoryLabel = item.category ? `\n- 分类：${item.category}` : "";
        return ok(
          `计划项已${item.createdAt === item.updatedAt ? "创建" : "更新"}：\n` +
            `- SOP：${item.sopName}${targetLabel}${categoryLabel}\n- 内容：${item.content.slice(0, 80)}\n` +
            `- 状态：${item.status}\n- ID：${item.id}`,
        );
      } catch (err) {
        return ok(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

function createCompletePlanItemTool(assistantId?: string) {
  return tool(
    "complete_plan_item",
    "标记一条计划项为已完成，附带执行结果摘要。",
    {
      plan_item_id: z.string().optional().describe("计划项 ID（与 sop_name 二选一）"),
      sop_name: z.string().optional().describe("SOP 步骤名称（与 plan_item_id 二选一）"),
      target_id: z.string().optional().describe("目标 ID，多目标场景下用于精确匹配"),
      result: z.string().describe("执行结果摘要"),
      session_id: z.string().optional().describe("关联的会话 ID（可选）"),
    },
    async (input) => {
      try {
        const items = loadPlanItems();
        let target: PlanItem | undefined;
        if (input.plan_item_id) {
          target = items.find((i) => i.id === input.plan_item_id);
        } else if (input.sop_name) {
          const tid = input.target_id ?? "";
          target = items.find(
            (i) => i.sopName === input.sop_name
              && (!assistantId || i.assistantId === assistantId)
              && i.targetId === tid,
          );
        }
        if (!target) return ok("未找到匹配的计划项。请检查 plan_item_id 或 sop_name + target_id。");

        const updated = updatePlanItem(target.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
          result: String(input.result),
          ...(input.session_id && { sessionId: String(input.session_id) }),
        });
        const label = updated?.targetName ? ` [${updated.targetName}]` : "";
        return ok(`计划项已完成：${updated?.sopName ?? target.sopName}${label}\n结果：${input.result.slice(0, 120)}`);
      } catch (err) {
        return ok(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

function createFailPlanItemTool(assistantId?: string) {
  return tool(
    "fail_plan_item",
    "标记一条计划项为失败，记录失败原因。系统会自动发送钉钉告警通知。",
    {
      plan_item_id: z.string().optional().describe("计划项 ID（与 sop_name 二选一）"),
      sop_name: z.string().optional().describe("SOP 步骤名称（与 plan_item_id 二选一）"),
      target_id: z.string().optional().describe("目标 ID，多目标场景下用于精确匹配"),
      reason: z.string().describe("失败原因"),
    },
    async (input) => {
      try {
        const items = loadPlanItems();
        let target: PlanItem | undefined;
        if (input.plan_item_id) {
          target = items.find((i) => i.id === input.plan_item_id);
        } else if (input.sop_name) {
          const tid = input.target_id ?? "";
          target = items.find(
            (i) => i.sopName === input.sop_name
              && (!assistantId || i.assistantId === assistantId)
              && i.targetId === tid,
          );
        }
        if (!target) return ok("未找到匹配的计划项。请检查 plan_item_id 或 sop_name + target_id。");

        updatePlanItem(target.id, {
          status: "failed",
          result: String(input.reason),
        });

        const targetLabel = target.targetName ? ` [${target.targetName}]` : "";
        const aid = target.assistantId || assistantId;
        if (aid) {
          sendProactiveDingtalkMessage(aid, `**⚠️ 计划项执行失败**\n\n- SOP：${target.sopName}${targetLabel}\n- 内容：${target.content}\n- 原因：${input.reason}`, {
            title: `计划项失败: ${target.sopName}${targetLabel}`,
          }).catch((err: unknown) => {
            console.error("[PlanStore] Failed to send DingTalk alert:", err);
          });
        }

        return ok(`计划项已标记失败：${target.sopName}${targetLabel}\n原因：${input.reason}\n已发送钉钉告警通知。`);
      } catch (err) {
        return ok(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

function createListPlanItemsTool(assistantId?: string) {
  return tool(
    "list_plan_items",
    "查询计划项列表，可按状态、目标或助理筛选。",
    {
      status: z.enum(["pending", "in_progress", "human_review", "completed", "failed"]).optional().describe("按状态筛选（可选）"),
      target_id: z.string().optional().describe("按目标 ID 筛选（可选）"),
      target_name: z.string().optional().describe("按目标名称筛选（可选，模糊匹配）"),
      all_assistants: z.boolean().optional().describe("是否查看所有助理的计划项，默认只看当前助理"),
    },
    async (input) => {
      try {
        let items = loadPlanItems();
        if (!input.all_assistants && assistantId) {
          items = items.filter((i) => i.assistantId === assistantId);
        }
        if (input.status) {
          items = items.filter((i) => i.status === input.status);
        }
        if (input.target_id) {
          items = items.filter((i) => i.targetId === input.target_id);
        }
        if (input.target_name) {
          const q = input.target_name.toLowerCase();
          items = items.filter((i) => i.targetName.toLowerCase().includes(q));
        }
        if (items.length === 0) return ok("当前没有匹配的计划项。");

        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: tz, hour12: false });

        const statusIcons: Record<string, string> = { pending: "⏳", in_progress: "🔄", human_review: "👀", completed: "✅", failed: "❌" };
        const lines = items.map((i) => {
          const icon = statusIcons[i.status] ?? "•";
          const targetLabel = i.targetName ? ` [${i.targetName}]` : "";
          return (
            `- ${icon} **${i.sopName}**${targetLabel}\n` +
            `  内容：${i.content.slice(0, 80)}\n` +
            `  时间：${fmt(i.scheduledTime)} | 状态：${i.status}\n` +
            (i.result ? `  结果：${i.result.slice(0, 80)}\n` : "") +
            `  ID：\`${i.id}\``
          );
        });

        return ok(`**计划项列表（${items.length} 条）**\n\n${lines.join("\n\n")}`);
      } catch (err) {
        return ok(`查询失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ── Proactive notification tool (Telegram > Feishu > DingTalk) ───────────────

/**
 * Per-channel cooldown: key = "telegram:assistantId" | "feishu:assistantId" | "dingtalk:assistantId"
 * Cooldown window matches the assistant's heartbeatInterval to prevent flooding between heartbeat ticks.
 */
const notificationCooldowns = new Map<string, number>();
const DEFAULT_COOLDOWN_MINUTES = 30;

function getCooldownMs(assistantId?: string): number {
  const { assistants } = loadAssistantsConfig();
  const a = assistants.find((x) => x.id === assistantId);
  const minutes = a?.heartbeatInterval ?? DEFAULT_COOLDOWN_MINUTES;
  return minutes * 60_000;
}

function isChannelOnCooldown(platform: string, targetId: string, cooldownMs: number): boolean {
  const key = `${platform}:${targetId}`;
  const last = notificationCooldowns.get(key) ?? 0;
  return Date.now() - last < cooldownMs;
}

function markChannelUsed(platform: string, targetId: string): void {
  notificationCooldowns.set(`${platform}:${targetId}`, Date.now());
}

/**
 * Direct notification push — callable from scheduled tasks without an AI session.
 * Returns { ok, channel?, error? }.
 */
export async function sendNotificationDirect(
  text: string,
  opts?: { assistantId?: string; skipCooldown?: boolean },
): Promise<{ ok: boolean; channel?: string; error?: string }> {
  const assistantId = opts?.assistantId;
  const skipCooldown = opts?.skipCooldown ?? true; // scheduled tasks skip cooldown by default
  const cooldownMs = getCooldownMs(assistantId);

  const resolveId = (
    exactId: string | undefined,
    getExactStatus: (id: string) => string,
    getAnyId: () => string | null,
  ): string | null => {
    if (exactId && getExactStatus(exactId) === "connected") return exactId;
    return getAnyId();
  };

  const channels: Array<{ name: string; id: string | null; send: (id: string) => Promise<{ ok: boolean; error?: string }> }> = [
    {
      name: "telegram",
      id: resolveId(assistantId, getTelegramBotStatus, getAnyConnectedTelegramAssistantId),
      send: (id) => sendProactiveTelegramMessage(id, text),
    },
    {
      name: "feishu",
      id: resolveId(assistantId, getFeishuBotStatus, getAnyConnectedFeishuAssistantId),
      send: (id) => sendProactiveFeishuMessage(id, text),
    },
    {
      name: "qqbot",
      id: resolveId(assistantId, getQQBotStatus, getAnyConnectedQQBotAssistantId),
      send: (id) => sendProactiveQQMessage(id, text),
    },
    {
      name: "dingtalk",
      id: resolveId(assistantId, getDingtalkBotStatus, getAnyConnectedDingtalkAssistantId),
      send: (id) => sendProactiveDingtalkMessage(id, text),
    },
  ];

  for (const ch of channels) {
    if (!ch.id) continue;
    if (!skipCooldown && isChannelOnCooldown(ch.name, ch.id, cooldownMs)) continue;
    const result = await ch.send(ch.id);
    if (result.ok) {
      markChannelUsed(ch.name, ch.id);
      appendNotified({ summary: text.slice(0, 120), ts: Date.now(), assistantId: assistantId ?? "" });
      return { ok: true, channel: ch.name };
    }
  }

  return { ok: false, error: "no connected channel" };
}

function createSendNotificationTool(assistantId?: string) {
  return tool(
    "send_notification",
    "向用户发送主动通知。自动按优先级选择已连接的渠道：Telegram > 飞书 > QQ > 钉钉，只发一个渠道。冷却时长与助理心跳间隔一致，防止多个助理心跳造成消息轰炸。",
    {
      text: z.string().describe("通知内容（支持 Markdown）"),
      title: z.string().optional().describe("通知标题（可选，部分渠道会用到）"),
      urgent: z.boolean().optional().describe("紧急通知：设为 true 可跳过冷却限制，立即发送"),
    },
    async (input) => {
      const text = input.title ? `**${input.title}**\n\n${input.text}` : input.text;
      const result = await sendNotificationDirect(text, {
        assistantId,
        skipCooldown: input.urgent === true,
      });
      if (result.ok) {
        const channelNames: Record<string, string> = { telegram: "Telegram", feishu: "飞书", dingtalk: "钉钉" };
        return ok(`通知已通过 ${channelNames[result.channel!] ?? result.channel} 发送。`);
      }
      return ok("无可用推送渠道（Telegram / 飞书 / 钉钉 均未连接或未配置接收者）。");
    },
  );
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a shared MCP server instance for a Claude agent session.
 * When assistantId is provided, working memory tools are scoped to
 * that assistant's private directory. SOP tools remain shared.
 * When sessionCwd is provided, run_script defaults to that directory.
 */

// ── Tool catalog for SOP generation ─────────────────────────────────────────

export interface ToolCatalogEntry {
  name: string;
  category: string;
  description: string;
  sopExclude?: true; // exclude from SOP generation prompts; framework handles this automatically
}

/**
 * Static metadata catalog of all tools available in the shared MCP server.
 * Used by sop.generate to inject an accurate, up-to-date tool list into the
 * generation prompt — replacing the old hardcoded alias list.
 */
export const SHARED_TOOL_CATALOG: ToolCatalogEntry[] = [
  // Scheduler — SOP scheduling is managed by the framework (sop.setSopSchedule); excluded from SOP generation prompts
  { name: "create_scheduled_task",  category: "调度", description: "创建一次性或周期性定时任务，到期自动启动 AI 会话执行", sopExclude: true },
  { name: "list_scheduled_tasks",   category: "调度", description: "列出当前所有定时任务及其状态", sopExclude: true },
  { name: "delete_scheduled_task",  category: "调度", description: "删除指定定时任务", sopExclude: true },
  // register_sop_schedule — for conversational use only; excluded from SOP generation prompts (framework manages SOP schedules)
  { name: "register_sop_schedule",  category: "调度", description: "为指定 SOP 设置或更新定时调度（幂等，隐藏任务）", sopExclude: true },
  // Web & Documents
  { name: "web_search",   category: "网络", description: "通过 DuckDuckGo 搜索网络，返回 top 结果" },
  { name: "web_fetch",    category: "网络", description: "抓取指定 URL 内容并以纯文本返回" },
  { name: "read_document", category: "文件", description: "读取本地文件（PDF/Word/Excel/文本/CSV）内容" },
  // Memory
  { name: "save_memory",         category: "记忆", description: "保存长期记忆条目（private 专属 / shared 团队共享）" },
  { name: "save_working_memory", category: "记忆", description: "保存当前任务上下文的工作记忆检查点" },
  // framework injects prevOutput automatically; manual read is redundant and confusing in SOP stages
  { name: "read_working_memory", category: "记忆", description: "读取最近保存的工作记忆检查点", sopExclude: true },
  { name: "query_team_memory",   category: "记忆", description: "跨助理只读搜索记忆，获取其他助理的历史上下文", sopExclude: true },
  // memory management ops, not business tools
  { name: "distill_memory",      category: "记忆", description: "任务完成后触发结构化记忆蒸馏，提取值得长期保留的信息", sopExclude: true },
  // Experience documentation — writes to knowledge/experience/ as draft
  { name: "save_experience", category: "记忆", description: "沉淀操作经验文档（步骤、踩坑点等），写入知识库候选", sopExclude: true },
  // Script & Automation
  { name: "run_script",      category: "脚本", description: "执行 Python / PowerShell / Node.js 脚本，支持超时控制" },
  { name: "desktop_control", category: "桌面", description: "发送键盘输入或控制鼠标，实现桌面自动化" },
  { name: "take_screenshot", category: "桌面", description: "截取当前桌面屏幕截图" },
  { name: "screen_analyze",  category: "桌面", description: "截取屏幕并返回路径和活动窗口信息" },
  { name: "process_control", category: "系统", description: "列出、启动或终止系统进程" },
  { name: "clipboard",       category: "系统", description: "读取或写入系统剪贴板内容" },
  { name: "system_info",     category: "系统", description: "获取 OS / CPU / 内存 / 磁盘 / 网络等系统环境信息" },
  // Plan Table — managed automatically by the workflow framework; excluded from SOP generation prompts
  { name: "upsert_plan_item",    category: "计划", description: "创建或更新计划表中的一条任务项", sopExclude: true },
  { name: "complete_plan_item",  category: "计划", description: "将计划任务项标记为已完成", sopExclude: true },
  { name: "fail_plan_item",      category: "计划", description: "将计划任务项标记为失败并记录原因", sopExclude: true },
  { name: "list_plan_items",     category: "计划", description: "列出计划表中的所有任务项", sopExclude: true },
  // Notification
  { name: "send_notification", category: "通知", description: "向用户发送主动通知（Telegram > 飞书 > QQ > 钉钉 优先级）" },
  // News & Social
  { name: "news_latest",         category: "资讯", description: "获取最新加密货币/财经资讯（含 AI 评分和交易信号）" },
  { name: "news_search",         category: "资讯", description: "按关键词搜索加密货币/财经资讯" },
  { name: "twitter_user_tweets", category: "社交", description: "获取指定 Twitter/X 用户的最近推文" },
  { name: "twitter_search",      category: "社交", description: "搜索 Twitter/X 推文（支持关键词/话题/用户过滤）" },
  // Workflow SOP — conversational creation & execution; must not appear in SOP stage steps
  { name: "list_sops",                 category: "SOP工作流", description: "列出所有工作流 SOP（HAND.toml）", sopExclude: true },
  { name: "generate_sop",              category: "SOP工作流", description: "根据描述生成新的工作流 SOP（异步）", sopExclude: true },
  { name: "execute_sop",               category: "SOP工作流", description: "启动一个工作流 SOP 执行（异步，新会话中运行）", sopExclude: true },
  { name: "query_sop_run_status",      category: "SOP工作流", description: "查询工作流 SOP 的执行状态", sopExclude: true },
  { name: "query_sop_generate_status", category: "SOP工作流", description: "查询异步 SOP 生成任务的状态", sopExclude: true },
];

// ── SOP Workflow Engine Callbacks ──────────────────────────────────────────────

export interface SopEngineCallbacks {
  listSops(): Array<{ id: string; name: string; description: string; category: string }>;
  generateSop(description: string): string; // returns taskId
  executeSop(sopNameOrId: string): { runId: string; sopId: string; sopName: string };
  queryRunStatus(sopNameOrId: string): {
    sopId: string; sopName: string; status: string;
    stages: Array<{ name: string; status: string; abstract?: string }>;
  } | null;
  queryGenerateStatus(taskId: string): {
    taskId: string; status: string; sopId?: string; sopName?: string; error?: string;
  } | null;
}

let _sopCallbacks: SopEngineCallbacks | null = null;

export function registerSopEngineCallbacks(cb: SopEngineCallbacks) {
  _sopCallbacks = cb;
}

const listSopWorkflowsTool = tool(
  "list_sops",
  "列出所有工作流 SOP（HAND.toml 定义的自动化流程），返回 ID、名称、描述和分类。",
  {},
  async () => {
    if (!_sopCallbacks) return ok("SOP 引擎未就绪，请稍后重试");
    try {
      const sops = _sopCallbacks.listSops();
      if (sops.length === 0) return ok("暂无工作流 SOP。可用 generate_sop 创建新的。");
      const lines = sops.map(s =>
        `- **${s.name}**（${s.category}）— ${s.description}\n  ID: ${s.id}`
      );
      return ok(`**工作流 SOP（共 ${sops.length} 个）**\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return ok(`列出 SOP 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const generateSopTool = tool(
  "generate_sop",
  "根据自然语言描述生成一个新的工作流 SOP（异步）。返回 taskId，用 query_sop_generate_status 查询进度。\n\n" +
    "生成通常需要 1-2 分钟。生成完成后 SOP 会自动出现在列表中。",
  {
    description: z.string().describe("SOP 描述，说明要自动化什么任务、包含哪些步骤、使用什么工具"),
  },
  async (input) => {
    if (!_sopCallbacks) return ok("SOP 引擎未就绪，请稍后重试");
    try {
      const desc = String(input.description ?? "").trim();
      if (!desc) return ok("描述不能为空");
      const taskId = _sopCallbacks.generateSop(desc);
      return ok(`SOP 生成任务已启动\ntaskId: ${taskId}\n\n用 query_sop_generate_status 查询进度，通常需要 1-2 分钟。`);
    } catch (err) {
      return ok(`启动 SOP 生成失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const executeSopTool = tool(
  "execute_sop",
  "启动一个工作流 SOP 的执行。SOP 会在新的会话窗口中按阶段逐步运行。\n" +
    "支持用 SOP 名称或 ID 指定。如果 SOP 正在执行中则会报错。",
  {
    sop_name_or_id: z.string().describe("SOP 名称或 ID"),
  },
  async (input) => {
    if (!_sopCallbacks) return ok("SOP 引擎未就绪，请稍后重试");
    try {
      const nameOrId = String(input.sop_name_or_id ?? "").trim();
      if (!nameOrId) return ok("请提供 SOP 名称或 ID");
      const result = _sopCallbacks.executeSop(nameOrId);
      return ok(`SOP「${result.sopName}」已启动执行\nrunId: ${result.runId}\nsopId: ${result.sopId}\n\n用 query_sop_run_status 查询执行进度。`);
    } catch (err) {
      return ok(`启动 SOP 执行失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const querySopRunStatusTool = tool(
  "query_sop_run_status",
  "查询指定工作流 SOP 的最近一次执行状态，包含每个阶段的进度和摘要。",
  {
    sop_name_or_id: z.string().describe("SOP 名称或 ID"),
  },
  async (input) => {
    if (!_sopCallbacks) return ok("SOP 引擎未就绪，请稍后重试");
    try {
      const nameOrId = String(input.sop_name_or_id ?? "").trim();
      if (!nameOrId) return ok("请提供 SOP 名称或 ID");
      const result = _sopCallbacks.queryRunStatus(nameOrId);
      if (!result) return ok(`未找到 SOP「${nameOrId}」的执行记录。`);

      const stageLines = result.stages.map((s, i) => {
        let line = `${i + 1}. **${s.name}** — ${s.status}`;
        if (s.abstract) line += `\n   摘要: ${s.abstract}`;
        return line;
      });
      return ok(
        `**SOP「${result.sopName}」执行状态: ${result.status}**\n\n` +
        stageLines.join("\n")
      );
    } catch (err) {
      return ok(`查询执行状态失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const querySopGenerateStatusTool = tool(
  "query_sop_generate_status",
  "查询异步 SOP 生成任务的状态。传入 generate_sop 返回的 taskId。",
  {
    task_id: z.string().describe("生成任务 ID（generate_sop 返回的 taskId）"),
  },
  async (input) => {
    if (!_sopCallbacks) return ok("SOP 引擎未就绪，请稍后重试");
    try {
      const taskId = String(input.task_id ?? "").trim();
      if (!taskId) return ok("请提供任务 ID");
      const result = _sopCallbacks.queryGenerateStatus(taskId);
      if (!result) return ok(`未找到生成任务「${taskId}」。`);

      if (result.status === "completed") {
        return ok(`SOP 生成完成!\n名称: ${result.sopName}\nID: ${result.sopId}\n\n可用 execute_sop 启动执行，或用 list_sops 查看列表。`);
      } else if (result.status === "failed") {
        return ok(`SOP 生成失败: ${result.error || "未知错误"}`);
      } else {
        return ok(`SOP 正在生成中...请稍后再查询。`);
      }
    } catch (err) {
      return ok(`查询生成状态失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

export function createSharedMcpServer(opts?: { assistantId?: string; sessionId?: string; sessionCwd?: string; workflowSopId?: string; scheduledTaskId?: string }) {
  const assistantId = opts?.assistantId;
  const sessionId = opts?.sessionId;
  const sessionCwd = opts?.sessionCwd;
  const workflowSopId = opts?.workflowSopId;
  const scheduledTaskId = opts?.scheduledTaskId;

  // When executing a scheduled task, exclude scheduler tools to prevent
  // infinite recursion (AI creating new tasks instead of executing the prompt)
  const isScheduledRun = !!scheduledTaskId && !workflowSopId;

  return createSdkMcpServer({
    name: "vk-shared",
    version: "2.0.0",
    tools: [
      // Scheduler — excluded during scheduled task execution to prevent loops
      ...(isScheduledRun ? [] : [
        createScheduledTaskTool(workflowSopId),
        listScheduledTasksTool,
        deleteScheduledTaskTool,
        createRegisterSopScheduleTool(workflowSopId),
      ]),
      // Web & Documents
      webSearchTool,
      webFetchTool,
      readDocumentTool,
      // Screen & Desktop
      takeScreenshotTool,
      screenAnalyzeTool,
      desktopControlTool,
      // Experience documentation (shared across all assistants)
      createSaveExperienceTool(sessionId, assistantId),
      // Working Memory (scoped to assistant if ID provided)
      createSaveWorkingMemoryTool(assistantId),
      createReadWorkingMemoryTool(assistantId),
      // Long-term Memory (scoped — private by default)
      createSaveMemoryTool(assistantId),
      // Cross-assistant memory search (read-only)
      createQueryTeamMemoryTool(assistantId),
      // Memory Distillation
      distillMemoryTool,
      // Atomic Power Tools
      createRunScriptTool(sessionCwd),
      processControlTool,
      clipboardTool,
      systemInfoTool,
      // 6551 OpenNews — crypto/financial news with AI ratings
      newsLatestTool,
      newsSearchTool,
      // 6551 OpenTwitter — Twitter/X data
      twitterUserTweetsTool,
      twitterSearchTool,
      // Plan Table (AI writes, frontend reads)
      createUpsertPlanItemTool(assistantId, scheduledTaskId),
      createCompletePlanItemTool(assistantId),
      createFailPlanItemTool(assistantId),
      createListPlanItemsTool(assistantId),
      // Proactive notification (Telegram > Feishu > DingTalk priority)
      createSendNotificationTool(assistantId),
      // Workflow SOP (conversational creation & execution)
      listSopWorkflowsTool,
      generateSopTool,
      executeSopTool,
      querySopRunStatusTool,
      querySopGenerateStatusTool,
    ],
  });
}
