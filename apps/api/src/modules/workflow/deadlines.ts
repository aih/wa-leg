// Deadline rules. The 72-hour clock start is unverified (docs/OPEN-ITEMS.md); `statutoryDueAt` is the one place
// that encodes it, driven by STATUTORY_CLOCK_START and STATUTORY_HOURS.
import type { Config } from '../../config.js';

export type DeadlineKind = 'statutory_72h' | 'hearing_minus_4h' | 'role_due';

export interface DeadlineTimes {
  dueAt: Date;
  warnAt: Date;
  warnFinalAt: Date;
}

const H = 3_600_000;

export function statutoryDueAt(requestedAt: Date, cfg: Pick<Config, 'STATUTORY_CLOCK_START' | 'STATUTORY_HOURS'>): Date {
  switch (cfg.STATUTORY_CLOCK_START) {
    case 'request':
    default:
      return new Date(requestedAt.getTime() + cfg.STATUTORY_HOURS * H);
  }
}

export function hearingDueAt(hearingAt: Date, cfg: Pick<Config, 'HEARING_LEAD_HOURS'>): Date {
  return new Date(hearingAt.getTime() - cfg.HEARING_LEAD_HOURS * H);
}

/** Warn offsets per kind (research/workflow-engine.md section 5). */
export function times(kind: DeadlineKind, dueAt: Date): DeadlineTimes {
  const [first, second] = kind === 'role_due' ? [4, 4] : kind === 'hearing_minus_4h' ? [24, 2] : [24, 4];
  return { dueAt, warnAt: new Date(dueAt.getTime() - first * H), warnFinalAt: new Date(dueAt.getTime() - second * H) };
}

export type DueBand = 'more_than_24h' | 'within_24h' | 'within_4h' | 'overdue' | 'none';

/** Text band for dashboards: colour is never the only signal. */
export function dueBand(dueAt: string | null | undefined, now = new Date()): DueBand {
  if (!dueAt) return 'none';
  const ms = new Date(dueAt).getTime() - now.getTime();
  if (ms < 0) return 'overdue';
  if (ms < 4 * H) return 'within_4h';
  if (ms < 24 * H) return 'within_24h';
  return 'more_than_24h';
}
