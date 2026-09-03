-- Change requests: what a reviewer asked for when returning a note, itemised so the drafter can address and close
-- each point with a reference to the document version that resolved it.

CREATE TABLE note_change_requests (
  id                  uuid PRIMARY KEY,
  note_revision_id    uuid NOT NULL REFERENCES note_revisions(note_revision_id) ON DELETE CASCADE,
  transition_seq      integer,                       -- workflow transition that opened it
  event               text NOT NULL DEFAULT 'REQUEST_CHANGES',   -- REQUEST_CHANGES | EXEC_RETURN
  requested_by        text NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  document_version    integer,                       -- head document version when the request was made
  summary             text NOT NULL,
  status              text NOT NULL DEFAULT 'open',  -- open | closed
  closed_by           text,
  closed_at           timestamptz,
  resolution          text,
  resolution_version  integer,                       -- head document version when closed
  UNIQUE (note_revision_id, transition_seq)
);
CREATE INDEX note_change_requests_rev_idx ON note_change_requests (note_revision_id, status);

CREATE TABLE note_change_request_items (
  id                  uuid PRIMARY KEY,
  change_request_id   uuid NOT NULL REFERENCES note_change_requests(id) ON DELETE CASCADE,
  seq                 integer NOT NULL,
  comment_id          text REFERENCES note_comments(id) ON DELETE SET NULL,
  anchor_text         text,
  body                text NOT NULL,
  status              text NOT NULL DEFAULT 'open',  -- open | addressed
  addressed_by        text,
  addressed_at        timestamptz,
  resolution          text,
  resolution_version  integer,
  UNIQUE (change_request_id, seq)
);
