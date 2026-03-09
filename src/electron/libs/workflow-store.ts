import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join, dirname } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkflowStatus = "idle" | "running" | "completed" | "failed";
export type StageStatus = "pending" | "in_progress" | "completed" | "failed";

export interface WorkflowStageRun {
  stageId: string;
  label: string;
  status: StageStatus;
  inputPrompt?: string;
  output?: string;
  abstract?: string;
  error?: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
}

export interface WorkflowRun {
  id: string;
  sopId: string;
  status: WorkflowStatus;
  startedAt?: string;
  completedAt?: string;
  stages: WorkflowStageRun[];
  triggerType?: "manual" | "scheduled";
  scheduledTaskId?: string;  // the ScheduledTask.id that triggered this run
  planItemId?: string;       // auto-created plan table entry for this run
}

export interface StageExperience {
  stageId: string;
  stageLabel: string;
  runId: string;
  extractedAt: string;
  title: string;
  scenario: string;
  steps: string;
  result: string;
  risk: string;
}

// ── File paths ───────────────────────────────────────────────────────────────

const WORKFLOWS_DIR = join(app.getPath("userData"), "workflows");
const MAX_HISTORY_RUNS = 5;
const MAX_EXPERIENCE_PER_STAGE = 3;

function workflowFile(sopId: string): string {
  return join(WORKFLOWS_DIR, sopId, "latest.json");
}

function historyDir(sopId: string): string {
  return join(WORKFLOWS_DIR, sopId, "history");
}

function experienceFile(sopId: string): string {
  return join(WORKFLOWS_DIR, sopId, "experiences.json");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Broadcast ────────────────────────────────────────────────────────────────

function broadcastWorkflowChanged(sopId: string) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("workflow-run-changed", sopId);
      }
    }
  } catch { /* ignore */ }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function loadWorkflowRun(sopId: string): WorkflowRun | null {
  try {
    const fp = workflowFile(sopId);
    if (!existsSync(fp)) return null;
    return JSON.parse(readFileSync(fp, "utf8")) as WorkflowRun;
  } catch {
    return null;
  }
}

export function saveWorkflowRun(run: WorkflowRun): void {
  const fp = workflowFile(run.sopId);
  ensureDir(fp);
  writeFileSync(fp, JSON.stringify(run, null, 2), "utf8");
  broadcastWorkflowChanged(run.sopId);
}

export function createWorkflowRun(
  sopId: string,
  stages: Array<{ id: string; label: string }>,
  opts?: { triggerType?: "manual" | "scheduled"; scheduledTaskId?: string },
): WorkflowRun {
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    sopId,
    status: "running",
    startedAt: new Date().toISOString(),
    stages: stages.map((s) => ({
      stageId: s.id,
      label: s.label,
      status: "pending" as const,
    })),
    triggerType: opts?.triggerType,
    scheduledTaskId: opts?.scheduledTaskId,
  };
  saveWorkflowRun(run);
  return run;
}

export function updateWorkflowStage(
  sopId: string,
  stageId: string,
  updates: Partial<Omit<WorkflowStageRun, "stageId" | "label">>,
): WorkflowRun | null {
  const run = loadWorkflowRun(sopId);
  if (!run) return null;

  const stage = run.stages.find((s) => s.stageId === stageId);
  if (!stage) return null;

  Object.assign(stage, updates);

  if (updates.status === "completed" || updates.status === "failed") {
    stage.completedAt = stage.completedAt ?? new Date().toISOString();
    if (stage.startedAt) {
      stage.duration = new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime();
    }
  }

  const allCompleted = run.stages.every((s) => s.status === "completed");
  const anyFailed = run.stages.some((s) => s.status === "failed");
  const anyRunning = run.stages.some((s) => s.status === "in_progress");

  if (allCompleted) {
    run.status = "completed";
    run.completedAt = new Date().toISOString();
  } else if (anyFailed && !anyRunning) {
    run.status = "failed";
  } else {
    run.status = "running";
  }

  saveWorkflowRun(run);

  // Archive to history when workflow reaches a terminal state
  if (run.status === "completed" || run.status === "failed") {
    archiveWorkflowRun(run);
  }

  return run;
}

/**
 * Find the next pending stage after a given stage, or the first pending stage.
 */
export function getNextPendingStage(run: WorkflowRun, afterStageId?: string): WorkflowStageRun | null {
  if (afterStageId) {
    const idx = run.stages.findIndex((s) => s.stageId === afterStageId);
    if (idx === -1) return null;
    for (let i = idx + 1; i < run.stages.length; i++) {
      if (run.stages[i].status === "pending") return run.stages[i];
    }
    return null;
  }
  return run.stages.find((s) => s.status === "pending") ?? null;
}

// ── History ──────────────────────────────────────────────────────────────────

function archiveWorkflowRun(run: WorkflowRun): void {
  try {
    const hDir = historyDir(run.sopId);
    if (!existsSync(hDir)) mkdirSync(hDir, { recursive: true });

    const ts = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
    writeFileSync(
      join(hDir, `${ts}-${run.id}.json`),
      JSON.stringify(run, null, 2),
      "utf8",
    );

    const files = readdirSync(hDir).filter((f) => f.endsWith(".json")).sort();
    while (files.length > MAX_HISTORY_RUNS) {
      const oldest = files.shift()!;
      try { unlinkSync(join(hDir, oldest)); } catch { /* best-effort */ }
    }
  } catch (err) {
    console.error("[workflow-store] Failed to archive run:", err);
  }
}

export function loadWorkflowHistory(sopId: string): WorkflowRun[] {
  try {
    const hDir = historyDir(sopId);
    if (!existsSync(hDir)) return [];
    const files = readdirSync(hDir).filter((f) => f.endsWith(".json")).sort();
    return files.map((f) => {
      try {
        return JSON.parse(readFileSync(join(hDir, f), "utf8")) as WorkflowRun;
      } catch { return null; }
    }).filter(Boolean) as WorkflowRun[];
  } catch {
    return [];
  }
}

// ── Stage Experiences ────────────────────────────────────────────────────────

export function loadWorkflowExperiences(sopId: string): StageExperience[] {
  try {
    const fp = experienceFile(sopId);
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, "utf8")) as StageExperience[];
  } catch {
    return [];
  }
}

export function saveStageExperience(sopId: string, exp: StageExperience): void {
  const all = loadWorkflowExperiences(sopId);

  const forStage = all.filter((e) => e.stageId === exp.stageId);
  while (forStage.length >= MAX_EXPERIENCE_PER_STAGE) {
    const oldest = forStage.shift()!;
    const idx = all.indexOf(oldest);
    if (idx >= 0) all.splice(idx, 1);
  }

  all.push(exp);
  const fp = experienceFile(sopId);
  ensureDir(fp);
  writeFileSync(fp, JSON.stringify(all, null, 2), "utf8");
}

export function listAllWorkflowSopIds(): string[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR).filter((entry) => {
    const fp = join(WORKFLOWS_DIR, entry, "latest.json");
    return existsSync(fp);
  });
}

// Delete all workflow data (runs, history, experiences) for a SOP
export function deleteWorkflowData(sopId: string): void {
  const dir = join(WORKFLOWS_DIR, sopId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[WorkflowStore] Deleted workflow data for SOP: ${sopId}`);
  }
}
