-- Search module: Postgres full-text fallback for the SearchBackend interface.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE search_docs (
  id                 text PRIMARY KEY,
  doc_type           text NOT NULL,
  bill_key           text,
  biennium           text,
  chamber            text,
  type               text,
  bill_number        text,
  display            text,
  status             text,
  committee          text,
  has_fiscal_note    boolean NOT NULL DEFAULT false,
  fiscal_note_status text,
  visibility         text NOT NULL DEFAULT 'public',
  allowed_roles      text[] NOT NULL DEFAULT '{}',
  allowed_user_ids   text[] NOT NULL DEFAULT '{}',
  assigned_user_ids  text[] NOT NULL DEFAULT '{}',
  rcw_cites          text[] NOT NULL DEFAULT '{}',
  rcw_chapters       text[] NOT NULL DEFAULT '{}',
  rcw_titles         text[] NOT NULL DEFAULT '{}',
  sponsor_last_names text[] NOT NULL DEFAULT '{}',
  version_code       text,
  version_label      text,
  is_latest_version  boolean,
  last_action_date   date,
  title              text,
  heading            text,
  body               text,
  bill_number_forms  text[] NOT NULL DEFAULT '{}',
  payload            jsonb NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  source_hash        text,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED
);
CREATE INDEX search_docs_tsv_idx ON search_docs USING gin (tsv);
CREATE INDEX search_docs_title_trgm_idx ON search_docs USING gin (title gin_trgm_ops);
CREATE INDEX search_docs_biennium_type_idx ON search_docs (biennium, doc_type);
CREATE INDEX search_docs_bill_key_idx ON search_docs (bill_key);
CREATE INDEX search_docs_rcw_cites_idx ON search_docs USING gin (rcw_cites);
CREATE INDEX search_docs_rcw_chapters_idx ON search_docs USING gin (rcw_chapters);
CREATE INDEX search_docs_allowed_users_idx ON search_docs USING gin (allowed_user_ids);
CREATE INDEX search_docs_forms_idx ON search_docs USING gin (bill_number_forms);
