import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PlanItem {
  id: string;
  sopName: string;
  assistantId: string;
  content: string;
  scheduledTime: string;       // ISO
  completedAt: string | null;
  status: PlanItemStatus;
  result: string;              // AI execution summary
  sessionId: string | null;    // linked session for drill-down
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

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function loadPlanItems(): PlanItem[] {
  try {
    if (!existsSync(PLAN_FILE)) return [];
    const raw = readFileSync(PLAN_FILE, "utf8");
    const state = JSON.parse(raw) as PlanStoreState;
    return state.items ?? [];
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

/**
 * Upsert: match by id, or by (sopName + assistantId) combo.
 * Returns the created or updated item.
 */
export function upsertPlanItem(
  input: {
    id?: string;
    sopName: string;
    assistantId: string;
    content: string;
    scheduledTime?: string;
    status?: PlanItemStatus;
    result?: string;
    sessionId?: string | null;
  },
): PlanItem {
  const items = loadPlanItems();
  const now = new Date().toISOString();

  // Try to find existing item
  let idx = -1;
  if (input.id) {
    idx = items.findIndex((i) => i.id === input.id);
  }
  if (idx === -1) {
    idx = items.findIndex(
      (i) => i.sopName === input.sopName && i.assistantId === input.assistantId,
    );
  }

  if (idx !== -1) {
    // Update existing
    const existing = items[idx];
    items[idx] = {
      ...existing,
      content: input.content,
      ...(input.scheduledTime != null && { scheduledTime: input.scheduledTime }),
      ...(input.status != null && { status: input.status }),
      ...(input.result != null && { result: input.result }),
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      ...(input.status === "completed" && { completedAt: now }),
      updatedAt: now,
    };
    savePlanItems(items);
    return items[idx];
  }

  // Create new
  const item: PlanItem = {
    id: crypto.randomUUID(),
    sopName: input.sopName,
    assistantId: input.assistantId,
    content: input.content,
    scheduledTime: input.scheduledTime ?? now,
    status: input.status ?? "pending",
    result: input.result ?? "",
    sessionId: input.sessionId ?? null,
    completedAt: input.status === "completed" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  items.push(item);
  savePlanItems(items);
  return item;
}
