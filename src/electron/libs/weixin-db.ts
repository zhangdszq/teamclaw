import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { resolveSessionDbPath } from "./session-db-path.js";

export type WeixinAccountRow = {
  account_id: string;
  user_id: string;
  base_url: string;
  cdn_base_url: string;
  token: string;
  name: string;
  enabled: number;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
};

let db: Database.Database | null = null;

function ensureWeixinTables(targetDb: Database.Database): void {
  targetDb.exec(
    `create table if not exists weixin_accounts (
      account_id text primary key,
      user_id text default '',
      base_url text not null,
      cdn_base_url text not null,
      token text not null,
      name text not null,
      enabled integer not null default 1,
      last_login_at integer,
      created_at integer not null,
      updated_at integer not null
    )`,
  );
  targetDb.exec(
    `create table if not exists weixin_context_tokens (
      account_id text not null,
      peer_user_id text not null,
      context_token text not null,
      updated_at integer not null,
      primary key (account_id, peer_user_id)
    )`,
  );
  targetDb.exec(
    `create table if not exists weixin_offsets (
      account_id text primary key,
      cursor text not null,
      updated_at integer not null
    )`,
  );
  targetDb.exec("create index if not exists idx_weixin_accounts_enabled on weixin_accounts(enabled)");
  targetDb.exec("create index if not exists idx_weixin_ctx_updated_at on weixin_context_tokens(updated_at)");
}

function getDb(): Database.Database {
  if (db) return db;
  const dbPath = resolveSessionDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  ensureWeixinTables(db);
  return db;
}

export function closeWeixinDb(): void {
  db?.close();
  db = null;
}

export function listWeixinAccounts(): WeixinAccountRow[] {
  return getDb()
    .prepare("select * from weixin_accounts order by created_at desc")
    .all() as WeixinAccountRow[];
}

export function getWeixinAccount(accountId: string): WeixinAccountRow | undefined {
  return getDb()
    .prepare("select * from weixin_accounts where account_id = ?")
    .get(accountId) as WeixinAccountRow | undefined;
}

export function upsertWeixinAccount(params: {
  accountId: string;
  userId?: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  name?: string;
  enabled?: boolean;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `insert into weixin_accounts
        (account_id, user_id, base_url, cdn_base_url, token, name, enabled, last_login_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(account_id) do update set
         user_id = excluded.user_id,
         base_url = excluded.base_url,
         cdn_base_url = excluded.cdn_base_url,
         token = excluded.token,
         name = excluded.name,
         enabled = excluded.enabled,
         last_login_at = excluded.last_login_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.accountId,
      params.userId || "",
      params.baseUrl,
      params.cdnBaseUrl,
      params.token,
      params.name || params.accountId,
      params.enabled === false ? 0 : 1,
      now,
      now,
      now,
    );
}

export function setWeixinAccountEnabled(accountId: string, enabled: boolean): void {
  getDb()
    .prepare("update weixin_accounts set enabled = ?, updated_at = ? where account_id = ?")
    .run(enabled ? 1 : 0, Date.now(), accountId);
}

export function deleteWeixinAccount(accountId: string): boolean {
  const targetDb = getDb();
  targetDb.prepare("delete from weixin_context_tokens where account_id = ?").run(accountId);
  targetDb.prepare("delete from weixin_offsets where account_id = ?").run(accountId);
  const result = targetDb.prepare("delete from weixin_accounts where account_id = ?").run(accountId);
  return result.changes > 0;
}

export function getWeixinContextToken(accountId: string, peerUserId: string): string | undefined {
  const row = getDb()
    .prepare(
      "select context_token from weixin_context_tokens where account_id = ? and peer_user_id = ?",
    )
    .get(accountId, peerUserId) as { context_token?: string } | undefined;
  return row?.context_token;
}

export function upsertWeixinContextToken(accountId: string, peerUserId: string, contextToken: string): void {
  getDb()
    .prepare(
      `insert into weixin_context_tokens (account_id, peer_user_id, context_token, updated_at)
       values (?, ?, ?, ?)
       on conflict(account_id, peer_user_id) do update set
         context_token = excluded.context_token,
         updated_at = excluded.updated_at`,
    )
    .run(accountId, peerUserId, contextToken, Date.now());
}

export function getWeixinPollCursor(accountId: string): string {
  const row = getDb()
    .prepare("select cursor from weixin_offsets where account_id = ?")
    .get(accountId) as { cursor?: string } | undefined;
  return row?.cursor || "";
}

export function setWeixinPollCursor(accountId: string, cursor: string): void {
  getDb()
    .prepare(
      `insert into weixin_offsets (account_id, cursor, updated_at)
       values (?, ?, ?)
       on conflict(account_id) do update set
         cursor = excluded.cursor,
         updated_at = excluded.updated_at`,
    )
    .run(accountId, cursor, Date.now());
}
