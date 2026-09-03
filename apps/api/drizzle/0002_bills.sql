-- Bills module: bills, versions, amendments, hearings, prior fiscal notes, ingest runs.

CREATE TABLE bills (
  bill_key              text PRIMARY KEY,           -- WA:2025-26:HB2402
  biennium              text NOT NULL,
  chamber               text NOT NULL,              -- H | S
  type                  text NOT NULL,              -- HB, SB, HJR, ...
  number                integer NOT NULL,
  id                    text NOT NULL,              -- HB2402
  title                 text NOT NULL,
  description           text,
  status                text,
  status_date           date,
  current_version_code  text,
  legiscan_bill_id      integer,
  change_hash           text,
  sponsors              jsonb NOT NULL DEFAULT '[]',
  committee             jsonb,
  history               jsonb NOT NULL DEFAULT '[]',
  calendar              jsonb NOT NULL DEFAULT '[]',
  sasts                 jsonb NOT NULL DEFAULT '[]',
  referrals             jsonb NOT NULL DEFAULT '[]',
  progress              jsonb NOT NULL DEFAULT '[]',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_biennium_number_idx ON bills (biennium, number);
CREATE INDEX bills_status_idx ON bills (status);

CREATE TABLE bill_versions (
  bill_key          text NOT NULL REFERENCES bills(bill_key) ON DELETE CASCADE,
  version_code      text NOT NULL,                 -- I, S, S2, E, S.E, PL, SL, ...
  seq               integer NOT NULL,
  label             text NOT NULL,                 -- long label
  short_label       text NOT NULL,                 -- SHB 2402
  legiscan_type     text,
  legiscan_doc_id   integer,
  legiscan_text_hash text,
  document          jsonb,                         -- Bill Document JSON
  source_url_xml    text,
  source_url_pdf    text,
  source_url_htm    text,
  source_hash       text,
  fetched_at        timestamptz,
  parser            text,
  parser_version    text,
  status            text NOT NULL DEFAULT 'pending', -- pending | parsed | missing | error
  error             text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_key, version_code)
);

CREATE TABLE amendments (
  amendment_id          text PRIMARY KEY,          -- lawfilesext name: 6137 AMS CORA S4812.1
  bill_key              text NOT NULL REFERENCES bills(bill_key) ON DELETE CASCADE,
  base_version_code     text NOT NULL,
  chamber               text,
  sponsor               text,
  kind                  text,                      -- striking | page-line | title | unknown
  scope                 text,                      -- floor | committee | conference
  adopted               boolean NOT NULL DEFAULT false,
  floor_action          text,
  action_date           date,
  legiscan_amendment_id integer,
  legiscan_hash         text,
  document              jsonb,
  source_url_xml        text,
  source_url_pdf        text,
  source_hash           text,
  fetched_at            timestamptz,
  status                text NOT NULL DEFAULT 'pending',
  error                 text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX amendments_bill_idx ON amendments (bill_key, base_version_code);

CREATE TABLE hearings (
  id            text PRIMARY KEY,                  -- bill_key:event_hash
  bill_key      text NOT NULL REFERENCES bills(bill_key) ON DELETE CASCADE,
  committee     text NOT NULL,
  chamber       text,
  hearing_at    timestamptz NOT NULL,
  kind          text NOT NULL,                     -- public_hearing | executive_session | other
  source        text NOT NULL DEFAULT 'legiscan',
  description   text,
  location      text,
  cancelled     boolean NOT NULL DEFAULT false,
  revised_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hearings_bill_idx ON hearings (bill_key, hearing_at);
CREATE INDEX hearings_at_idx ON hearings (hearing_at) WHERE NOT cancelled;

CREATE TABLE prior_fiscal_notes (
  id             text PRIMARY KEY,                 -- ofm:75952
  bill_key       text NOT NULL REFERENCES bills(bill_key) ON DELETE CASCADE,
  package_id     integer,
  label          text NOT NULL,                    -- 2402 HB (Final)
  version_label  text,                             -- HB 2402
  kind           text,                             -- Final | Partial | Revised
  amendment_name text,
  url            text NOT NULL,
  published_at   date,
  legiscan_supplement_id integer
);
CREATE INDEX prior_fiscal_notes_bill_idx ON prior_fiscal_notes (bill_key);

CREATE TABLE ingest_runs (
  id            uuid PRIMARY KEY,
  source        text NOT NULL,                     -- legiscan | refresh | lsc
  path          text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running',   -- running | done | failed
  stats         jsonb NOT NULL DEFAULT '{}',
  error         text,
  requested_by  text
);
