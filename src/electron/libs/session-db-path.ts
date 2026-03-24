import Database from "better-sqlite3";
import { app } from "electron";
import { existsSync, mkdirSync, statSync } from "fs";
import { dirname, join } from "path";

const SESSION_DB_NAME = "sessions.db";
const LEGACY_APP_NAMES = ["AI Team"];
const MIGRATION_META_TABLE = "session_db_migrations";

let cachedDbPath: string | null = null;
let migrationAttempted = false;

type FileSnapshot = {
  size: number;
  mtimeMs: number;
};

function ensureSessionTables(db: Database.Database): void {
  db.exec(
    `create table if not exists sessions (
      id text primary key,
      title text,
      claude_session_id text,
      resume_ready integer default 0,
      status text not null,
      cwd text,
      allowed_tools text,
      last_prompt text,
      provider text default 'claude',
      model text,
      assistant_id text,
      assistant_skill_names text,
      created_at integer not null,
      updated_at integer not null
    )`
  );
  try { db.exec(`alter table sessions add column provider text default 'claude'`); } catch {}
  try { db.exec(`alter table sessions add column model text`); } catch {}
  try { db.exec(`alter table sessions add column assistant_id text`); } catch {}
  try { db.exec(`alter table sessions add column assistant_skill_names text`); } catch {}
  try { db.exec(`alter table sessions add column background integer default 0`); } catch {}
  try { db.exec(`alter table sessions add column hidden integer default 0`); } catch {}
  try { db.exec(`alter table sessions add column resume_ready integer default 0`); } catch {}

  db.exec(
    `create table if not exists messages (
      id text primary key,
      session_id text not null,
      data text not null,
      created_at integer not null,
      foreign key (session_id) references sessions(id)
    )`
  );
  db.exec(`create index if not exists messages_session_id on messages(session_id)`);
}

function ensureUsageTables(db: Database.Database): void {
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

function ensureMigrationMetaTable(db: Database.Database): void {
  db.exec(
    `create table if not exists ${MIGRATION_META_TABLE} (
      source_path text primary key,
      source_size integer not null,
      source_mtime_ms integer not null,
      migrated_at integer not null
    )`
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function getTableColumns(db: Database.Database, schema: string, table: string): string[] {
  const rows = db
    .prepare(`pragma ${schema}.table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function hasTable(db: Database.Database, schema: string, table: string): boolean {
  const row = db
    .prepare(`select 1 as ok from ${schema}.sqlite_master where type = 'table' and name = ? limit 1`)
    .get(table) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function getFileSnapshot(path: string): FileSnapshot {
  const stat = statSync(path);
  return {
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  };
}

function wasAlreadyMigrated(db: Database.Database, sourcePath: string, snapshot: FileSnapshot): boolean {
  const row = db
    .prepare(
      `select 1 as ok
       from ${MIGRATION_META_TABLE}
       where source_path = ?
         and source_size = ?
         and source_mtime_ms = ?
       limit 1`
    )
    .get(sourcePath, snapshot.size, snapshot.mtimeMs) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function markMigrated(db: Database.Database, sourcePath: string, snapshot: FileSnapshot): void {
  db.prepare(
    `insert into ${MIGRATION_META_TABLE} (source_path, source_size, source_mtime_ms, migrated_at)
     values (?, ?, ?, ?)
     on conflict(source_path) do update set
       source_size = excluded.source_size,
       source_mtime_ms = excluded.source_mtime_ms,
       migrated_at = excluded.migrated_at`
  ).run(sourcePath, snapshot.size, snapshot.mtimeMs, Date.now());
}

function mergeTable(db: Database.Database, legacySchema: string, table: string): void {
  if (!hasTable(db, legacySchema, table)) return;

  const currentColumns = getTableColumns(db, "main", table);
  const legacyColumns = new Set(getTableColumns(db, legacySchema, table));
  const commonColumns = currentColumns.filter((column) => legacyColumns.has(column));
  if (commonColumns.length === 0) return;

  const quotedColumns = commonColumns.map(quoteIdentifier).join(", ");
  db.exec(
    `insert or ignore into ${quoteIdentifier(table)} (${quotedColumns})
     select ${quotedColumns}
     from ${legacySchema}.${quoteIdentifier(table)}`
  );
}

function migrateLegacyDb(currentDbPath: string, legacyDbPath: string): void {
  const snapshot = getFileSnapshot(legacyDbPath);
  const db = new Database(currentDbPath);
  const legacySchema = "legacy_migration";

  try {
    db.exec(`pragma journal_mode = WAL;`);
    ensureSessionTables(db);
    ensureUsageTables(db);
    ensureMigrationMetaTable(db);

    if (wasAlreadyMigrated(db, legacyDbPath, snapshot)) return;

    db.prepare(`attach database ? as ${legacySchema}`).run(legacyDbPath);
    try {
      const migrate = db.transaction(() => {
        mergeTable(db, legacySchema, "sessions");
        mergeTable(db, legacySchema, "messages");
        mergeTable(db, legacySchema, "usage_requests");
        markMigrated(db, legacyDbPath, snapshot);
      });
      migrate();
    } finally {
      db.exec(`detach database ${legacySchema}`);
    }

    db.exec(`pragma wal_checkpoint(TRUNCATE);`);
  } finally {
    db.close();
  }
}

export function resolveSessionDbPath(): string {
  if (cachedDbPath) return cachedDbPath;

  const currentDbPath = join(app.getPath("userData"), SESSION_DB_NAME);
  mkdirSync(dirname(currentDbPath), { recursive: true });

  if (!migrationAttempted) {
    migrationAttempted = true;
    for (const legacyAppName of LEGACY_APP_NAMES) {
      const legacyDbPath = join(app.getPath("appData"), legacyAppName, SESSION_DB_NAME);
      if (!existsSync(legacyDbPath) || legacyDbPath === currentDbPath) continue;
      try {
        migrateLegacyDb(currentDbPath, legacyDbPath);
      } catch (error) {
        console.warn(`[session-db] Failed to migrate legacy database from ${legacyDbPath}:`, error);
      }
    }
  }

  cachedDbPath = currentDbPath;
  return currentDbPath;
}
