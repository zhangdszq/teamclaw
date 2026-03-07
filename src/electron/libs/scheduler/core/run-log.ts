import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "./types.js";

// Default limits
export const DEFAULT_RUN_LOG_MAX_BYTES = 2_000_000; // 2 MB
export const DEFAULT_RUN_LOG_KEEP_LINES = 2000;

function logFilePath(logDir: string, taskId: string): string {
  return path.join(logDir, `${taskId}.jsonl`);
}

/**
 * Append a run record to the task's JSONL log file.
 * Creates the log directory if it does not exist.
 * Automatically prunes the log file after writing if it exceeds limits.
 */
export async function appendRunLog(
  logDir: string,
  record: RunRecord,
  opts?: { maxBytes?: number; keepLines?: number },
): Promise<void> {
  await fs.promises.mkdir(logDir, { recursive: true });
  const filePath = logFilePath(logDir, record.taskId);
  const line = JSON.stringify(record) + "\n";
  await fs.promises.appendFile(filePath, line, "utf-8");
  await pruneRunLogIfNeeded(filePath, {
    maxBytes: opts?.maxBytes ?? DEFAULT_RUN_LOG_MAX_BYTES,
    keepLines: opts?.keepLines ?? DEFAULT_RUN_LOG_KEEP_LINES,
  });
}

/**
 * Read the N most recent run records for a task.
 * Returns an empty array if the log file does not exist.
 */
export async function readRunLog(logDir: string, taskId: string, limit = 50): Promise<RunRecord[]> {
  const filePath = logFilePath(logDir, taskId);
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const records: RunRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as RunRecord);
      } catch {
        // skip malformed lines
      }
    }
    return records.slice(-limit);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Prune a JSONL log file if it exceeds maxBytes.
 * Keeps the newest keepLines lines.
 */
export async function pruneRunLogIfNeeded(
  filePath: string,
  opts: { maxBytes: number; keepLines: number },
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return;
  }
  if (stat.size <= opts.maxBytes) return;

  const raw = await fs.promises.readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const kept = lines.slice(-opts.keepLines);
  await fs.promises.writeFile(filePath, kept.join("\n") + "\n", "utf-8");
}

/**
 * Delete the run log file for a task (called when task is deleted).
 */
export async function deleteRunLog(logDir: string, taskId: string): Promise<void> {
  const filePath = logFilePath(logDir, taskId);
  await fs.promises.unlink(filePath).catch(() => {});
}
