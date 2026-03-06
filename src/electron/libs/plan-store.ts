import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkCategory = "客户服务" | "情报监控" | "内部运营" | "增长销售" | "";
export type PlanItemStatus = "pending" | "in_progress" | "human_review" | "completed" | "failed";

export interface PlanItem {
  id: string;
  sopName: string;
  category: WorkCategory;
  targetId: string;            // dedup key, e.g. "student-001"
  targetName: string;          // display name, e.g. "张三"
  assistantId: string;
  content: string;
  scheduledTime: string;       // ISO
  completedAt: string | null;
  status: PlanItemStatus;
  result: string;              // AI execution summary
  sessionId: string | null;    // linked session for drill-down
  scheduledTaskId?: string;    // set when item was created by a scheduled SOP/stage task
  createdAt: string;           // ISO
  updatedAt: string;           // ISO
}

interface PlanStoreState {
  items: PlanItem[];
}

// ── File path ────────────────────────────────────────────────────────────────

const PLAN_FILE = join(app.getPath("userData"), "plan-items.json");

function ensureDirectory() {
  const dir = dirname(PLAN_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Broadcast helper ─────────────────────────────────────────────────────────

function broadcastPlanChanged() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("plan-items-changed");
    }
  } catch { /* ignore if no windows */ }
}

// ── Backward-compat migration ────────────────────────────────────────────────

function migrateItem(raw: Record<string, unknown>): PlanItem {
  return {
    id: String(raw.id ?? crypto.randomUUID()),
    sopName: String(raw.sopName ?? ""),
    category: (["客户服务", "情报监控", "内部运营", "增长销售", ""].includes(String(raw.category ?? ""))
      ? String(raw.category ?? "") as WorkCategory
      : ""),
    targetId: String(raw.targetId ?? ""),
    targetName: String(raw.targetName ?? ""),
    assistantId: String(raw.assistantId ?? ""),
    content: String(raw.content ?? ""),
    scheduledTime: String(raw.scheduledTime ?? new Date().toISOString()),
    completedAt: raw.completedAt ? String(raw.completedAt) : null,
    status: (["pending", "in_progress", "human_review", "completed", "failed"].includes(raw.status as string)
      ? raw.status as PlanItemStatus
      : "pending"),
    result: String(raw.result ?? ""),
    sessionId: raw.sessionId ? String(raw.sessionId) : null,
    scheduledTaskId: raw.scheduledTaskId ? String(raw.scheduledTaskId) : undefined,
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function loadPlanItems(): PlanItem[] {
  try {
    if (!existsSync(PLAN_FILE)) return [];
    const raw = readFileSync(PLAN_FILE, "utf8");
    const state = JSON.parse(raw) as PlanStoreState;
    return (state.items ?? []).map((i) => migrateItem(i as unknown as Record<string, unknown>));
  } catch (error) {
    console.error("[PlanStore] Failed to load:", error);
    return [];
  }
}

function savePlanItems(items: PlanItem[]): void {
  ensureDirectory();
  const state: PlanStoreState = { items };
  writeFileSync(PLAN_FILE, JSON.stringify(state, null, 2), "utf8");
  broadcastPlanChanged();
}

export function addPlanItem(
  input: Omit<PlanItem, "id" | "createdAt" | "updatedAt" | "completedAt"> & { completedAt?: string | null },
): PlanItem {
  const items = loadPlanItems();
  const now = new Date().toISOString();
  const item: PlanItem = {
    ...input,
    id: crypto.randomUUID(),
    completedAt: input.completedAt ?? null,
    createdAt: now,
    updatedAt: now,
  };
  items.push(item);
  savePlanItems(items);
  return item;
}

export function updatePlanItem(id: string, updates: Partial<Omit<PlanItem, "id" | "createdAt">>): PlanItem | null {
  const items = loadPlanItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;

  items[idx] = {
    ...items[idx],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  savePlanItems(items);
  return items[idx];
}

export function deletePlanItem(id: string): boolean {
  const items = loadPlanItems();
  const filtered = items.filter((i) => i.id !== id);
  if (filtered.length === items.length) return false;
  savePlanItems(filtered);
  return true;
}

// Delete all plan items for a given SOP (matched by sopName)
export function deletePlanItemsBySopName(sopName: string): number {
  const items = loadPlanItems();
  const filtered = items.filter((i) => i.sopName !== sopName);
  const removed = items.length - filtered.length;
  if (removed > 0) {
    savePlanItems(filtered);
    console.log(`[PlanStore] Removed ${removed} plan item(s) for SOP: "${sopName}"`);
  }
  return removed;
}

// Update sopName for all plan items belonging to an old SOP name
export function renamePlanItemsSopName(oldName: string, newName: string): number {
  const items = loadPlanItems();
  let count = 0;
  const updated = items.map((i) => {
    if (i.sopName !== oldName) return i;
    count++;
    return { ...i, sopName: newName, updatedAt: new Date().toISOString() };
  });
  if (count > 0) {
    savePlanItems(updated);
    console.log(`[PlanStore] Renamed sopName "${oldName}" → "${newName}" on ${count} item(s)`);
  }
  return count;
}

/**
 * Upsert: match by id, or by (sopName + assistantId + targetId) combo.
 * Returns the created or updated item.
 */
export function upsertPlanItem(
  input: {
    id?: string;
    sopName: string;
    category?: WorkCategory;
    targetId?: string;
    targetName?: string;
    assistantId: string;
    content: string;
    scheduledTime?: string;
    status?: PlanItemStatus;
    result?: string;
    sessionId?: string | null;
    scheduledTaskId?: string;
  },
): PlanItem {
  const items = loadPlanItems();
  const now = new Date().toISOString();
  const tid = input.targetId ?? "";

  let idx = -1;
  if (input.id) {
    idx = items.findIndex((i) => i.id === input.id);
  }
  if (idx === -1) {
    idx = items.findIndex(
      (i) => i.sopName === input.sopName
        && i.assistantId === input.assistantId
        && i.targetId === tid,
    );
  }

  if (idx !== -1) {
    const existing = items[idx];
    items[idx] = {
      ...existing,
      content: input.content,
      ...(input.category != null && { category: input.category }),
      ...(input.targetName != null && { targetName: input.targetName }),
      ...(input.scheduledTime != null && { scheduledTime: input.scheduledTime }),
      ...(input.status != null && { status: input.status }),
      ...(input.result != null && { result: input.result }),
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      ...(input.status === "completed" && { completedAt: now }),
      ...(input.scheduledTaskId != null && { scheduledTaskId: input.scheduledTaskId }),
      updatedAt: now,
    };
    savePlanItems(items);
    return items[idx];
  }

  const item: PlanItem = {
    id: crypto.randomUUID(),
    sopName: input.sopName,
    category: input.category ?? "",
    targetId: tid,
    targetName: input.targetName ?? tid,
    assistantId: input.assistantId,
    content: input.content,
    scheduledTime: input.scheduledTime ?? now,
    status: input.status ?? "pending",
    result: input.result ?? "",
    sessionId: input.sessionId ?? null,
    scheduledTaskId: input.scheduledTaskId,
    completedAt: input.status === "completed" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  items.push(item);
  savePlanItems(items);
  return item;
}
