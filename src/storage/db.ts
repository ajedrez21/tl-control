import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.ts";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
  const version = getMeta(db, "schema_version") ?? "0";
  const current = Number(version);
  if (current < 1) setMeta(db, "schema_version", "1");
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function dbExists(path: string): boolean {
  return existsSync(path);
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): void {
  db.prepare(sql).run(...params);
}

export function sqlv(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  return value as SQLInputValue;
}
