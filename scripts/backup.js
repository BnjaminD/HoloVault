// Consistent online backup of the SQLite database, safe while the shop is running.
// Usage: npm run backup   (BACKUP_DIR, défaut ./data/backups ; BACKUP_KEEP, défaut 14 fichiers conservés)
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';

const config = loadConfig();
const dir = process.env.BACKUP_DIR || `${ROOT}data/backups`;
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));

if (!existsSync(config.databasePath)) {
  // First deployment: nothing to save yet. Elsewhere (cron) a missing base is an error worth alerting on.
  if (process.env.BACKUP_ALLOW_MISSING === '1') {
    console.info(`Aucune base à sauvegarder (${config.databasePath})`);
    process.exit(0);
  }
  console.error(`Base introuvable : ${config.databasePath}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = join(dir, `shop-${stamp}.db`);

const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
await db.backup(dest);
db.close();

// A backup that cannot be opened is worse than none: check it before rotating older ones out.
// The copy inherits WAL mode from the source; switch it back so it stays a single self-contained file.
const copy = new Database(dest);
copy.pragma('journal_mode = DELETE');
const integrity = copy.pragma('integrity_check', { simple: true });
copy.close();
if (integrity !== 'ok') {
  console.error(`Sauvegarde corrompue (${integrity}), conservée pour analyse : ${dest}`);
  process.exit(1);
}

const old = readdirSync(dir).filter((f) => /^shop-\d{8}-\d{6}\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, f + suffix), { force: true });
console.info(`Sauvegarde OK : ${dest}${old.length ? ` (${old.length} ancienne(s) supprimée(s))` : ''}`);
