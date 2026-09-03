-- Workflow module: instances, transitions, assignments, deadlines (research/workflow-engine.md section 4).

CREATE TABLE workflow_instances (
  id                uuid PRIMARY KEY,
  note_revision_id  uuid NOT NULL UNIQUE,
  bill_key          text NOT NULL,
  bill_version_id   text NOT NULL,             -- "billKey:versionCode", opaque to this module
  machine_name      text NOT NULL DEFAULT 'fiscalNote',
  machine_version   integer NOT NULL DEFAULT 1,
  state             text NOT NULL,
  snapshot          jsonb NOT NULL,
  drafter_id        text,
  reviewer_id       text,
  exec_index        integer NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 0,
  superseded_by     uuid REFERENCES workflow_instances(id),
  duplicated_from   uuid REFERENCES workflow_instances(id),
  requested_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_instances_state_idx ON workflow_instances (state);
CREATE INDEX workflow_instances_drafter_idx ON workflow_instances (drafter_id, state);
CREATE INDEX workflow_instances_reviewer_idx ON workflow_instances (reviewer_id, state);
CREATE INDEX workflow_instances_bill_idx ON workflow_instances (bill_key);

CREATE TABLE workflow_transitions (
  id            bigserial PRIMARY KEY,
  instance_id   uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  event         text NOT NULL,
  from_state    text NOT NULL,
  to_state      text NOT NULL,
  actor_id      text NOT NULL,
  actor_roles   text[] NOT NULL DEFAULT '{}',
  comment       text,
  payload       jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, seq)
);

CREATE TABLE workflow_assignments (
  id            uuid PRIMARY KEY,
  instance_id   uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  role          text NOT NULL,                 -- drafter | reviewer | exec
  position      integer NOT NULL DEFAULT 0,
  assignee_id   text NOT NULL,
  status        text NOT NULL DEFAULT 'active', -- active | done | reassigned | cancelled
  due_at        timestamptz,
  assigned_by   text NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX workflow_assignments_assignee_idx ON workflow_assignments (assignee_id, status);
CREATE UNIQUE INDEX workflow_assignments_active_idx ON workflow_assignments (instance_id, role, position) WHERE status = 'active';

CREATE TABLE workflow_deadlines (
  id              uuid PRIMARY KEY,
  instance_id     uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  kind            text NOT NULL,               -- statutory_72h | hearing_minus_4h | role_due
  assignment_id   uuid REFERENCES workflow_assignments(id) ON DELETE CASCADE,
  due_at          timestamptz NOT NULL,
  warn_at         timestamptz NOT NULL,        -- first note.due_soon (24 h before)
  warn_final_at   timestamptz NOT NULL,        -- second note.due_soon (4 h before)
  warned_at       timestamptz,
  warned_final_at timestamptz,
  breached_at     timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_deadlines_warn_idx ON workflow_deadlines (warn_at) WHERE warned_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX workflow_deadlines_warn_final_idx ON workflow_deadlines (warn_final_at) WHERE warned_final_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX workflow_deadlines_due_idx ON workflow_deadlines (due_at) WHERE breached_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX workflow_deadlines_instance_idx ON workflow_deadlines (instance_id);
