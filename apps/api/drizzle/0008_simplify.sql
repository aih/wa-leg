-- 0.2 simplification (docs/SIMPLIFY-0.2.md section 2, "Data"): five workflow states, four events, no deadlines,
-- assignments, notifications, locks or change request items; publication fields on the revision.

-- Workflow instances: collapse the ten states into five.
UPDATE workflow_instances SET state = 'draft' WHERE state IN ('todo', 'in_progress', 'cancelled', 'superseded');
UPDATE workflow_instances SET state = 'in_review' WHERE state IN ('review.pending', 'review.active', 'exec_review.pending', 'exec_review.active');
ALTER TABLE workflow_instances DROP COLUMN exec_index;
ALTER TABLE workflow_instances DROP COLUMN superseded_by;
ALTER TABLE workflow_instances DROP COLUMN snapshot;
ALTER TABLE workflow_instances DROP COLUMN machine_name;
ALTER TABLE workflow_instances DROP COLUMN machine_version;

-- Revisions: publication record. Request, priority and confidentiality lived on `notes`.
ALTER TABLE note_revisions ADD COLUMN published_at timestamptz;
ALTER TABLE note_revisions ADD COLUMN published_by text;
ALTER TABLE note_revisions ADD COLUMN published_version integer;
ALTER TABLE notes DROP COLUMN priority;
ALTER TABLE notes DROP COLUMN confidential;
ALTER TABLE notes DROP COLUMN request_id;
ALTER TABLE notes DROP COLUMN request_source;
ALTER TABLE notes DROP COLUMN requested_at;
ALTER TABLE notes DROP COLUMN requested_by;
ALTER TABLE notes DROP COLUMN leg_contact;
ALTER TABLE notes DROP COLUMN ten_year_requested;

DROP TABLE workflow_deadlines;
DROP TABLE workflow_assignments;
DROP TABLE notifications;
DROP TABLE note_locks;
DROP TABLE note_change_request_items;

-- Change requests: the reviewer's message and the drafter's reply on resubmission.
ALTER TABLE note_change_requests DROP COLUMN transition_seq;
ALTER TABLE note_change_requests DROP COLUMN event;
ALTER TABLE note_change_requests DROP COLUMN document_version;
ALTER TABLE note_change_requests DROP COLUMN status;
ALTER TABLE note_change_requests DROP COLUMN closed_by;
ALTER TABLE note_change_requests DROP COLUMN resolution_version;
ALTER TABLE note_change_requests RENAME COLUMN closed_at TO resolved_at;
DROP INDEX IF EXISTS note_change_requests_rev_idx;
CREATE INDEX note_change_requests_rev_idx ON note_change_requests (note_revision_id, resolved_at);
