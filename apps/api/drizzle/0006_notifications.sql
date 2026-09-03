-- Notifications module: the in-app inbox. Delivery adapters (SMTP in development) write emailed_at.

CREATE TABLE notifications (
  id           uuid PRIMARY KEY,
  user_id      text NOT NULL,
  type         text NOT NULL,                  -- note.assigned, note.submitted, note.changes_requested, ...
  title        text NOT NULL,
  body         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  link         text,
  event_id     bigint,                         -- outbox event that produced it (idempotency)
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  emailed_at   timestamptz,
  email_error  text
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);
CREATE UNIQUE INDEX notifications_event_user_idx ON notifications (event_id, user_id, type) WHERE event_id IS NOT NULL;
