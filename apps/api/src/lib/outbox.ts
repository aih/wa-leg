// Transactional outbox and in-process event bus (design/ARCHITECTURE.md "Event catalog").
// Producers insert rows inside their transaction with `emitEvent`. The relay publishes unpublished rows
// to subscribers; each (event, consumer) pair is recorded so handlers run once.
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import type { Logger } from 'pino';

export interface BusEvent<T = any> {
  eventId: number;
  type: string;
  payload: T;
  createdAt: Date;
}

export type EventHandler = (event: BusEvent, db: Db) => Promise<void>;

interface Subscription {
  consumer: string;
  types: Set<string>;
  handler: EventHandler;
}

export async function emitEvent(tx: DbOrTx, type: string, payload: unknown): Promise<number> {
  const res = await tx.execute(
    sql`INSERT INTO outbox (type, payload) VALUES (${type}, ${JSON.stringify(payload)}::jsonb) RETURNING event_id`,
  );
  const row = res.rows[0] as { event_id: string | number };
  return Number(row.event_id);
}

export class OutboxRelay {
  private subs: Subscription[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private inflight: Promise<void> | null = null;
  private lastPublished = 0;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly pollMs = 500,
  ) {}

  /** Subscribe a named consumer to one or more event types. Names must be stable across restarts. */
  subscribe(consumer: string, types: string | string[], handler: EventHandler): void {
    const list = Array.isArray(types) ? types : [types];
    this.subs.push({ consumer, types: new Set(list), handler });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask the relay to publish soon; used after a transaction commits. */
  kick(): void {
    void this.drain();
  }

  /** Publish all unpublished rows and run every matching consumer. Resolves when the queue is empty. */
  async drain(): Promise<void> {
    if (this.running) {
      this.pending = true;
      // Wait for the in-flight run, which re-enters once it sees `pending`, so callers observe an empty queue.
      await this.inflight;
      return;
    }
    this.running = true;
    this.inflight = this.run();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        this.pending = false;
        const batch = await this.fetchBatch();
        if (batch.length === 0) {
          // A kick that arrived during the fetch may have committed a row after the query ran.
          if (this.pending) continue;
          break;
        }
        for (const ev of batch) {
          await this.deliver(ev);
          await this.db.execute(sql`UPDATE outbox SET published_at = now() WHERE event_id = ${ev.eventId}`);
          this.lastPublished = ev.eventId;
        }
      }
    } catch (err) {
      this.log.error({ err }, 'outbox relay failed');
    } finally {
      this.running = false;
    }
  }

  private async fetchBatch(): Promise<BusEvent[]> {
    const res = await this.db.execute(
      sql`SELECT event_id, type, payload, created_at FROM outbox WHERE published_at IS NULL ORDER BY event_id LIMIT 100`,
    );
    return (res.rows as any[]).map((r) => ({
      eventId: Number(r.event_id),
      type: r.type as string,
      payload: r.payload,
      createdAt: new Date(r.created_at),
    }));
  }

  private async deliver(ev: BusEvent): Promise<void> {
    for (const sub of this.subs) {
      if (!sub.types.has(ev.type) && !sub.types.has('*')) continue;
      const claimed = await this.db.execute(
        sql`INSERT INTO outbox_consumptions (event_id, consumer) VALUES (${ev.eventId}, ${sub.consumer})
            ON CONFLICT DO NOTHING RETURNING event_id`,
      );
      if (claimed.rows.length === 0) continue; // already consumed
      try {
        await sub.handler(ev, this.db);
      } catch (err) {
        this.log.error({ err, eventId: ev.eventId, type: ev.type, consumer: sub.consumer }, 'event handler failed');
        await this.db.execute(
          sql`UPDATE outbox_consumptions SET error = ${String((err as Error).message ?? err)}
              WHERE event_id = ${ev.eventId} AND consumer = ${sub.consumer}`,
        );
      }
    }
  }
}
