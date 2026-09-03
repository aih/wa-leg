import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';

export interface AuditEntry {
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/** Write one audit row. Call inside the transaction that makes the change. */
export async function writeAudit(tx: DbOrTx, e: AuditEntry): Promise<void> {
  await tx.execute(sql`INSERT INTO audit_log (actor_id, action, object_type, object_id, before, after, request_id)
    VALUES (${e.actorId}, ${e.action}, ${e.objectType}, ${e.objectId},
            ${e.before === undefined ? null : JSON.stringify(e.before)}::jsonb,
            ${e.after === undefined ? null : JSON.stringify(e.after)}::jsonb,
            ${e.requestId ?? null})`);
}
