-- Foundation: identity, audit, outbox.

CREATE TABLE users (
  user_id       text PRIMARY KEY,
  subject       text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  email         text,
  roles         text[] NOT NULL DEFAULT '{}',
  divisions     text[] NOT NULL DEFAULT '{}',
  last_seen_at  timestamptz
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     text NOT NULL,
  action       text NOT NULL,
  object_type  text NOT NULL,
  object_id    text NOT NULL,
  before       jsonb,
  after        jsonb,
  request_id   text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_object_idx ON audit_log (object_type, object_id, at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at);
CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE TABLE outbox (
  event_id      bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (event_id) WHERE published_at IS NULL;

CREATE TABLE outbox_consumptions (
  event_id     bigint NOT NULL REFERENCES outbox(event_id),
  consumer     text NOT NULL,
  consumed_at  timestamptz NOT NULL DEFAULT now(),
  error        text,
  PRIMARY KEY (event_id, consumer)
);
