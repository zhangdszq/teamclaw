/**
 * Memory Store — OpenClaw Memory 2.0 + SOP Self-Evolution
 *
 * L0/L1/L2 retrieval layers + P0/P1/P2 lifecycle + .abstract index
 * + SOP auto-growth (inspired by GenericAgent)
 * + Working Memory Checkpoints
 *
 * ~/.vk-cowork/memory/
 * ├── .abstract              L0 root index (auto-generated manifest)
 * ├── MEMORY.md              team-shared long-term memory (P0/P1/P2 lifecycle tags)
 * ├── SESSION-STATE.md       working buffer (legacy, migrated to per-assistant)
 * ├── daily/                 L2 shared daily logs (one file per day)
 * ├── insights/              L1 monthly distillation (shared, legacy)
 * ├── lessons/               L1 structured lessons
 * ├── sops/                  legacy experience docs (read-only, no longer written)
 * ├── archive/               expired P1/P2 items
 * └── assistants/{id}/
 *     ├── MEMORY.md           per-assistant private long-term memory
 *     ├── SESSION-STATE.md    per-assistant working memory
 *     ├── daily/              per-assistant conversation logs
 *     └── insights/           per-assistant monthly distillation
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { readFile as readFileAsync } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { homedir } from "os";
import { loadAssistantsConfig } from "./assistants-config.js";
import { loadUserSettingsAsync } from "./user-settings.js";
import { listKnowledgeDocs } from "./knowledge-store.js";

// Write lock to prevent concurrent writes
const writeLocks = new Map<string, Promise<void>>();
const ASSISTANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MEMORY_ENTRY_MAX_CHARS = 8_000;
const MEMORY_CONTEXT_MAX_CHARS = 80_000;
const WORKING_MEMORY_VERSION_LIMIT = 5;
const MEMORY_CONTEXT_SECTION_LIMITS = {
  abstract: { max: 12_000, min: 4_000 },
  longTerm: { max: 16_000, min: 6_000 },
  privateLongTerm: { max: 14_000, min: 4_000 },
  sessionState: { max: 8_000, min: 2_000 },
  sharedDaily: { max: 10_000, min: 2_000 },
  assistantDaily: { max: 10_000, min: 2_000 },
} as const;

// ─── Paths ──────────────────────────────────────────────────

const MEMORY_ROOT        = join(homedir(), ".vk-cowork", "memory");
const LONG_TERM_FILE     = join(MEMORY_ROOT, "MEMORY.md");
const SESSION_STATE_FILE = join(MEMORY_ROOT, "SESSION-STATE.md");
const ROOT_ABSTRACT      = join(MEMORY_ROOT, ".abstract");
const DAILY_DIR          = join(MEMORY_ROOT, "daily");
const INSIGHTS_DIR       = join(MEMORY_ROOT, "insights");
const LESSONS_DIR        = join(MEMORY_ROOT, "lessons");
const ARCHIVE_DIR        = join(MEMORY_ROOT, "archive");
const SOPS_DIR           = join(MEMORY_ROOT, "sops");
const ASSISTANTS_DIR     = join(MEMORY_ROOT, "assistants");
const MIGRATION_MARKER   = join(MEMORY_ROOT, ".migrated-v2");

const ALL_DIRS = [MEMORY_ROOT, DAILY_DIR, INSIGHTS_DIR, LESSONS_DIR, ARCHIVE_DIR, SOPS_DIR];

export type AssistantTaskStatus = "pending" | "in_progress" | "completed";
export type AssistantTask = {
  id: string;
  title: string;
  status: AssistantTaskStatus;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
};

type ValidateMemoryEntryOptions = {
  requireLifecycleTag?: boolean;
  allowMarkdownBlocks?: boolean;
  maxChars?: number;
};

type MemoryContextSectionKey = keyof typeof MEMORY_CONTEXT_SECTION_LIMITS;
type MemoryContextSection = {
  key: MemoryContextSectionKey;
  title: string;
  rawContent: string;
  limit: number;
  minLimit: number;
};

// ─── Per-assistant path helpers ──────────────────────────────

export function assertSafeAssistantId(assistantId: string): string {
  const normalized = String(assistantId ?? "").trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    !ASSISTANT_ID_RE.test(normalized)
  ) {
    throw new Error(`Invalid assistantId: ${assistantId}`);
  }
  return normalized;
}

export function isConfiguredAssistantId(assistantId: string): boolean {
  try {
    const safeAssistantId = assertSafeAssistantId(assistantId);
    return loadAssistantsConfig().assistants.some((assistant) => assistant.id === safeAssistantId);
  } catch {
    return false;
  }
}

export function deleteAssistantMemoryRoot(assistantId: string): void {
  const safeAssistantId = assertSafeAssistantId(assistantId);
  const root = join(ASSISTANTS_DIR, safeAssistantId);
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
  _memoryContextCache.clear();
}

function getAssistantMemoryRoot(assistantId: string): string {
  return join(ASSISTANTS_DIR, assertSafeAssistantId(assistantId));
}

function sanitizeContactKey(contactKey: string): string {
  const raw = String(contactKey ?? "").trim();
  if (!raw) return "contact";
  return raw.replace(/[\/\\\.]+/g, "_") || "contact";
}

export function getAssistantContactMemoryRoot(assistantId: string, contactKey: string): string {
  return join(getAssistantMemoryRoot(assistantId), "contacts", sanitizeContactKey(contactKey));
}

function getScopedMemoryRoot(assistantId: string, contactKey?: string): string {
  return contactKey
    ? getAssistantContactMemoryRoot(assistantId, contactKey)
    : getAssistantMemoryRoot(assistantId);
}

function ensureScopedMemoryDirs(assistantId: string, contactKey?: string): void {
  const root = getScopedMemoryRoot(assistantId, contactKey);
  for (const sub of ["daily", "insights", "lessons", "archive"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function ensureAssistantDirs(assistantId: string): void {
  ensureScopedMemoryDirs(assistantId);
}

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

const SEED_MEMORY_MANAGEMENT_SOP = `# Memory Management SOP

本 SOP 定义了记忆系统的管理规则。Agent 可根据实践经验更新此文件。

## 写入前检查清单
- [ ] 信息是否经过实际验证？（未验证的猜测禁止写入）
- [ ] 是否已有类似记录？（优先更新，避免重复）
- [ ] 生命周期标签是否正确？（P0 永久 / P1 90天 / P2 30天）

## 记忆写入规则
默认用 save_memory 写入专属记忆（scope: "private"）：
- P0: 你与用户的交互偏好、业务上下文（永久）
- P1: 项目架构决策、技术方案选型、环境配置（90天后过期）
- P2: 临时测试地址、一次性配置（30天后过期）
仅团队级信息（用户身份、全员决策）写入共享记忆（scope: "shared"）
- 格式: \`- [P0] 内容\` 或 \`- [P1|expire:YYYY-MM-DD] 内容\`

## SOP 写入规则
- 只为多步骤且踩过坑的任务创建 SOP
- 必须包含: 前置条件、关键步骤、踩坑点、验证方法
- 命名: 动词-对象-目标（如 "部署-nextjs-到-vercel"）

## Daily 写入规则
- 每次会话结束追加摘要（一两句话即可）
- 格式: \`## HH:MM 简述\` + 要点列表

## 禁止写入
- 推理过程和中间思考
- 通用编程知识
- 可轻松复现的操作细节
`;

function ensureDirs(): void {
  for (const dir of ALL_DIRS) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // Seed empty .abstract files for sub-directories on first run
  for (const dir of [INSIGHTS_DIR, LESSONS_DIR]) {
    const abs = join(dir, ".abstract");
    if (!existsSync(abs)) {
      writeFileSync(abs, `# ${dir.split("/").pop()} index\n## recency\n- initialized: ${localDateStr()}\n`, "utf8");
    }
  }

  // Seed memory-management SOP if not exists
  const mmSopPath = join(SOPS_DIR, "memory-management.md");
  if (!existsSync(mmSopPath)) {
    writeFileSync(mmSopPath, SEED_MEMORY_MANAGEMENT_SOP, "utf8");
  }

  // ── V2 Migration: move per-assistant data to assistants/default-assistant/ ──
  if (!existsSync(MIGRATION_MARKER)) {
    const defaultAssistantDir = join(ASSISTANTS_DIR, "default-assistant");

    const itemsToMigrate = [
      { src: SESSION_STATE_FILE, dest: join(defaultAssistantDir, "SESSION-STATE.md"), isFile: true },
      { src: INSIGHTS_DIR, dest: join(defaultAssistantDir, "insights"), isFile: false },
      { src: LESSONS_DIR, dest: join(defaultAssistantDir, "lessons"), isFile: false },
      { src: ARCHIVE_DIR, dest: join(defaultAssistantDir, "archive"), isFile: false },
    ];

    let migrated = false;
    for (const item of itemsToMigrate) {
      if (!existsSync(item.src)) continue;
      try {
        if (item.isFile) {
          const content = readFileSync(item.src, "utf8");
          if (content.trim()) {
            if (!existsSync(defaultAssistantDir)) mkdirSync(defaultAssistantDir, { recursive: true });
            copyFileSync(item.src, item.dest);
            renameSync(item.src, item.src + ".pre-v2");
            migrated = true;
          }
        } else {
          const entries = readdirSync(item.src).filter(f => f.endsWith(".md"));
          if (entries.length > 0) {
            copyDirRecursive(item.src, item.dest);
            renameSync(item.src, item.src + ".pre-v2");
            migrated = true;
          }
        }
      } catch (err) {
        console.warn(`[Memory] Migration warning for ${item.src}:`, err);
      }
    }

    // Recreate shared dirs that were renamed during migration
    for (const dir of [INSIGHTS_DIR, LESSONS_DIR, ARCHIVE_DIR]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    writeFileSync(MIGRATION_MARKER, `migrated at ${new Date().toISOString()}\nbackups: *.pre-v2\n`, "utf8");
    if (migrated) {
      console.log("[Memory] V2 migration complete: per-assistant data moved to assistants/default-assistant/");
    }
  }
}

export function getMemoryDir(): string {
  ensureDirs();
  return MEMORY_ROOT;
}

// ─── Date helpers (local time — fixes UTC off-by-one) ────────

export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function localMonthStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dailyPath(date: string): string {
  return join(DAILY_DIR, `${date}.md`);
}

function appendTextFile(filePath: string, content: string): void {
  const normalized = content.trimEnd();
  if (!normalized) return;
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let prefix = "";
  try {
    prefix = existsSync(filePath) && statSync(filePath).size > 0 ? "\n" : "";
  } catch {
    prefix = "";
  }
  appendFileSync(filePath, `${prefix}${normalized}`, "utf8");
}

function rotateWorkingMemoryVersions(filePath: string, previousContent: string): void {
  const dir = dirname(filePath);
  const overflowPath = join(dir, `SESSION-STATE.v${WORKING_MEMORY_VERSION_LIMIT}.md`);
  if (existsSync(overflowPath)) {
    try { unlinkSync(overflowPath); } catch { /* ignore */ }
  }
  for (let i = WORKING_MEMORY_VERSION_LIMIT - 1; i >= 1; i -= 1) {
    const src = join(dir, `SESSION-STATE.v${i}.md`);
    const dest = join(dir, `SESSION-STATE.v${i + 1}.md`);
    if (!existsSync(src)) continue;
    try { renameSync(src, dest); } catch { /* ignore */ }
  }
  atomicWrite(join(dir, "SESSION-STATE.v1.md"), previousContent);
}

function writeWorkingMemoryWithHistory(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (previous.trim() && previous !== content) {
    rotateWorkingMemoryVersions(filePath, previous);
  }
  atomicWrite(filePath, content);
  _memoryContextCache.clear();
}

function normalizeMemoryEntryContent(content: string): string {
  return String(content ?? "")
    .replace(/\[\/P[012][^\]]*\]/g, "")
    .trim();
}

export function validateMemoryEntry(
  content: string,
  opts: ValidateMemoryEntryOptions = {},
): { ok: boolean; normalized: string; message?: string } {
  const normalized = normalizeMemoryEntryContent(content);
  if (!normalized) {
    return { ok: false, normalized, message: "content 不能为空" };
  }

  const maxChars = opts.maxChars ?? MEMORY_ENTRY_MAX_CHARS;
  if (normalized.length > maxChars) {
    return {
      ok: false,
      normalized,
      message: `内容过长：最多允许 ${maxChars} 个字符`,
    };
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());

  if (!opts.allowMarkdownBlocks) {
    const invalidListLine = lines.find((line) => !/^[-*]\s+/.test(line.trimStart()));
    if (invalidListLine) {
      return {
        ok: false,
        normalized,
        message: "每个条目必须以 '- ' 或 '* ' 开头。",
      };
    }
  }

  if (opts.requireLifecycleTag) {
    const invalidLifecycleLine = lines.find(
      (line) => !/^[-*]\s+\[(?:P0|P1\|expire:\d{4}-\d{2}-\d{2}|P2\|expire:\d{4}-\d{2}-\d{2})\]\s+/.test(line.trimStart()),
    );
    if (invalidLifecycleLine) {
      return {
        ok: false,
        normalized,
        message: "每个条目必须以 '- [P0] ' / '- [P1|expire:YYYY-MM-DD] ' / '- [P2|expire:YYYY-MM-DD] ' 开头。",
      };
    }
  }

  return { ok: true, normalized };
}

// ─── Atomic write with lock ───────────────────────────────────

async function atomicWriteWithLock(filePath: string, content: string): Promise<void> {
  // Wait for any existing write to this file to complete
  let lockPromise = writeLocks.get(filePath);
  if (lockPromise) {
    await lockPromise;
  }

  // Create new lock
  const writePromise = (async () => {
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, content, "utf8");
    try {
      renameSync(tmp, filePath);
    } catch {
      // Windows: destination may already exist
      try { unlinkSync(filePath); } catch { /* ignore */ }
      renameSync(tmp, filePath);
    }
  })();

  writeLocks.set(filePath, writePromise);
  try {
    await writePromise;
  } finally {
    writeLocks.delete(filePath);
  }
}

// Sync version for backward compatibility (without lock)
function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    // Windows: destination may already exist
    try { unlinkSync(filePath); } catch { /* ignore */ }
    renameSync(tmp, filePath);
  }
}

// ─── Async read helper ────────────────────────────────────────

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFileAsync(filePath, "utf8");
  } catch {
    return "";
  }
}

// ─── Long-term memory (MEMORY.md) ────────────────────────────

export function readLongTermMemory(): string {
  ensureDirs();
  if (!existsSync(LONG_TERM_FILE)) return "";
  return readFileSync(LONG_TERM_FILE, "utf8");
}

export function writeLongTermMemory(content: string): void {
  ensureDirs();
  atomicWrite(LONG_TERM_FILE, content);
  _memoryContextCache.clear();
  try { refreshRootAbstract(); } catch { /* non-blocking */ }
}

// ─── Session state buffer (SESSION-STATE.md) ─────────────────

export function readSessionState(): string {
  ensureDirs();
  if (!existsSync(SESSION_STATE_FILE)) return "";
  return readFileSync(SESSION_STATE_FILE, "utf8");
}

export function writeSessionState(content: string): void {
  ensureDirs();
  atomicWrite(SESSION_STATE_FILE, content);
  _memoryContextCache.clear();
}

export function clearSessionState(): void {
  if (existsSync(SESSION_STATE_FILE)) atomicWrite(SESSION_STATE_FILE, "");
}

// ─── Daily (L2) ───────────────────────────────────────────────

export function readDailyMemory(date: string): string {
  ensureDirs();
  const p = dailyPath(date);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function appendDailyMemory(content: string, date?: string): void {
  ensureDirs();
  const p = dailyPath(date ?? localDateStr());
  appendTextFile(p, content);
  _memoryContextCache.clear();
  // Refresh root abstract after each write (non-blocking)
  try { refreshRootAbstract(); } catch { /* ignore */ }
}

export function writeDailyMemory(content: string, date: string): void {
  ensureDirs();
  atomicWrite(dailyPath(date), content);
  _memoryContextCache.clear();
}

export function readRecentDailyMemories(): {
  today: string; yesterday: string; todayDate: string; yesterdayDate: string;
} {
  const td = localDateStr();
  const yd = localYesterday();
  return {
    today: readDailyMemory(td),
    yesterday: readDailyMemory(yd),
    todayDate: td,
    yesterdayDate: yd,
  };
}

// ─── .abstract (L0 index) ─────────────────────────────────────

export function readAbstract(dir: string = MEMORY_ROOT): string {
  const p = join(dir, ".abstract");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function writeAbstract(dir: string, content: string): void {
  atomicWrite(join(dir, ".abstract"), content);
}

/**
 * Extract the first non-empty, non-heading line from content as a brief summary.
 */
function extractFirstLineSummary(content: string, maxLen = 80): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith(">") && !trimmed.startsWith("---")) {
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
    }
  }
  return "";
}

/**
 * Auto-generate root .abstract from file manifest.
 * When assistantId is provided, the index merges shared data with that
 * assistant's private data, using clearly separated sections.
 */
export function refreshRootAbstract(assistantId?: string): void {
  ensureDirs();

  const memDir = MEMORY_ROOT.replace(/\\/g, "/");
  const scoped = assistantId ? new ScopedMemory(assistantId) : null;

  const dailies = listDailyMemories();
  const recentDailies = dailies.slice(0, 10);

  const lt = readLongTermMemory();
  const headings = (lt.match(/^#+\s+.+/gm) ?? []).slice(0, 10);
  const taggedItems = (lt.match(/^[-*]\s+\[P[012][^\]]*\].{0,60}/gm) ?? []).slice(0, 8);
  const topicLines = headings.length ? headings : taggedItems;

  const lines: string[] = [
    `# memory index (${memDir})`,
    "",
    "## 共享知识 (所有助理可见)",
    "",
  ];

  // Shared SOPs
  const sops = listSops();
  if (sops.length) {
    lines.push("### SOPs (存量经验文档) — 路径: sops/{名称}.md（已停止写入，新经验请用 save_experience）");
    sops.forEach(s => lines.push(`- ${s.name}: ${s.description || "(no description)"}  [${s.updatedAt}]`));
    lines.push("");
  }

  // Knowledge docs (from ~/.vk-cowork/knowledge/docs/)
  try {
    const kDocs = listKnowledgeDocs().slice(0, 20);
    if (kDocs.length) {
      lines.push("### 知识文档 — 路径: ~/.vk-cowork/knowledge/docs/{id}.md");
      kDocs.forEach(d => {
        const summary = d.content.replace(/\n/g, " ").slice(0, 60);
        lines.push(`- ${d.title}: ${summary}...  [${d.updatedAt.slice(0, 10)}]`);
      });
      lines.push("");
    }
  } catch { /* knowledge-store unavailable */ }

  // Shared daily summaries
  lines.push("### 近期共享日志 — 路径: daily/{日期}.md");
  if (recentDailies.length) {
    for (const d of recentDailies) {
      const content = readDailyMemory(d.date);
      const summary = extractFirstLineSummary(content);
      lines.push(`- ${d.date}: ${summary || `(${(d.size / 1024).toFixed(1)}KB)`}`);
    }
  } else {
    lines.push("- (empty)");
  }
  lines.push("");

  // Long-term memory sections
  lines.push("### 团队共享记忆 (MEMORY.md)");
  if (topicLines.length) {
    topicLines.forEach(l => lines.push(l));
  } else {
    lines.push("- (empty)");
  }
  lines.push("");

  // Per-assistant section
  if (scoped) {
    lines.push(`## 你的记忆 (${assistantId})`, "");

    // Per-assistant private MEMORY.md
    const privateLt = scoped.readLongTermMemory();
    const privateTagged = (privateLt.match(/^[-*]\s+\[P[012][^\]]*\].{0,60}/gm) ?? []).slice(0, 8);
    if (privateTagged.length) {
      lines.push(`### 专属长期记忆 — 路径: assistants/${assistantId}/MEMORY.md`);
      privateTagged.forEach(l => lines.push(l));
      lines.push("");
    }

    const assistantDailies = scoped.listDailies().slice(0, 10);
    if (assistantDailies.length) {
      lines.push(`### 近期对话日志 — 路径: assistants/${assistantId}/daily/{日期}.md`);
      for (const d of assistantDailies) {
        const content = scoped.readDaily(d.date);
        const summary = extractFirstLineSummary(content);
        lines.push(`- ${d.date}: ${summary || `(${(d.size / 1024).toFixed(1)}KB)`}`);
      }
      lines.push("");
    }

    const sessionState = scoped.readSessionState().trim();
    if (sessionState) {
      lines.push("### 工作记忆: 有活跃检查点", "");
    }

    // Per-assistant insights
    const aInsightsDir = join(scoped.rootDir, "insights");
    if (existsSync(aInsightsDir)) {
      const insightFiles = readdirSync(aInsightsDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5);
      if (insightFiles.length) {
        lines.push(`### insights — 路径: assistants/${assistantId}/insights/{月份}.md`);
        insightFiles.forEach(f => lines.push(`- ${f}`));
        lines.push("");
      }
    }
  }

  // Other assistants' memory topics (for cross-assistant discovery)
  if (assistantId) {
    const otherIds = listAssistantIds().filter(id => id !== assistantId);
    const otherTopics: string[] = [];
    for (const id of otherIds) {
      const other = new ScopedMemory(id);
      const otherLt = other.readLongTermMemory();
      const tags = (otherLt.match(/^[-*]\s+\[P[012][^\]]*\]\s*.{0,40}/gm) ?? []).length;
      if (tags > 0) {
        const topicSample = (otherLt.match(/^[-*]\s+\[P0\]\s*(.{0,50})/gm) ?? [])
          .slice(0, 3)
          .map(l => l.replace(/^[-*]\s+\[P0\]\s*/, "").trim())
          .filter(Boolean);
        const topicStr = topicSample.length ? topicSample.join("、") : "(无 P0 条目)";
        otherTopics.push(`- ${id}: ${tags} 条记忆 | ${topicStr}`);
      }
    }
    if (otherTopics.length) {
      lines.push("## 其他助理记忆主题（可用 query_team_memory 查询详情）");
      otherTopics.forEach(l => lines.push(l));
      lines.push("");
    }
  }

  // Shared insights (legacy)
  const insightFiles = existsSync(INSIGHTS_DIR)
    ? readdirSync(INSIGHTS_DIR).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5)
    : [];
  if (insightFiles.length) {
    lines.push("## insights (共享 L1) — 路径: insights/{月份}.md");
    insightFiles.forEach(f => lines.push(`- insights/${f}`));
    lines.push("");
  }

  lines.push(
    "## recency",
    `- last updated: ${localDateStr()} ${new Date().toTimeString().slice(0, 5)}`,
  );

  writeAbstract(MEMORY_ROOT, lines.join("\n"));
}

// ─── List ─────────────────────────────────────────────────────

export type MemoryFileInfo = {
  date: string;
  path: string;
  size: number;
};

export function listDailyMemories(): MemoryFileInfo[] {
  ensureDirs();
  if (!existsSync(DAILY_DIR)) return [];
  return readdirSync(DAILY_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const p = join(DAILY_DIR, f);
      const content = existsSync(p) ? readFileSync(p, "utf8") : "";
      return { date: f.replace(".md", ""), path: p, size: Buffer.byteLength(content, "utf8") };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getMemorySummary(): { longTermSize: number; privateLongTermSize: number; dailyCount: number; totalSize: number } {
  const lt = readLongTermMemory();
  const dailies = listDailyMemories();
  const dailyTotalSize = dailies.reduce((sum, d) => sum + d.size, 0);
  const ltSize = Buffer.byteLength(lt, "utf8");
  return { longTermSize: ltSize, privateLongTermSize: 0, dailyCount: dailies.length, totalSize: ltSize + dailyTotalSize };
}

// ─── SOP (Standard Operating Procedures) ─────────────────────

export type SopInfo = {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  description: string;
};

function sopPath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_");
  return join(SOPS_DIR, `${safeName}.md`);
}

function extractSopDescription(content: string): string {
  const firstLine = content.split("\n").find(l => l.trim() && !l.startsWith("#"));
  if (firstLine) return firstLine.trim().slice(0, 120);
  const heading = content.match(/^#+\s+(.+)/m);
  return heading ? heading[1].trim().slice(0, 120) : "";
}

export function readSop(name: string): string {
  ensureDirs();
  const p = sopPath(name);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function writeSop(name: string, content: string): void {
  ensureDirs();
  atomicWrite(sopPath(name), content);
  try { refreshRootAbstract(); } catch { /* non-blocking */ }
}

export function deleteSop(name: string): boolean {
  const p = sopPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  try { refreshRootAbstract(); } catch { /* non-blocking */ }
  return true;
}

export function listSops(): SopInfo[] {
  ensureDirs();
  if (!existsSync(SOPS_DIR)) return [];
  return readdirSync(SOPS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const p = join(SOPS_DIR, f);
      const content = readFileSync(p, "utf8");
      const stat = statSync(p);
      return {
        name: f.replace(".md", ""),
        path: p,
        size: Buffer.byteLength(content, "utf8"),
        updatedAt: localDateStr(stat.mtime),
        description: extractSopDescription(content),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function searchSops(query: string): SopInfo[] {
  if (!query.trim()) return listSops();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listSops().filter(sop => {
    const text = (sop.name + " " + sop.description).toLowerCase();
    return terms.some(term => text.includes(term));
  });
}

// ─── Working Memory (per-session structured checkpoint) ──────
// Legacy global functions kept for backward compatibility.
// Prefer ScopedMemory methods for per-assistant operations.

export function readWorkingMemory(): string {
  return readSessionState();
}

export function writeWorkingMemory(checkpoint: {
  keyInfo: string;
  currentTask?: string;
  relatedSops?: string[];
  history?: string[];
}): void {
  ensureDirs();
  const lines: string[] = [
    `# Working Memory Checkpoint`,
    `> Updated: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
  ];
  if (checkpoint.currentTask) {
    lines.push(`## 当前任务`, checkpoint.currentTask, "");
  }
  if (checkpoint.keyInfo) {
    lines.push(`## 关键上下文`, checkpoint.keyInfo, "");
  }
  if (checkpoint.relatedSops?.length) {
    lines.push(`## 相关 SOP`, ...checkpoint.relatedSops.map(s => `- ${s}`), "");
  }
  if (checkpoint.history?.length) {
    lines.push(`## 操作历史`, ...checkpoint.history.slice(-20).map(h => `- ${h}`), "");
  }
  writeWorkingMemoryWithHistory(SESSION_STATE_FILE, lines.join("\n"));
}

// ─── ScopedMemory (per-assistant memory operations) ──────────

export type WorkingMemoryCheckpoint = {
  keyInfo: string;
  currentTask?: string;
  relatedSops?: string[];
  history?: string[];
};

/**
 * Per-assistant scoped memory. Ensures all operations target the correct
 * assistant subdirectory so `assistantId` cannot be accidentally dropped.
 */
export class ScopedMemory {
  public readonly assistantId: string;
  public readonly contactKey?: string;
  private readonly root: string;

  get rootDir(): string { return this.root; }

  constructor(assistantId: string, contactKey?: string) {
    this.assistantId = assistantId;
    this.contactKey = contactKey?.trim() || undefined;
    this.root = getScopedMemoryRoot(assistantId, this.contactKey);
    ensureScopedMemoryDirs(assistantId, this.contactKey);
  }

  private _dailyDir(): string { return join(this.root, "daily"); }
  private _dailyPath(date: string): string { return join(this._dailyDir(), `${date}.md`); }
  private _sessionStatePath(): string { return join(this.root, "SESSION-STATE.md"); }
  private _insightsDir(): string { return join(this.root, "insights"); }
  private _archiveDir(): string { return join(this.root, "archive"); }

  readSessionState(): string {
    const p = this._sessionStatePath();
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8");
  }

  async readSessionStateAsync(): Promise<string> {
    return readFileOrEmpty(this._sessionStatePath());
  }

  writeSessionState(content: string): void {
    atomicWrite(this._sessionStatePath(), content);
    _memoryContextCache.clear();
  }

  clearSessionState(): void {
    const p = this._sessionStatePath();
    if (existsSync(p)) atomicWrite(p, "");
    _memoryContextCache.clear();
  }

  readDaily(date: string): string {
    const p = this._dailyPath(date);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8");
  }

  async readDailyAsync(date: string): Promise<string> {
    return readFileOrEmpty(this._dailyPath(date));
  }

  appendDaily(content: string, date?: string): void {
    const p = this._dailyPath(date ?? localDateStr());
    appendTextFile(p, content);
    _memoryContextCache.clear();
  }

  writeDaily(content: string, date: string): void {
    atomicWrite(this._dailyPath(date), content);
    _memoryContextCache.clear();
  }

  listDailies(): MemoryFileInfo[] {
    const dir = this._dailyDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => {
        const p = join(dir, f);
        const content = existsSync(p) ? readFileSync(p, "utf8") : "";
        return { date: f.replace(".md", ""), path: p, size: Buffer.byteLength(content, "utf8") };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  readWorkingMemory(): string {
    return this.readSessionState();
  }

  writeWorkingMemory(checkpoint: WorkingMemoryCheckpoint): void {
    const lines: string[] = [
      `# Working Memory Checkpoint`,
      `> Updated: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      "",
    ];
    if (checkpoint.currentTask) lines.push(`## 当前任务`, checkpoint.currentTask, "");
    if (checkpoint.keyInfo) lines.push(`## 关键上下文`, checkpoint.keyInfo, "");
    if (checkpoint.relatedSops?.length) lines.push(`## 相关 SOP`, ...checkpoint.relatedSops.map(s => `- ${s}`), "");
    if (checkpoint.history?.length) lines.push(`## 操作历史`, ...checkpoint.history.slice(-20).map(h => `- ${h}`), "");
    writeWorkingMemoryWithHistory(this._sessionStatePath(), lines.join("\n"));
  }

  // ── Per-assistant long-term memory (private MEMORY.md) ──

  private _longTermPath(): string { return join(this.root, "MEMORY.md"); }

  readLongTermMemory(): string {
    const p = this._longTermPath();
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8");
  }

  async readLongTermMemoryAsync(): Promise<string> {
    return readFileOrEmpty(this._longTermPath());
  }

  writeLongTermMemory(content: string): void {
    atomicWrite(this._longTermPath(), content);
    _memoryContextCache.clear();
    if (!this.contactKey) {
      try { refreshRootAbstract(this.assistantId); } catch { /* non-blocking */ }
    }
  }

  appendLongTermMemory(entry: string): void {
    const p = this._longTermPath();
    const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
    const newContent = existing.trim() ? existing.trimEnd() + "\n" + entry : entry;
    atomicWrite(p, newContent);
    _memoryContextCache.clear();
    if (!this.contactKey) {
      try { refreshRootAbstract(this.assistantId); } catch { /* non-blocking */ }
    }
  }

  getMemorySummary(): { longTermSize: number; privateLongTermSize: number; dailyCount: number; totalSize: number } {
    const lt = readLongTermMemory();
    const plt = this.readLongTermMemory();
    const dailies = this.listDailies();
    const dailyTotalSize = dailies.reduce((sum, d) => sum + d.size, 0);
    const ltSize = Buffer.byteLength(lt, "utf8");
    const pltSize = Buffer.byteLength(plt, "utf8");
    return { longTermSize: ltSize, privateLongTermSize: pltSize, dailyCount: dailies.length, totalSize: ltSize + pltSize + dailyTotalSize };
  }

  /**
   * Scan this assistant's private MEMORY.md for expired P1/P2 items,
   * archive them to assistants/{id}/archive/YYYY-MM.md.
   */
  runJanitor(): { archived: number; cleaned: string[] } {
    const lt = this.readLongTermMemory();
    if (!lt) return { archived: 0, cleaned: [] };

    const today = localDateStr();
    const lines = lt.split("\n");
    const kept: string[] = [];
    const expired: string[] = [];

    for (const line of lines) {
      const m = line.match(LIFECYCLE_RE);
      if (line.includes("[P0]")) {
        kept.push(line);
      } else if (m && m[1] < today) {
        expired.push(line);
      } else {
        kept.push(line);
      }
    }

    if (expired.length === 0) return { archived: 0, cleaned: [] };

    const archiveDir = this._archiveDir();
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    const archiveFile = join(archiveDir, `${localMonthStr()}.md`);
    const existing = existsSync(archiveFile) ? readFileSync(archiveFile, "utf8") : "";
    atomicWrite(archiveFile, existing + `\n## Archived ${today}\n` + expired.join("\n") + "\n");

    this.writeLongTermMemory(kept.join("\n"));
    console.log(`[MemoryJanitor] Archived ${expired.length} expired item(s) from ${this.assistantId} private MEMORY.md.`);

    return { archived: expired.length, cleaned: expired };
  }
}

function tasksPath(assistantId: string, contactKey?: string): string {
  return join(getScopedMemoryRoot(assistantId, contactKey), "tasks.json");
}

function normalizeTaskStatus(status?: string): AssistantTaskStatus {
  if (status === "completed" || status === "in_progress") return status;
  return "pending";
}

function loadAssistantTasksRaw(assistantId: string, opts?: { contactKey?: string }): AssistantTask[] {
  ensureScopedMemoryDirs(assistantId, opts?.contactKey);
  const p = tasksPath(assistantId, opts?.contactKey);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        id: String(item.id ?? "").trim(),
        title: String(item.title ?? "").trim(),
        status: normalizeTaskStatus(typeof item.status === "string" ? item.status : undefined),
        dueDate: item.dueDate ? String(item.dueDate) : undefined,
        createdAt: String(item.createdAt ?? new Date().toISOString()),
        updatedAt: String(item.updatedAt ?? new Date().toISOString()),
      }))
      .filter((item) => item.id && item.title);
  } catch {
    return [];
  }
}

function saveAssistantTasksRaw(assistantId: string, tasks: AssistantTask[], opts?: { contactKey?: string }): void {
  atomicWrite(tasksPath(assistantId, opts?.contactKey), JSON.stringify(tasks, null, 2));
  _memoryContextCache.clear();
}

export function listAssistantTasks(
  assistantId: string,
  opts?: { includeCompleted?: boolean; contactKey?: string },
): AssistantTask[] {
  const tasks = loadAssistantTasksRaw(assistantId, opts);
  const filtered = opts?.includeCompleted
    ? tasks
    : tasks.filter((task) => task.status !== "completed");
  return filtered.sort((left, right) => {
    const leftDue = left.dueDate ?? "9999-99-99";
    const rightDue = right.dueDate ?? "9999-99-99";
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function upsertAssistantTask(
  assistantId: string,
  input: { id?: string; title: string; status?: AssistantTaskStatus; dueDate?: string },
  opts?: { contactKey?: string },
): AssistantTask {
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title 不能为空");

  const now = new Date().toISOString();
  const tasks = loadAssistantTasksRaw(assistantId, opts);
  const existing = input.id ? tasks.find((task) => task.id === input.id) : undefined;

  if (existing) {
    existing.title = title;
    existing.status = normalizeTaskStatus(input.status);
    existing.dueDate = input.dueDate?.trim() || undefined;
    existing.updatedAt = now;
    saveAssistantTasksRaw(assistantId, tasks, opts);
    return existing;
  }

  const created: AssistantTask = {
    id: input.id?.trim() || randomUUID(),
    title,
    status: normalizeTaskStatus(input.status),
    dueDate: input.dueDate?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(created);
  saveAssistantTasksRaw(assistantId, tasks, opts);
  return created;
}

export function completeAssistantTask(
  assistantId: string,
  taskId: string,
  opts?: { contactKey?: string },
): AssistantTask | null {
  const tasks = loadAssistantTasksRaw(assistantId, opts);
  const target = tasks.find((task) => task.id === taskId);
  if (!target) return null;
  target.status = "completed";
  target.updatedAt = new Date().toISOString();
  saveAssistantTasksRaw(assistantId, tasks, opts);
  return target;
}

// ─── Dual-write conversation logger ─────────────────────────

/**
 * Record a conversation to both shared daily (summary) and assistant-private daily (full).
 * Callers only need to invoke this once — dual-write is automatic.
 */
export function recordConversation(
  content: string,
  opts: {
    assistantId?: string;
    assistantName?: string;
    channel?: string;
    contactKey?: string;
    isOwner?: boolean;
  },
): void {
  const { assistantId, assistantName, channel, contactKey, isOwner } = opts;

  // 1. Full content → assistant's private daily
  if (assistantId) {
    const scoped = new ScopedMemory(assistantId, contactKey);
    scoped.appendDaily(content);
  }

  if (contactKey && isOwner === false) {
    return;
  }

  // 2. One-line summary → shared daily (tagged with source)
  const firstLine = content.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "";
  const summary = firstLine.slice(0, 80);
  const tag = channel && assistantName
    ? `[${channel}/${assistantName}]`
    : `[${assistantName ?? "assistant"}]`;
  appendDailyMemory(`- ${new Date().toLocaleTimeString("zh-CN")} ${tag} ${summary}`);
}

// ─── List all assistant IDs ─────────────────────────────────

export function listAssistantIds(): string[] {
  if (!existsSync(ASSISTANTS_DIR)) return [];
  return readdirSync(ASSISTANTS_DIR).filter(f => {
    try {
      assertSafeAssistantId(f);
      const p = join(ASSISTANTS_DIR, f);
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

// ─── P0/P1/P2 Lifecycle Janitor ───────────────────────────────

const LIFECYCLE_RE = /\[P[12]\|expire:(\d{4}-\d{2}-\d{2})\]/;

/**
 * Scan MEMORY.md for expired P1/P2 items, move them to archive/.
 * Called on app startup and once per day.
 */
export function runMemoryJanitor(): { archived: number; cleaned: string[] } {
  ensureDirs();
  const lt = readLongTermMemory();
  if (!lt) return { archived: 0, cleaned: [] };

  const today = localDateStr();
  const lines = lt.split("\n");
  const kept: string[] = [];
  const expired: string[] = [];

  for (const line of lines) {
    const m = line.match(LIFECYCLE_RE);
    if (line.includes("[P0]")) {
      kept.push(line);
    } else if (m && m[1] < today) {
      expired.push(line);
    } else {
      kept.push(line);
    }
  }

  if (expired.length === 0) return { archived: 0, cleaned: [] };

  // Append expired items to archive/YYYY-MM.md
  const archiveFile = join(ARCHIVE_DIR, `${localMonthStr()}.md`);
  const existing = existsSync(archiveFile) ? readFileSync(archiveFile, "utf8") : "";
  atomicWrite(
    archiveFile,
    existing + `\n## Archived ${today}\n` + expired.join("\n") + "\n",
  );

  writeLongTermMemory(kept.join("\n"));
  try { refreshRootAbstract(); } catch { /* non-blocking */ }

  console.log(`[MemoryJanitor] Archived ${expired.length} expired item(s) from shared MEMORY.md.`);

  // Clean up per-assistant private MEMORY.md (P1/P2 lifecycle)
  let totalArchived = expired.length;
  try {
    for (const aid of listAssistantIds()) {
      const scoped = new ScopedMemory(aid);
      const result = scoped.runJanitor();
      totalArchived += result.archived;
      expired.push(...result.cleaned);
    }
  } catch { /* non-blocking */ }

  return { archived: totalArchived, cleaned: expired };
}

// ─── Context assembly ─────────────────────────────────────────

type MemoryProtocolOptions = {
  contactKey?: string;
  isOwner?: boolean;
};

function getMemoryProtocol(opts?: MemoryProtocolOptions): string {
  const isContactScoped = Boolean(opts?.contactKey && opts?.isOwner === false);
  if (isContactScoped) {
    return `
[记忆系统规则]
你拥有跨会话的持久记忆能力。<memory> 标签内包含当前联系人/群聊可见的索引和核心记忆。

━━ 记忆架构 ━━

你当前只能读写本联系人/群聊的专属记忆：
  - ~/.vk-cowork/memory/assistants/{你的ID}/contacts/{contactKey}/MEMORY.md
  - ~/.vk-cowork/memory/assistants/{你的ID}/contacts/{contactKey}/SESSION-STATE.md
  - ~/.vk-cowork/memory/assistants/{你的ID}/contacts/{contactKey}/daily/*.md

不要假设你能看到 owner 的共享记忆、共享日志或其他联系人/其他助理的记忆。

━━ 写入规则（重要）━━
默认使用 save_memory 工具写入当前联系人/群聊的专属记忆（scope: "private"）：
  [P0]                    当前联系人/群聊的长期偏好、业务上下文（永久）
  [P1|expire:YYYY-MM-DD]  项目决策、技术方案、环境配置（90天后过期）
  [P2|expire:YYYY-MM-DD]  临时信息（30天后过期）

判断标准：只对当前联系人/群聊有用 → 写这里。

━━ 按需加载规则 ━━
<memory> 中只包含索引和核心记忆。如需更多信息，根据索引摘要判断相关性，主动加载：
- 当前联系人/群聊日志 → assistants/{ID}/contacts/{contactKey}/daily/{日期}.md
- 知识文档 → ~/.vk-cowork/knowledge/docs/{id}.md
执行任务前先检查索引中的知识列表。不要猜测，先读取再行动。

━━ 知识库 & 经验沉淀 ━━
<memory> 中的"相关知识（语义检索）"是系统自动检索到的经验文档。
路径: ~/.vk-cowork/knowledge/（experience/ 候选，docs/ 已验证文档）
完成复杂任务后用 save_experience 沉淀操作经验（前置条件、关键步骤、踩坑点、验证方法）。
写入后可在知识库页面查看和审核。只记录经过验证的流程。

━━ Working Memory 规则 ━━
执行长任务时，用 save_working_memory 保存关键上下文到当前联系人/群聊的专属目录。

━━ 执行纪律 ━━
- 连续 5 次以上工具调用处理同一错误 → 切换策略或用 AskUserQuestion 求助
- 禁止对同一个失败操作无脑重试超过 3 次
- 复杂任务每完成一个关键阶段就保存进度

━━ 会话结束前的责任 ━━
完成最后一个任务后，调用 distill_memory 触发记忆蒸馏，或手动：
1. 用 save_memory 写入当前联系人/群聊的新发现（默认写专属）
2. 如有未完成任务，用 save_working_memory 更新工作记忆
3. 如果解决了复杂任务，用 save_experience 沉淀操作经验
`.trim();
  }

  return `
[记忆系统规则]
你拥有跨会话的持久记忆能力。<memory> 标签内包含目录索引和核心记忆。
你有两层长期记忆：团队共享记忆（所有助理可见）和你的专属记忆（只有你能看到）。

━━ 记忆架构 ━━

1. 团队共享层（所有助理可见）：
   - ~/.vk-cowork/memory/MEMORY.md         团队级信息（用户身份、全员决策）
   - ~/.vk-cowork/memory/daily/*.md         共享大事件摘要

2. 你的专属层（只有你能看到）：
   - ~/.vk-cowork/memory/assistants/{你的ID}/MEMORY.md          你的长期记忆
   - ~/.vk-cowork/memory/assistants/{你的ID}/SESSION-STATE.md   工作记忆
   - ~/.vk-cowork/memory/assistants/{你的ID}/daily/*.md         对话日志
   - ~/.vk-cowork/memory/assistants/{你的ID}/insights/*.md      月度提炼

━━ 写入规则（重要）━━
默认使用 save_memory 工具写入你的专属记忆（scope: "private"）：
  [P0]                    你与用户的交互偏好、业务上下文（永久）
  [P1|expire:YYYY-MM-DD]  项目决策、技术方案、环境配置（90天后过期）
  [P2|expire:YYYY-MM-DD]  临时信息（30天后过期）

仅以下信息写入团队共享记忆（scope: "shared"）：
  - 用户身份信息（姓名、职位、联系方式变更）
  - 团队级决策（影响所有助理的规则或约定）
  - 用户明确要求"所有助理都要知道"的内容

判断标准：只对你和用户在你的业务领域有用 → 写专属。其他助理也需要知道 → 写共享。

━━ 按需加载规则 ━━
<memory> 中只包含索引和核心记忆。如需更多信息，根据索引摘要判断相关性，主动加载：
- 共享日志 → ~/.vk-cowork/memory/daily/{日期}.md
- 你的日志 → assistants/{ID}/daily/{日期}.md
- 知识文档 → ~/.vk-cowork/knowledge/docs/{id}.md
执行任务前先检查索引中的知识列表。不要猜测，先读取再行动。

━━ 知识库 & 经验沉淀 ━━
<memory> 中的"相关知识（语义检索）"是系统自动检索到的经验文档。
路径: ~/.vk-cowork/knowledge/（experience/ 候选，docs/ 已验证文档）
完成复杂任务后用 save_experience 沉淀操作经验（前置条件、关键步骤、踩坑点、验证方法）。
写入后可在知识库页面查看和审核。只记录经过验证的流程。

━━ Working Memory 规则 ━━
执行长任务时，用 save_working_memory 保存关键上下文到你的专属目录。

━━ 执行纪律 ━━
- 连续 5 次以上工具调用处理同一错误 → 切换策略或用 AskUserQuestion 求助
- 禁止对同一个失败操作无脑重试超过 3 次
- 复杂任务每完成一个关键阶段就保存进度

━━ 会话结束前的责任 ━━
完成最后一个任务后，调用 distill_memory 触发记忆蒸馏，或手动：
1. 用 save_memory 写入新发现的偏好/决策（默认写专属，团队级写共享）
2. 如有未完成任务，用 save_working_memory 更新工作记忆
3. 如果解决了复杂任务，用 save_experience 沉淀操作经验
`.trim();
}

function limitContextText(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length <= maxChars) return trimmed;
  const clipped = trimmed.slice(0, Math.max(0, maxChars - 10)).trimEnd();
  return `${clipped}\n[...已截断]`;
}

function filterAbstractForContactScope(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const result: string[] = ["# memory index (~/.vk-cowork/memory)", "", "## 共享知识 (所有助理可见)"];
  let inSharedKnowledge = false;
  let keepSubsection = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (line.startsWith("## 共享知识")) {
        inSharedKnowledge = true;
        keepSubsection = false;
        continue;
      }
      if (inSharedKnowledge) break;
      continue;
    }

    if (!inSharedKnowledge) continue;

    if (line.startsWith("### ")) {
      keepSubsection = line.startsWith("### SOPs") || line.startsWith("### 知识文档");
      if (keepSubsection) {
        result.push("", line);
      }
      continue;
    }

    if (keepSubsection) {
      result.push(line);
    }
  }

  const filtered = result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return filtered === "# memory index (~/.vk-cowork/memory)\n\n## 共享知识 (所有助理可见)"
    ? ""
    : filtered;
}

function createMemoryContextSection(
  key: MemoryContextSectionKey,
  title: string,
  rawContent: string,
): MemoryContextSection {
  const limits = MEMORY_CONTEXT_SECTION_LIMITS[key];
  return {
    key,
    title,
    rawContent: rawContent.trim(),
    limit: limits.max,
    minLimit: limits.min,
  };
}

function renderMemoryContextResult(
  preamble: string[],
  sections: MemoryContextSection[],
  extraSections: string[],
  memoryProtocol: string,
): string {
  const parts: string[] = [...preamble, "<memory>"];
  for (const section of sections) {
    const limited = limitContextText(section.rawContent, section.limit);
    if (!limited) continue;
    parts.push(section.title, limited, "");
  }
  if (extraSections.length) {
    parts.push(...extraSections);
  }
  if (parts.length <= preamble.length + 1) {
    parts.push("（暂无历史记忆）");
  }
  parts.push("</memory>", "", memoryProtocol);
  return parts.join("\n");
}

function fitMemoryContext(
  preamble: string[],
  sections: MemoryContextSection[],
  extraSections: string[],
  memoryProtocol: string,
): string {
  const shrinkOrder: MemoryContextSectionKey[] = [
    "assistantDaily",
    "sharedDaily",
    "sessionState",
    "privateLongTerm",
    "longTerm",
  ];

  let rendered = renderMemoryContextResult(preamble, sections, extraSections, memoryProtocol);
  for (const key of shrinkOrder) {
    if (rendered.length <= MEMORY_CONTEXT_MAX_CHARS) break;
    const section = sections.find((item) => item.key === key);
    if (!section) continue;
    while (rendered.length > MEMORY_CONTEXT_MAX_CHARS && section.limit > section.minLimit) {
      const overflow = rendered.length - MEMORY_CONTEXT_MAX_CHARS;
      section.limit = Math.max(section.minLimit, section.limit - overflow);
      rendered = renderMemoryContextResult(preamble, sections, extraSections, memoryProtocol);
    }
  }

  if (rendered.length > MEMORY_CONTEXT_MAX_CHARS) {
    return `${rendered.slice(0, MEMORY_CONTEXT_MAX_CHARS - 10).trimEnd()}\n[...已截断]`;
  }
  return rendered;
}

// ─── Pre-flight knowledge retrieval ──────────────────────────

interface QmdHit { title: string; snippet: string }

const QMD_AVAILABILITY_TTL_MS = 30_000;
const QMD_QUERY_CACHE_TTL_MS = 5 * 60_000;
const MAX_CONCURRENT_QMD_QUERIES = 3;

let _qmdAvailability = { value: false, checkedAt: 0 };
let _qmdProbeInFlight = false;
const _qmdQueryCache = new Map<string, { hits: QmdHit[]; updatedAt: number }>();
const _qmdQueryInFlight = new Set<string>();
const _activeTimeouts = new Set<NodeJS.Timeout>();

function scheduleQmdAvailabilityProbe(): void {
  if (_qmdProbeInFlight) return;
  _qmdProbeInFlight = true;
  let child: ReturnType<typeof spawn> | null = null;

  try {
    child = spawn("qmd", ["--version"], { stdio: "ignore", shell: false });
  } catch (spawnError) {
    _qmdProbeInFlight = false;
    return;
  }

  const timer = setTimeout(() => {
    if (child) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }, 2000);

  _activeTimeouts.add(timer);

  const cleanup = () => {
    _qmdProbeInFlight = false;
    _activeTimeouts.delete(timer);
    clearTimeout(timer);
  };

  child.once("close", (code) => {
    cleanup();
    _qmdAvailability = { value: code === 0, checkedAt: Date.now() };
  });

  child.once("error", () => {
    cleanup();
    _qmdAvailability = { value: false, checkedAt: Date.now() };
  });
}

function isQmdAvailable(): boolean {
  const now = Date.now();
  if (now - _qmdAvailability.checkedAt > QMD_AVAILABILITY_TTL_MS) {
    // Keep callsite non-blocking; availability refresh happens in background.
    scheduleQmdAvailabilityProbe();
  }
  return _qmdAvailability.value;
}

function normalizeKnowledgeQuery(prompt: string): string {
  return prompt
    .replace(/[\r\n\t\f\v]/g, " ") // Remove control chars
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .slice(0, 200);
}

function cleanupQmdQueryCache(): void {
  const now = Date.now();
  for (const [query, entry] of _qmdQueryCache.entries()) {
    if (now - entry.updatedAt > QMD_QUERY_CACHE_TTL_MS) {
      _qmdQueryCache.delete(query);
    }
  }
}

function scheduleQmdKnowledgeQuery(query: string, topK: number): void {
  if (!query || _qmdQueryInFlight.has(query) || !isQmdAvailable()) return;

  // Concurrency control: limit simultaneous queries
  if (_qmdQueryInFlight.size >= MAX_CONCURRENT_QMD_QUERIES) {
    return; // Silently drop if too many concurrent requests
  }

  _qmdQueryInFlight.add(query);
  let stdout = "";
  let child: ReturnType<typeof spawn> | null = null;

  try {
    child = spawn(
      "qmd",
      ["query", query, "--json", "-n", String(topK), "--collection", "vk-knowledge"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        // Prevent zombie processes
        detached: false,
      },
    );
  } catch (spawnError) {
    _qmdQueryInFlight.delete(query);
    return;
  }

  const timer = setTimeout(() => {
    if (child) {
      try {
        child.kill("SIGTERM"); // Try graceful shutdown first
        setTimeout(() => {
          try { child?.kill("SIGKILL"); } catch { /* ignore */ }
        }, 1000);
      } catch { /* ignore */ }
    }
  }, 8000);

  _activeTimeouts.add(timer);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });

  const cleanup = () => {
    _qmdQueryInFlight.delete(query);
    _activeTimeouts.delete(timer);
    clearTimeout(timer);
  };

  child.once("close", (code, signal) => {
    cleanup();
    // Accept both successful exit (0) and termination by signal
    if (code !== 0 && code !== null) return;

    try {
      const items = JSON.parse(stdout);
      if (!Array.isArray(items)) return;
      const hits: QmdHit[] = items
        .filter((it: any) => it && (it.title || it.content))
        .map((it: any) => ({
          title: String(it.title || it.path || "untitled").slice(0, 80),
          snippet: String(it.content || "").slice(0, 300),
        }));
      _qmdQueryCache.set(query, { hits, updatedAt: Date.now() });
      // Periodic cache cleanup
      if (_qmdQueryCache.size > 50) {
        cleanupQmdQueryCache();
      }
    } catch {
      // Ignore parse errors from qmd and keep memory assembly robust.
    }
  });

  child.once("error", (error) => {
    cleanup();
    // Log but don't crash - qmd errors should not break memory context building
    console.warn(`[QMD Query] Failed for "${query.slice(0, 50)}...":`, error.message);
  });
}

/**
 * Query the local knowledge base via qmd CLI.
 * Returns top-k results with title and snippet.
 * Gracefully returns [] if qmd is not installed or fails.
 */
async function queryKnowledgeViaQmd(prompt: string, topK = 3): Promise<QmdHit[]> {
  const query = normalizeKnowledgeQuery(prompt);
  if (!query) return [];

  const cached = _qmdQueryCache.get(query);
  if (cached && Date.now() - cached.updatedAt < QMD_QUERY_CACHE_TTL_MS) {
    return cached.hits.slice(0, topK);
  }

  // Clean cache periodically to prevent unbounded growth
  if (_qmdQueryCache.size > 100) {
    cleanupQmdQueryCache();
  }

  // If qmd is not available, return empty immediately
  if (!isQmdAvailable()) return [];

  // Try to execute query synchronously if not already in flight
  if (!_qmdQueryInFlight.has(query)) {
    return new Promise((resolve) => {
      _qmdQueryInFlight.add(query);
      let stdout = "";
      let child: ReturnType<typeof spawn> | null = null;

      try {
        child = spawn(
          "qmd",
          ["query", query, "--json", "-n", String(topK), "--collection", "vk-knowledge"],
          {
            stdio: ["ignore", "pipe", "ignore"],
            shell: false,
            detached: false,
          },
        );
      } catch (spawnError) {
        _qmdQueryInFlight.delete(query);
        resolve([]);
        return;
      }

      const timer = setTimeout(() => {
        if (child) {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }
      }, 5000); // Shorter timeout for synchronous wait

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });

      child.once("close", (code, signal) => {
        clearTimeout(timer);
        _qmdQueryInFlight.delete(query);

        if (code !== 0 && code !== null) {
          resolve([]);
          return;
        }

        try {
          const items = JSON.parse(stdout);
          if (!Array.isArray(items)) {
            resolve([]);
            return;
          }
          const hits: QmdHit[] = items
            .filter((it: any) => it && (it.title || it.content))
            .map((it: any) => ({
              title: String(it.title || it.path || "untitled").slice(0, 80),
              snippet: String(it.content || "").slice(0, 300),
            }));
          _qmdQueryCache.set(query, { hits, updatedAt: Date.now() });
          resolve(hits.slice(0, topK));
        } catch {
          resolve([]);
        }
      });

      child.once("error", () => {
        clearTimeout(timer);
        _qmdQueryInFlight.delete(query);
        resolve([]);
      });
    });
  }

  // If already in flight, wait a short time for cache to populate, then return empty
  return new Promise((resolve) => {
    setTimeout(() => {
      const cached = _qmdQueryCache.get(query);
      resolve(cached ? cached.hits.slice(0, topK) : []);
    }, 100);
  });
}

/**
 * Build a slim memory context for the given prompt.
 *
 * Strategy (GenericAgent-inspired): inject only the directory index and
 * core memory. The Agent decides what else to file_read based on the index.
 *
 * Injected:
 *   1. User profile / global prompt (personalization)
 *   2. .abstract (rich directory index with summaries)
 *   3. MEMORY.md (long-term core preferences/decisions — always relevant)
 *   4. SESSION-STATE.md (cross-session working memory)
 *   5. Today's daily note (immediate context)
 *   6. Pre-flight knowledge hits from qmd (semantic search, if available)
 *
 * NOT injected (Agent loads on-demand via file_read):
 *   - Yesterday's / historical daily logs
 *   - Full SOP content (names+descriptions are in .abstract)
 *   - Insight files
 */
// ─── Memory Context TTL Cache ────────────────────────────────
// Per-assistant cache to avoid repeated file reads for parallel/heartbeat sessions.
// Keyed by `${assistantId}:${sessionCwd}:${skipDailyLog}:${prompt.slice(0, 120)}`, TTL 30s.
const _memoryContextCache = new Map<string, { result: string; ts: number }>();
const MEMORY_CONTEXT_TTL_MS = 30_000;

export async function buildSmartMemoryContext(
  prompt: string,
  assistantId?: string,
  sessionCwd?: string,
  opts?: { skipDailyLog?: boolean; contactKey?: string; isOwner?: boolean },
): Promise<string> {
  ensureDirs();

  const contactKey = opts?.contactKey?.trim() || undefined;
  const isContactScoped = Boolean(assistantId && contactKey && opts?.isOwner === false);

  const cacheKey = [
    assistantId ?? "",
    isContactScoped ? contactKey : "",
    opts?.isOwner === false ? "non-owner" : "owner",
    sessionCwd ?? "",
    opts?.skipDailyLog ? "skip-daily" : "with-daily",
    prompt.slice(0, 120),
  ].join(":");
  const cached = _memoryContextCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MEMORY_CONTEXT_TTL_MS) {
    return cached.result;
  }

  const scoped = assistantId
    ? new ScopedMemory(assistantId, isContactScoped ? contactKey : undefined)
    : null;

  // Runtime guard: warn if multiple assistants configured but no ID provided
  if (!assistantId) {
    try {
      const configPath = join(homedir(), ".vk-cowork", "assistants-config.json");
      const raw = await readFileOrEmpty(configPath);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.assistants?.length > 1) {
          console.warn("[Memory] WARNING: assistantId missing with multiple assistants. Falling back to global memory.");
        }
      }
    } catch { /* ignore */ }
  }

  // Note: .abstract refresh is skipped in async context to avoid blocking; it happens on writes

  const todayDate = localDateStr();

  // Parallel async reads — avoids sequential blocking I/O
  const [abstract, longTerm, privateLongTerm, sharedToday, sessionState, assistantToday, settings] = await Promise.all([
    readFileOrEmpty(join(MEMORY_ROOT, ".abstract")),
    isContactScoped ? Promise.resolve("") : readFileOrEmpty(LONG_TERM_FILE),
    scoped ? scoped.readLongTermMemoryAsync() : Promise.resolve(""),
    isContactScoped ? Promise.resolve("") : readFileOrEmpty(dailyPath(todayDate)),
    scoped ? scoped.readSessionStateAsync() : readFileOrEmpty(SESSION_STATE_FILE),
    scoped ? scoped.readDailyAsync(todayDate) : Promise.resolve(""),
    loadUserSettingsAsync(),
  ]);

  const preamble: string[] = [];
  const profileLines: string[] = [];
  if (!isContactScoped && settings.userName?.trim()) profileLines.push(`- 姓名: ${settings.userName.trim()}`);
  if (!isContactScoped && settings.workDescription?.trim()) {
    profileLines.push(`- 工作描述: ${limitContextText(settings.workDescription.trim(), 600)}`);
  }
  if (profileLines.length) {
    preamble.push("[用户档案]", ...profileLines, "");
  }
  if (!isContactScoped && settings.globalPrompt?.trim()) {
    preamble.push("[全局指令]", limitContextText(settings.globalPrompt.trim(), 4_000), "");
  }

  if (sessionCwd?.trim()) {
    preamble.push("[工作环境]", `- 当前工作目录: ${sessionCwd.trim()}`, "");
  }

  const sections: MemoryContextSection[] = [];
  const abstractTrimmed = (isContactScoped ? filterAbstractForContactScope(abstract) : abstract).trim();
  if (abstractTrimmed) {
    sections.push(createMemoryContextSection("abstract", "## 记忆目录索引", abstractTrimmed));
  }
  const memoryIsolation = settings.memoryIsolationV3 !== false; // default: on
  const longTermTrimmed = longTerm.trim();
  if (longTermTrimmed) {
    sections.push(
      createMemoryContextSection(
        "longTerm",
        memoryIsolation ? "## 团队共享记忆 (MEMORY.md)" : "## 共享长期记忆 (MEMORY.md)",
        longTermTrimmed,
      ),
    );
  }
  if (memoryIsolation || isContactScoped) {
    const privateLongTermTrimmed = privateLongTerm.trim();
    if (privateLongTermTrimmed) {
      sections.push(createMemoryContextSection(
        "privateLongTerm",
        isContactScoped ? "## 当前联系人/群聊记忆 (MEMORY.md)" : "## 你的专属记忆 (private MEMORY.md)",
        privateLongTermTrimmed,
      ));
    }
  }
  const sessionStateTrimmed = sessionState.trim();
  if (sessionStateTrimmed) {
    sections.push(createMemoryContextSection("sessionState", "## 工作记忆 (SESSION-STATE.md)", sessionStateTrimmed));
  }
  // Skip daily logs for file-analysis messages — the logs contain previous file analyses
  // that pollute Claude's output with content from a different file.
  if (!opts?.skipDailyLog) {
    if (!isContactScoped) {
      const sharedTodayTrimmed = sharedToday.trim();
      if (sharedTodayTrimmed) {
        sections.push(createMemoryContextSection("sharedDaily", `## 今日共享日志 (${todayDate})`, sharedTodayTrimmed));
      }
    }
    const assistantTodayTrimmed = assistantToday.trim();
    if (assistantTodayTrimmed) {
      sections.push(createMemoryContextSection(
        "assistantDaily",
        isContactScoped ? `## 当前联系人/群聊日志 (${todayDate})` : `## 今日对话日志 (${todayDate})`,
        assistantTodayTrimmed,
      ));
    }
  }

  // Pre-flight knowledge retrieval via qmd (semantic search)
  const extraSections: string[] = [];
  try {
    const qmdHits = await queryKnowledgeViaQmd(prompt, 3);
    if (qmdHits.length) {
      extraSections.push("## 相关知识（语义检索）");
      for (const hit of qmdHits) {
        extraSections.push(`### ${limitContextText(hit.title, 120)}`);
        extraSections.push(limitContextText(hit.snippet, 500));
        extraSections.push("");
      }
    }
  } catch { /* qmd unavailable, skip silently */ }

  const memoryProtocol = getMemoryProtocol({
    contactKey: isContactScoped ? contactKey : undefined,
    isOwner: opts?.isOwner,
  });
  const result = fitMemoryContext(preamble, sections, extraSections, memoryProtocol);
  _memoryContextCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

/** Legacy alias — kept for backward compat */
export async function buildMemoryContext(assistantId?: string, sessionCwd?: string): Promise<string> {
  return buildSmartMemoryContext("", assistantId, sessionCwd);
}

/**
 * Parse today's assistant daily log and return the last `n` conversation blocks
 * (each block starts with `## HH:MM:SS`). Returns a formatted string ready to
 * be injected as a system-prompt section, or an empty string when unavailable.
 */
export function getRecentConversationBlocks(assistantId: string, n = 4, contactKey?: string): string {
  try {
    const scoped = new ScopedMemory(assistantId, contactKey);
    const raw = scoped.readDaily(localDateStr()).trim();
    if (!raw) return "";

    // Split on lines that start a new time-stamped block
    const blocks = raw.split(/\n(?=## \d{2}:\d{2}(:\d{2})?)/).filter((b) => b.trim());
    const recent = blocks.slice(-n);
    if (!recent.length) return "";

    // Truncate long assistant replies (e.g. full file analyses) to avoid polluting
    // subsequent messages with details from a previous file.
    const MAX_REPLY_CHARS = 300;
    const FILE_PATH_LINE = /^文件路径:\s*\/\S+/m;
    const truncated = recent.map((block) =>
      block.replace(
        /(\*\*[^*]+\*\*:\s)([\s\S]+)$/m,
        (_, prefix, body) => {
          // If this assistant reply mentions a file path or is very long, shorten it
          if (FILE_PATH_LINE.test(body) || body.length > MAX_REPLY_CHARS) {
            return `${prefix}${body.slice(0, MAX_REPLY_CHARS).trimEnd()}…（内容已截断）`;
          }
          return `${prefix}${body}`;
        },
      )
    );

    return [
      "## 近期对话记录（来自今日日志）",
      "⚠️ 以下是之前的对话，仅供了解背景。如有提及文件内容，均属过去任务，请勿参考历史文件内容。",
      truncated.join("\n").trim(),
    ].join("\n");
  } catch {
    return "";
  }
}
