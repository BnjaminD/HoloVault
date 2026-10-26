import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migrationsDir = new URL('./migrations/', import.meta.url);

// schema.sql is the baseline (version 0); every later change is a numbered file in migrations/,
// applied once, in order, and recorded in PRAGMA user_version. Migrations must stay backward
// compatible (add, never drop or rename) so that a code rollback keeps working on the migrated base.
export function listMigrations() {
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{3}-[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: Number(file.slice(0, 3)), file, sql: readFileSync(new URL(file, migrationsDir), 'utf8') }));
}

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  const applied = [];
  for (const m of listMigrations()) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied.push(m.file);
  }
  return applied;
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schema);
  const applied = migrate(db);
  if (applied.length && path !== ':memory:') console.info(`[db] migrations appliquées : ${applied.join(', ')}`);
  return db;
}
