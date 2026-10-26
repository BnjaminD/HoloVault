import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
