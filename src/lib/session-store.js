import session from 'express-session';

export class SqliteSessionStore extends session.Store {
  constructor(db, { defaultTtlMs = 86_400_000 } = {}) {
    super();
    this.defaultTtlMs = defaultTtlMs;
    this.stmts = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
  }

  expiry(sess) {
    const exp = sess?.cookie?.expires;
    return exp ? new Date(exp).getTime() : Date.now() + this.defaultTtlMs;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.expiry(sess));
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmts.destroy.run(sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.expiry(sess), sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  prune() {
    return this.stmts.prune.run(Date.now()).changes;
  }
}
