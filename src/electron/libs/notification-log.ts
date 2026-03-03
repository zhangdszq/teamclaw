import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const LOG_PATH = join(homedir(), ".vk-cowork", "memory", "notified.json");
const RETENTION_MS = 24 * 3600_000;

export interface NotifiedEntry {
  key: string;       // sha1(text) first 8 chars
  summary: string;   // first 120 chars of text for AI context
  ts: number;
  assistantId: string;
}

function loadEntries(): NotifiedEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  try {
    const raw = readFileSync(LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEntries(entries: NotifiedEntry[]): void {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), "utf8");
}

export function appendNotified(entry: Omit<NotifiedEntry, "key">): void {
  const key = createHash("sha1").update(entry.summary).digest("hex").slice(0, 8);
  const cutoff = Date.now() - RETENTION_MS;
  // Load, prune old entries, append new one
  const entries = loadEntries().filter((e) => e.ts > cutoff);
  entries.push({ key, ...entry });
  saveEntries(entries);
}

export function readRecentNotified(
  assistantId: string,
  withinMs = RETENTION_MS,
): NotifiedEntry[] {
  const cutoff = Date.now() - withinMs;
  return loadEntries().filter(
    (e) => e.assistantId === assistantId && e.ts > cutoff,
  );
}
