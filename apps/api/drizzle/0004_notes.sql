-- Notes, templates, reference data (ARCHITECTURE.md "Data model summary").

CREATE TABLE notes (
  note_id          uuid PRIMARY KEY,
  bill_key         text NOT NULL,
  request_id       text,
  request_source   text NOT NULL DEFAULT 'manual',
  requested_at     timestamptz,
  requested_by     text,
  leg_contact      jsonb,
  ten_year_requested boolean NOT NULL DEFAULT false,
  confidential     boolean NOT NULL DEFAULT false,
  kind             text NOT NULL DEFAULT 'note',      -- note | estimate
  priority         text NOT NULL DEFAULT 'normal',
  identifier       text,                              -- analyst override (B.RFA.03)
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_bill_idx ON notes (bill_key);

CREATE TABLE note_revisions (
  note_revision_id      uuid PRIMARY KEY,
  note_id               uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  version_code          text NOT NULL,
  amendment_id          text,
  previous_revision_id  uuid REFERENCES note_revisions(note_revision_id),
  drafter_id            text,
  template_id           text,
  template_version      integer,
  mode                  text NOT NULL DEFAULT 'limited',
  head_version          integer NOT NULL DEFAULT 0,
  approved_document_version integer,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_revisions_note_idx ON note_revisions (note_id);
CREATE INDEX note_revisions_drafter_idx ON note_revisions (drafter_id);

CREATE TABLE note_documents (
  note_revision_id  uuid NOT NULL REFERENCES note_revisions(note_revision_id) ON DELETE CASCADE,
  version           integer NOT NULL,
  mode              text NOT NULL DEFAULT 'limited',
  doc_json          jsonb NOT NULL,
  doc_html          text NOT NULL DEFAULT '',
  doc_text          text NOT NULL DEFAULT '',
  estimate_data     jsonb,
  validation        jsonb,
  label             text,                             -- named snapshot label; null for autosave heads
  summary           text,
  client_id         text,
  updated_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_revision_id, version)
);

CREATE TABLE note_comments (
  id               text PRIMARY KEY,
  note_revision_id uuid NOT NULL REFERENCES note_revisions(note_revision_id) ON DELETE CASCADE,
  anchor_text      text NOT NULL,
  status           text NOT NULL DEFAULT 'open',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_by      text,
  resolved_at      timestamptz
);
CREATE INDEX note_comments_rev_idx ON note_comments (note_revision_id);

CREATE TABLE note_comment_messages (
  id          text PRIMARY KEY,
  comment_id  text NOT NULL REFERENCES note_comments(id) ON DELETE CASCADE,
  author_id   text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE note_locks (
  note_revision_id uuid PRIMARY KEY REFERENCES note_revisions(note_revision_id) ON DELETE CASCADE,
  holder           text NOT NULL,
  expires_at       timestamptz NOT NULL
);

CREATE TABLE note_exports (
  id                uuid PRIMARY KEY,
  note_revision_id  uuid NOT NULL REFERENCES note_revisions(note_revision_id) ON DELETE CASCADE,
  format            text NOT NULL,
  document_version  integer NOT NULL,
  status            text NOT NULL DEFAULT 'done',
  path              text,
  content_type      text,
  size_bytes        integer,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id           text NOT NULL,
  version      integer NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'document',       -- document | snippet
  mode         text NOT NULL DEFAULT 'limited',
  description  text,
  file         text,
  tags         jsonb NOT NULL DEFAULT '[]',
  parts        jsonb NOT NULL DEFAULT '[]',
  tables       jsonb NOT NULL DEFAULT '[]',
  slots        jsonb NOT NULL DEFAULT '[]',
  tokens       jsonb NOT NULL DEFAULT '[]',
  html         text NOT NULL,
  etag         text NOT NULL,
  current      boolean NOT NULL DEFAULT true,
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE TABLE reference_sets (
  name     text NOT NULL,
  session  text NOT NULL DEFAULT '2025-26',
  data     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, session)
);
