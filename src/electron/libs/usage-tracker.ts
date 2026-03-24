import Database from "better-sqlite3";
import { resolveSessionDbPath } from "./session-db-path.js";

export type UsageProvider = "anthropic" | "openai";
export type UsageStatus = "ok" | "error";
export type UsageRange = "24h" | "7d" | "30d" | "all";

export type UsageFilter = {
  range?: UsageRange;
  provider?: UsageProvider;
  model?: string;
  status?: UsageStatus;
  limit?: number;
  offset?: number;
};

export type UsageRecord = {
  id: string;
  timestamp: string;
  provider: UsageProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  status: UsageStatus;
  error?: string;
};

export type UsageRecordInput = {
  timestamp?: number | Date | string;
  provider: UsageProvider;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  latencyMs?: number;
  status?: UsageStatus;
  error?: string;
};

export type UsageSummary = {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type ProviderStat = {
  provider: UsageProvider;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

let db: Database.Database | null = null;
let initializedPath: string | null = null;

function resolveDefaultDbPath(): string {
  return resolveSessionDbPath();
}

function normalizeTimestamp(input?: number | Date | string): number {
  if (typeof input === "number" && Number.isFinite(input)) return Math.floor(input);
  if (input instanceof Date) return input.getTime();
  if (typeof input === "string" && input.trim()) {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function coerceNonNegativeInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function getRangeStartMs(range: UsageRange = "24h"): number | null {
  const now = Date.now();
  if (range === "all") return null;
  if (range === "24h") return now - 24 * 60 * 60 * 1000;
  if (range === "7d") return now - 7 * 24 * 60 * 60 * 1000;
  return now - 30 * 24 * 60 * 60 * 1000;
}

function ensureDb(dbPath?: string): Database.Database {
  const resolved = dbPath ?? initializedPath ?? resolveDefaultDbPath();
  if (!db || initializedPath !== resolved) {
    db?.close();
    db = new Database(resolved);
    initializedPath = resolved;
    db.exec(`pragma journal_mode = WAL;`);
    db.exec(
      `create table if not exists usage_requests (
        id text primary key,
        timestamp integer not null,
        provider text not null,
        model text not null,
        input_tokens integer default 0,
        output_tokens integer default 0,
        cache_read_tokens integer default 0,
        cache_creation_tokens integer default 0,
        latency_ms integer default 0,
        status text default 'ok',
        error text
      )`
    );
    db.exec(`create index if not exists idx_usage_timestamp on usage_requests(timestamp)`);
    db.exec(`create index if not exists idx_usage_provider on usage_requests(provider)`);
    db.exec(`create index if not exists idx_usage_status on usage_requests(status)`);
  }
  return db;
}

function buildWhereClause(filter: UsageFilter): { clause: string; params: Array<string | number> } {
  const conds: string[] = [];
  const params: Array<string | number> = [];

  const rangeStart = getRangeStartMs(filter.range ?? "24h");
  if (rangeStart !== null) {
    conds.push("timestamp >= ?");
    params.push(rangeStart);
  }
  if (filter.provider) {
    conds.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.status) {
    conds.push("status = ?");
    params.push(filter.status);
  }
  if (filter.model?.trim()) {
    conds.push("model = ?");
    params.push(filter.model.trim());
  }

  return { clause: conds.length ? `where ${conds.join(" and ")}` : "", params };
}

function mapRowToUsageRecord(row: Record<string, unknown>): UsageRecord {
  const ts = coerceNonNegativeInt(row.timestamp);
  return {
    id: String(row.id),
    timestamp: new Date(ts).toISOString(),
    provider: row.provider === "openai"
      ? row.provider
      : "anthropic",
    model: String(row.model ?? ""),
    inputTokens: coerceNonNegativeInt(row.input_tokens),
    outputTokens: coerceNonNegativeInt(row.output_tokens),
    cacheReadTokens: coerceNonNegativeInt(row.cache_read_tokens),
    cacheCreationTokens: coerceNonNegativeInt(row.cache_creation_tokens),
    latencyMs: coerceNonNegativeInt(row.latency_ms),
    status: row.status === "error" ? "error" : "ok",
    error: row.error ? String(row.error) : undefined,
  };
}

export function initUsageTracker(dbPath?: string): void {
  ensureDb(dbPath);
}

export function recordUsage(record: UsageRecordInput): void {
  const database = ensureDb();
  const id = crypto.randomUUID();
  const timestamp = normalizeTimestamp(record.timestamp);
  database
    .prepare(
      `insert into usage_requests
        (id, timestamp, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, latency_ms, status, error)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      timestamp,
      record.provider,
      record.model || "unknown",
      coerceNonNegativeInt(record.inputTokens),
      coerceNonNegativeInt(record.outputTokens),
      coerceNonNegativeInt(record.cacheReadTokens),
      coerceNonNegativeInt(record.cacheCreationTokens),
      coerceNonNegativeInt(record.latencyMs),
      record.status === "error" ? "error" : "ok",
      record.error ?? null
    );

  // Keep at most 5000 rows — delete oldest excess records
  database.prepare(
    `delete from usage_requests where id in (
       select id from usage_requests order by timestamp desc limit -1 offset 5000
     )`
  ).run();
}

export function getUsageLogs(filter: UsageFilter = {}): UsageRecord[] {
  const database = ensureDb();
  const { clause, params } = buildWhereClause(filter);
  const safeLimit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const safeOffset = Math.max(filter.offset ?? 0, 0);
  const rows = database
    .prepare(
      `select id, timestamp, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, latency_ms, status, error
       from usage_requests
       ${clause}
       order by timestamp desc
       limit ?
       offset ?`
    )
    .all(...params, safeLimit, safeOffset) as Array<Record<string, unknown>>;
  return rows.map(mapRowToUsageRecord);
}

export function getUsageSummary(filter: UsageFilter = {}): UsageSummary {
  const database = ensureDb();
  const { clause, params } = buildWhereClause(filter);
  const row = database
    .prepare(
      `select
         count(*) as total_requests,
         coalesce(sum(input_tokens), 0) as input_tokens,
         coalesce(sum(output_tokens), 0) as output_tokens,
         coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
         coalesce(sum(cache_creation_tokens), 0) as cache_creation_tokens
       from usage_requests
       ${clause}`
    )
    .get(...params) as Record<string, unknown> | undefined;

  const inputTokens = coerceNonNegativeInt(row?.input_tokens);
  const outputTokens = coerceNonNegativeInt(row?.output_tokens);
  return {
    totalRequests: coerceNonNegativeInt(row?.total_requests),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: coerceNonNegativeInt(row?.cache_read_tokens),
    cacheCreationTokens: coerceNonNegativeInt(row?.cache_creation_tokens),
  };
}

export function getProviderStats(filter: UsageFilter = {}): ProviderStat[] {
  const database = ensureDb();
  const { clause, params } = buildWhereClause(filter);
  const rows = database
    .prepare(
      `select
         provider,
         count(*) as requests,
         coalesce(sum(input_tokens), 0) as input_tokens,
         coalesce(sum(output_tokens), 0) as output_tokens,
         coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
         coalesce(sum(cache_creation_tokens), 0) as cache_creation_tokens
       from usage_requests
       ${clause}
       group by provider
       order by requests desc`
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const inputTokens = coerceNonNegativeInt(row.input_tokens);
    const outputTokens = coerceNonNegativeInt(row.output_tokens);
    return {
      provider: row.provider === "openai"
        ? row.provider
        : "anthropic",
      requests: coerceNonNegativeInt(row.requests),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens: coerceNonNegativeInt(row.cache_read_tokens),
      cacheCreationTokens: coerceNonNegativeInt(row.cache_creation_tokens),
    };
  });
}

export function clearUsageLogs(): boolean {
  const database = ensureDb();
  database.prepare("delete from usage_requests").run();
  return true;
}
