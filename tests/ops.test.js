import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { listMigrations, migrate, openDb } from '../src/db/index.js';
import { request, setup } from './helpers.js';

describe('exploitation', () => {
  it('/healthz répond ok sans session ni cache', async () => {
    const { app } = setup();
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('/healthz signale une base indisponible', async () => {
    const { app, db } = setup();
    db.close();
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 503);
  });
});

describe('migrations', () => {
  const latest = Math.max(0, ...listMigrations().map((m) => m.version));

  it('numéros uniques et croissants', () => {
    const versions = listMigrations().map((m) => m.version);
    assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b));
    assert.ok(versions.every((v, i) => v === i + 1), 'pas de trou dans la numérotation');
  });

  it('une base neuve est créée à la dernière version', () => {
    const db = openDb(':memory:');
    assert.equal(db.pragma('user_version', { simple: true }), latest);
  });

  it('une base existante (schéma initial) est migrée sans perte, une seule fois', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    db.prepare("INSERT INTO products (slug, name, game, price_cents, created_at) VALUES ('x', 'X', 'pokemon', 100, 42)").run();
    assert.ok(migrate(db).length > 0);
    assert.equal(db.pragma('user_version', { simple: true }), latest);
    assert.equal(db.prepare('SELECT updated_at FROM products').get().updated_at, 42);
    assert.deepEqual(migrate(db), []);
  });
});
