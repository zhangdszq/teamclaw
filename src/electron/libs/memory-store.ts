/**
 * Memory Store — OpenClaw Memory 2.0 + SOP Self-Evolution
 *
 * L0/L1/L2 retrieval layers + P0/P1/P2 lifecycle + .abstract index
 * + SOP auto-growth (inspired by GenericAgent)
 * + Working Memory Checkpoints
 *
 * ~/.vk-cowork/memory/
 * ├── .abstract              L0 root index (auto-generated manifest)
 * ├── MEMORY.md              long-term memory (P0/P1/P2 lifecycle tags)
 * ├── SESSION-STATE.md       working buffer (cross-session context handoff)
 * ├── daily/                 L2 raw logs (append-only, one file per day)
 * ├── insights/              L1 monthly distillation
 * ├── lessons/               L1 structured lessons
 * ├── sops/                  self-growing SOPs (Standard Operating Procedures)
 * └── archive/               expired P1/P2 items
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, unlinkSync, statSync,
  copyFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadUserSettings } from "./user-settings.js";

// Write lock to prevent concurrent writes
const writeLocks = new Map<string, Promise<void>>();

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

// ─── Per-assistant path helpers ──────────────────────────────

function getAssistantMemoryRoot(assistantId: string): string {
  return join(ASSISTANTS_DIR, assistantId);
}

function ensureAssistantDirs(assistantId: string): void {
  const root = getAssistantMemoryRoot(assistantId);
  for (const sub of ["daily", "insights", "lessons", "archive"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
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

## MEMORY.md 写入规则
- P0: 用户明确表达的偏好、核心工作原则
- P1: 项目架构决策、技术方案选型、环境配置（90天后过期）
- P2: 临时测试地址、一次性配置、短期任务信息（30天后过期）
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

// ─── Long-term memory (MEMORY.md) ────────────────────────────

export function readLongTermMemory(): string {
  ensureDirs();
  if (!existsSync(LONG_TERM_FILE)) return "";
  return readFileSync(LONG_TERM_FILE, "utf8");
}

export function writeLongTermMemory(content: string): void {
  ensureDirs();
  atomicWrite(LONG_TERM_FILE, content);
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
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  atomicWrite(p, existing ? existing + "\n" + content : content);
  // Refresh root abstract after each write (non-blocking)
  try { refreshRootAbstract(); } catch { /* ignore */ }
}

export function writeDailyMemory(content: string, date: string): void {
  ensureDirs();
  atomicWrite(dailyPath(date), content);
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
    lines.push("### SOPs (可复用操作流程) — 路径: sops/{名称}.md");
    sops.forEach(s => lines.push(`- ${s.name}: ${s.description || "(no description)"}  [${s.updatedAt}]`));
    lines.push("");
  }

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
  lines.push("### 长期记忆 (MEMORY.md)");
  if (topicLines.length) {
    topicLines.forEach(l => lines.push(l));
  } else {
    lines.push("- (empty)");
  }
  lines.push("");

  // Per-assistant section
  if (scoped) {
    lines.push(`## 你的记忆 (${assistantId})`, "");

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
    const aInsightsDir = join(scoped["root"], "insights");
    if (existsSync(aInsightsDir)) {
      const insightFiles = readdirSync(aInsightsDir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5);
      if (insightFiles.length) {
        lines.push(`### insights — 路径: assistants/${assistantId}/insights/{月份}.md`);
        insightFiles.forEach(f => lines.push(`- ${f}`));
        lines.push("");
      }
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

export function getMemorySummary(): { longTermSize: number; dailyCount: number; totalSize: number } {
  const lt = readLongTermMemory();
  const dailies = listDailyMemories();
  const dailyTotalSize = dailies.reduce((sum, d) => sum + d.size, 0);
  const ltSize = Buffer.byteLength(lt, "utf8");
  return { longTermSize: ltSize, dailyCount: dailies.length, totalSize: ltSize + dailyTotalSize };
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
  writeSessionState(lines.join("\n"));
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
  private readonly root: string;

  constructor(assistantId: string) {
    this.assistantId = assistantId;
    this.root = getAssistantMemoryRoot(assistantId);
    ensureAssistantDirs(assistantId);
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

  writeSessionState(content: string): void {
    atomicWrite(this._sessionStatePath(), content);
  }

  clearSessionState(): void {
    const p = this._sessionStatePath();
    if (existsSync(p)) atomicWrite(p, "");
  }

  readDaily(date: string): string {
    const p = this._dailyPath(date);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8");
  }

  appendDaily(content: string, date?: string): void {
    const p = this._dailyPath(date ?? localDateStr());
    const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
    atomicWrite(p, existing ? existing + "\n" + content : content);
  }

  writeDaily(content: string, date: string): void {
    atomicWrite(this._dailyPath(date), content);
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
    this.writeSessionState(lines.join("\n"));
  }

  getMemorySummary(): { longTermSize: number; dailyCount: number; totalSize: number } {
    const lt = readLongTermMemory();
    const dailies = this.listDailies();
    const dailyTotalSize = dailies.reduce((sum, d) => sum + d.size, 0);
    const ltSize = Buffer.byteLength(lt, "utf8");
    return { longTermSize: ltSize, dailyCount: dailies.length, totalSize: ltSize + dailyTotalSize };
  }

  /**
   * Run janitor for this assistant's archive directory.
   * (Shared MEMORY.md janitor is run separately via runMemoryJanitor.)
   */
  runJanitor(): { archived: number; cleaned: string[] } {
    return { archived: 0, cleaned: [] };
  }
}

// ─── Dual-write conversation logger ─────────────────────────

/**
 * Record a conversation to both shared daily (summary) and assistant-private daily (full).
 * Callers only need to invoke this once — dual-write is automatic.
 */
export function recordConversation(
  content: string,
  opts: { assistantId?: string; assistantName?: string; channel?: string },
): void {
  const { assistantId, assistantName, channel } = opts;

  // 1. Full content → assistant's private daily
  if (assistantId) {
    const scoped = new ScopedMemory(assistantId);
    scoped.appendDaily(content);
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
    const p = join(ASSISTANTS_DIR, f);
    return statSync(p).isDirectory();
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
    if (m && m[1] < today) {
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

  // Also clean up per-assistant archive directories (future-proofing)
  try {
    for (const aid of listAssistantIds()) {
      // Currently assistants don't have their own MEMORY.md with P1/P2,
      // but this loop ensures we handle it if added later.
      const aArchiveDir = join(getAssistantMemoryRoot(aid), "archive");
      if (!existsSync(aArchiveDir)) mkdirSync(aArchiveDir, { recursive: true });
    }
  } catch { /* non-blocking */ }

  return { archived: expired.length, cleaned: expired };
}

// ─── Context assembly ─────────────────────────────────────────

const MEMORY_PROTOCOL = `
[记忆系统规则]
你拥有跨会话的持久记忆能力。上面 <memory> 标签内包含目录索引和核心记忆。
记忆系统分为三层：共享用户层、共享知识层、你的独立经历层。

━━ 三层记忆架构 ━━

1. 共享用户层（所有助理共用）：
   - ~/.vk-cowork/memory/MEMORY.md         关于用户的长期记忆 (P0/P1)
   - 写入规则：[P0] 用户偏好/核心原则（永久），[P1|expire:YYYY-MM-DD] 项目决策/技术方案（90天）

2. 共享知识层（所有助理共用）：
   - ~/.vk-cowork/memory/sops/*.md          可复用操作流程（自主生长）
   - ~/.vk-cowork/memory/daily/*.md         共享大事件摘要（标记来源助理）

3. 你的独立记忆（只属于你）：
   - ~/.vk-cowork/memory/assistants/{你的ID}/SESSION-STATE.md   工作记忆
   - ~/.vk-cowork/memory/assistants/{你的ID}/daily/*.md         详细对话日志
   - ~/.vk-cowork/memory/assistants/{你的ID}/insights/*.md      月度提炼

━━ 按需加载规则（重要）━━
<memory> 中只包含目录索引、MEMORY.md、工作记忆和今日笔记。
如需更多历史信息，根据目录索引中的摘要判断相关性，主动用文件读取工具加载：
- 看到相关 SOP 名称 → 读取 ~/.vk-cowork/memory/sops/{名称}.md
- 看到共享日志相关日期 → 读取 ~/.vk-cowork/memory/daily/{日期}.md
- 看到你的对话日志日期 → 读取对应的 assistants/{ID}/daily/{日期}.md
- 看到 insights 条目 → 读取对应路径
不要猜测记忆内容，先读取再行动。按需加载比盲目搜索更高效。

━━ 写入规则 ━━
写入共享 MEMORY.md（关于用户的信息）：
  [P0]                    用户偏好、核心原则（永久，所有助理可见）
  [P1|expire:YYYY-MM-DD]  活跃项目决策和技术方案（90 天后过期，所有助理可见）
  [P2|expire:YYYY-MM-DD]  临时信息如测试地址、配置（30 天后过期）

你的详细对话和操作过程会自动记录到你的独立日志中，无需手动写入。

━━ SOP 自进化规则（重要）━━
SOP 是所有助理共享的知识库。当你完成一个复杂任务时，用 save_sop 工具沉淀为 SOP：
- SOP 应记录：前置条件、关键步骤、踩坑点、验证方法
- 只记录经过实践验证的流程，不要记录未验证的猜测
- SOP 名称用简短的任务描述（如 "部署-nextjs-到-vercel"、"配置-github-actions"）
- 如果已有相关 SOP，优先更新而非新建
- 执行新任务前先检查目录索引中的 SOP 列表，避免重复劳动

━━ Working Memory 规则 ━━
执行长任务时，用 save_working_memory 工具保存关键上下文（保存到你的独立目录）：
- 当前任务目标和进展
- 关键中间结果和决策
- 相关 SOP 名称（方便下次快速回忆）
这些信息会在下次会话中自动加载，确保跨会话连续性。

━━ 共享日志中的助理标签 ━━
共享日志中每条记录带有 [渠道/助理名] 标签，例如 [钉钉/小助理]。
如果你需要了解"某个话题之前跟哪个助理讨论过"，查看共享日志中的标签即可定位。

━━ 执行纪律 ━━
- 如果连续 5 次以上工具调用都在处理同一个错误，必须停下来切换策略：
  1. 重新审视问题本质，检查是否遗漏了前置条件
  2. 搜索相关 SOP 看是否有已知解法
  3. 如果仍无进展，用 AskUserQuestion 请求用户协助
- 禁止对同一个失败操作无脑重试超过 3 次
- 执行复杂任务时，每完成一个关键阶段就用 save_working_memory 保存进度

━━ 会话结束前的责任（重要）━━
每次完成用户最后一个任务后，调用 distill_memory 工具触发结构化记忆蒸馏，
或手动完成以下操作，不要等用户提醒：
1. 把新的用户偏好/决策写入 MEMORY.md，按 [P0]/[P1]/[P2] 标注
2. 如有未完成任务或下次需继续的上下文，用 save_working_memory 更新工作记忆
3. 如果解决了复杂任务，用 save_sop 将流程沉淀为可复用 SOP

过期的 P1/P2 条目会被后台 janitor 自动归档，无需手动处理。
`.trim();

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
 *
 * NOT injected (Agent loads on-demand via file_read):
 *   - Yesterday's / historical daily logs
 *   - Full SOP content (names+descriptions are in .abstract)
 *   - Insight files
 */
export function buildSmartMemoryContext(
  prompt: string,
  assistantId?: string,
  sessionCwd?: string,
  opts?: { skipDailyLog?: boolean },
): string {
  ensureDirs();

  const scoped = assistantId ? new ScopedMemory(assistantId) : null;

  // Runtime guard: warn if multiple assistants configured but no ID provided
  if (!assistantId) {
    try {
      const configPath = join(homedir(), ".vk-cowork", "assistants-config.json");
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.assistants?.length > 1) {
          console.warn("[Memory] WARNING: assistantId missing with multiple assistants. Falling back to global memory.");
        }
      }
    } catch { /* ignore */ }
  }

  // Ensure .abstract is up-to-date (includes assistant section if ID provided)
  try { refreshRootAbstract(assistantId); } catch { /* non-blocking */ }

  const todayDate = localDateStr();

  // Shared layer
  const abstract = readAbstract(MEMORY_ROOT).trim();
  const longTerm = readLongTermMemory().trim();
  const sharedToday = readDailyMemory(todayDate).trim();

  // Per-assistant layer (or fallback to global)
  const sessionState = scoped ? scoped.readSessionState().trim() : readSessionState().trim();
  const assistantToday = scoped ? scoped.readDaily(todayDate).trim() : "";

  // Inject personalization from user settings
  const preamble: string[] = [];
  try {
    const settings = loadUserSettings();
    const profileLines: string[] = [];
    if (settings.userName?.trim()) profileLines.push(`- 姓名: ${settings.userName.trim()}`);
    if (settings.workDescription?.trim()) profileLines.push(`- 工作描述: ${settings.workDescription.trim()}`);
    if (profileLines.length) {
      preamble.push("[用户档案]", ...profileLines, "");
    }
    if (settings.globalPrompt?.trim()) {
      preamble.push("[全局指令]", settings.globalPrompt.trim(), "");
    }
  } catch { /* ignore — settings unavailable */ }

  if (sessionCwd?.trim()) {
    preamble.push("[工作环境]", `- 当前工作目录: ${sessionCwd.trim()}`, "");
  }

  const parts: string[] = [...preamble, "<memory>"];

  if (abstract) {
    parts.push("## 记忆目录索引");
    parts.push(abstract);
    parts.push("");
  }
  if (longTerm) {
    parts.push("## 共享长期记忆 (MEMORY.md)");
    parts.push(longTerm);
    parts.push("");
  }
  if (sessionState) {
    parts.push("## 工作记忆 (SESSION-STATE.md)");
    parts.push(sessionState);
    parts.push("");
  }
  // Skip daily logs for file-analysis messages — the logs contain previous file analyses
  // that pollute Claude's output with content from a different file.
  if (!opts?.skipDailyLog) {
    if (sharedToday) {
      parts.push(`## 今日共享日志 (${todayDate})`);
      parts.push(sharedToday);
      parts.push("");
    }
    if (assistantToday) {
      parts.push(`## 今日对话日志 (${todayDate})`);
      parts.push(assistantToday);
      parts.push("");
    }
  }

  if (parts.length <= preamble.length + 1) {
    parts.push("（暂无历史记忆）");
  }

  parts.push("</memory>");
  parts.push("");
  parts.push(MEMORY_PROTOCOL);

  return parts.join("\n");
}

/** Legacy alias — kept for backward compat */
export function buildMemoryContext(): string {
  return buildSmartMemoryContext("");
}

/**
 * Parse today's assistant daily log and return the last `n` conversation blocks
 * (each block starts with `## HH:MM:SS`). Returns a formatted string ready to
 * be injected as a system-prompt section, or an empty string when unavailable.
 */
export function getRecentConversationBlocks(assistantId: string, n = 4): string {
  try {
    const scoped = new ScopedMemory(assistantId);
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
