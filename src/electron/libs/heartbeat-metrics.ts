import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const METRICS_PATH = join(homedir(), ".vk-cowork", "logs", "heartbeat-metrics.jsonl");

export type HeartbeatMetricEvent =
  | "triggered"
  | "skipped"
  | "completed"
  | "notification_sent"
  | "notification_skipped";

export function recordHeartbeatMetric(
  event: HeartbeatMetricEvent,
  payload: Record<string, unknown>,
): void {
  try {
    const dir = dirname(METRICS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const row = JSON.stringify({
      ts: Date.now(),
      event,
      ...payload,
    });
    appendFileSync(METRICS_PATH, `${row}\n`, "utf8");
  } catch {
    // Metrics are best-effort. Never block runtime logic.
  }
}

