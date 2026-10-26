-- Durable e-mail queue: a message is stored first, then sent and retried by the mailer.
-- The body is wiped once sent (or abandoned): order confirmations contain the guest access code.
CREATE TABLE email_outbox (
  id               INTEGER PRIMARY KEY,
  recipient        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NOT NULL DEFAULT '',
  next_attempt_at  INTEGER NOT NULL,
  sent_at          INTEGER,
  failed_at        INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_outbox_due ON email_outbox (next_attempt_at) WHERE sent_at IS NULL AND failed_at IS NULL;
