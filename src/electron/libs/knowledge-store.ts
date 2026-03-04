import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

export type KnowledgeReviewStatus = "draft" | "verified" | "archived";

export interface KnowledgeCandidate {
  id: string;
  title: string;
  scenario: string;
  steps: string;
  result: string;
  risk: string;
  sourceSessionId: string;
  assistantId?: string;
  createdAt: string;
  updatedAt: string;
  reviewStatus: KnowledgeReviewStatus;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Paths ───────────────────────────────────────────────────────────

const KB_ROOT = join(homedir(), ".vk-cowork", "knowledge");
const EXPERIENCE_DIR = join(KB_ROOT, "experience");
const DOCS_DIR = join(KB_ROOT, "docs");

function ensureDirs() {
  for (const d of [KB_ROOT, EXPERIENCE_DIR, DOCS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// ─── Markdown frontmatter helpers ────────────────────────────────────

function toFrontmatter(meta: Record<string, string>): string {
  const lines = Object.entries(meta).map(([k, v]) => `${k}: "${v.replace(/"/g, '\\"')}"`);
  return `---\n${lines.join("\n")}\n---`;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
    meta[key] = val;
  }
  return { meta, body: match[2] };
}

function makeId(): string {
  return `kc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Experience candidates (经验库) ──────────────────────────────────

function candidateToMarkdown(c: KnowledgeCandidate): string {
  const fm = toFrontmatter({
    id: c.id,
    title: c.title,
    scenario: c.scenario,
    reviewStatus: c.reviewStatus,
    sourceSessionId: c.sourceSessionId,
    assistantId: c.assistantId ?? "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
  return `${fm}\n\n## 步骤\n\n${c.steps}\n\n## 结果\n\n${c.result}\n\n## 风险\n\n${c.risk}\n`;
}

function markdownToCandidate(raw: string, filename: string): KnowledgeCandidate {
  const { meta, body } = parseFrontmatter(raw);
  const sections: Record<string, string> = {};
  let currentKey = "";
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      currentKey = heading[1].trim();
      sections[currentKey] = "";
    } else if (currentKey) {
      sections[currentKey] += line + "\n";
    }
  }
  return {
    id: meta.id || basename(filename, ".md"),
    title: meta.title || "未命名",
    scenario: meta.scenario || "",
    steps: (sections["步骤"] ?? "").trim(),
    result: (sections["结果"] ?? "").trim(),
    risk: (sections["风险"] ?? "").trim(),
    sourceSessionId: meta.sourceSessionId || "",
    assistantId: meta.assistantId || undefined,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    reviewStatus: (meta.reviewStatus as KnowledgeReviewStatus) || "draft",
  };
}

export function listKnowledgeCandidates(): KnowledgeCandidate[] {
  ensureDirs();
  const files = readdirSync(EXPERIENCE_DIR).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => {
      try {
        return markdownToCandidate(readFileSync(join(EXPERIENCE_DIR, f), "utf8"), f);
      } catch {
        return null;
      }
    })
    .filter((c): c is KnowledgeCandidate => c !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getKnowledgeCandidateById(id: string): KnowledgeCandidate | null {
  ensureDirs();
  const file = join(EXPERIENCE_DIR, `${id}.md`);
  if (!existsSync(file)) return null;
  return markdownToCandidate(readFileSync(file, "utf8"), `${id}.md`);
}

export function findKnowledgeCandidateBySession(sessionId: string): KnowledgeCandidate | null {
  return listKnowledgeCandidates().find((c) => c.sourceSessionId === sessionId) ?? null;
}

export function createKnowledgeCandidate(input: {
  title: string;
  scenario: string;
  steps: string;
  result: string;
  risk: string;
  sourceSessionId: string;
  assistantId?: string;
}): KnowledgeCandidate {
  ensureDirs();
  const now = new Date().toISOString();
  const candidate: KnowledgeCandidate = {
    id: makeId(),
    ...input,
    createdAt: now,
    updatedAt: now,
    reviewStatus: "draft",
  };
  writeFileSync(join(EXPERIENCE_DIR, `${candidate.id}.md`), candidateToMarkdown(candidate), "utf8");
  return candidate;
}

export function updateKnowledgeCandidate(
  id: string,
  updates: Partial<Pick<KnowledgeCandidate, "title" | "scenario" | "steps" | "result" | "risk">>,
): KnowledgeCandidate | null {
  const candidate = getKnowledgeCandidateById(id);
  if (!candidate) return null;
  Object.assign(candidate, updates);
  candidate.updatedAt = new Date().toISOString();
  writeFileSync(join(EXPERIENCE_DIR, `${candidate.id}.md`), candidateToMarkdown(candidate), "utf8");
  return candidate;
}

export function updateKnowledgeCandidateReviewStatus(id: string, status: KnowledgeReviewStatus): KnowledgeCandidate | null {
  const candidate = getKnowledgeCandidateById(id);
  if (!candidate) return null;
  candidate.reviewStatus = status;
  candidate.updatedAt = new Date().toISOString();
  writeFileSync(join(EXPERIENCE_DIR, `${candidate.id}.md`), candidateToMarkdown(candidate), "utf8");

  if (status === "verified") {
    const docTitle = candidate.title.replace(/ · 经验候选$/, "");
    const sections = [
      candidate.scenario && `## 场景\n\n${candidate.scenario}`,
      candidate.steps && `## 步骤\n\n${candidate.steps}`,
      candidate.result && `## 结果\n\n${candidate.result}`,
      candidate.risk && candidate.risk !== "待人工审核" && `## 风险\n\n${candidate.risk}`,
    ].filter(Boolean).join("\n\n");
    createKnowledgeDoc(docTitle, sections);
  }

  return candidate;
}

export function deleteKnowledgeCandidate(id: string): boolean {
  const file = join(EXPERIENCE_DIR, `${id}.md`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

// ─── Knowledge docs (知识库) ─────────────────────────────────────────

export function listKnowledgeDocs(): KnowledgeDoc[] {
  ensureDirs();
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => {
      try {
        const raw = readFileSync(join(DOCS_DIR, f), "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const stat = statSync(join(DOCS_DIR, f));
        return {
          id: basename(f, ".md"),
          title: meta.title || basename(f, ".md"),
          content: body.trim(),
          createdAt: meta.createdAt || stat.birthtime.toISOString(),
          updatedAt: meta.updatedAt || stat.mtime.toISOString(),
        };
      } catch {
        return null;
      }
    })
    .filter((d): d is KnowledgeDoc => d !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getKnowledgeDoc(id: string): KnowledgeDoc | null {
  const file = join(DOCS_DIR, `${id}.md`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const stat = statSync(file);
  return {
    id,
    title: meta.title || id,
    content: body.trim(),
    createdAt: meta.createdAt || stat.birthtime.toISOString(),
    updatedAt: meta.updatedAt || stat.mtime.toISOString(),
  };
}

export function createKnowledgeDoc(title: string, content: string): KnowledgeDoc {
  ensureDirs();
  const now = new Date().toISOString();
  const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const fm = toFrontmatter({ title, createdAt: now, updatedAt: now });
  writeFileSync(join(DOCS_DIR, `${id}.md`), `${fm}\n\n${content}\n`, "utf8");
  return { id, title, content, createdAt: now, updatedAt: now };
}

export function updateKnowledgeDoc(id: string, title: string, content: string): KnowledgeDoc | null {
  const file = join(DOCS_DIR, `${id}.md`);
  if (!existsSync(file)) return null;
  const old = getKnowledgeDoc(id);
  const now = new Date().toISOString();
  const fm = toFrontmatter({ title, createdAt: old?.createdAt ?? now, updatedAt: now });
  writeFileSync(file, `${fm}\n\n${content}\n`, "utf8");
  return { id, title, content, createdAt: old?.createdAt ?? now, updatedAt: now };
}

export function deleteKnowledgeDoc(id: string): boolean {
  const file = join(DOCS_DIR, `${id}.md`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function getKnowledgeBasePath(): string {
  ensureDirs();
  return KB_ROOT;
}
