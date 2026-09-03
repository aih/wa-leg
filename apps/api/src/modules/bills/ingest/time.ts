// Hearing times arrive as Pacific wall-clock date and time; convert at the boundary.

const PACIFIC = 'America/Los_Angeles';

/** Offset in minutes of the Pacific zone at a given UTC instant. */
function pacificOffsetMinutes(utc: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(utc).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - utc.getTime()) / 60_000);
}

/** "2026-01-23" + "08:00" in Pacific time → ISO instant. Returns null for an unusable date. */
export function pacificToIso(date: string, time: string | undefined): string | null {
  if (!date || date === '0000-00-00') return null;
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = (time && /^\d{1,2}:\d{2}/.test(time) ? time : '00:00').split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh ?? 0, mm ?? 0));
  // Two passes handle a DST boundary on the same day.
  let offset = pacificOffsetMinutes(guess);
  let instant = new Date(guess.getTime() - offset * 60_000);
  offset = pacificOffsetMinutes(instant);
  instant = new Date(guess.getTime() - offset * 60_000);
  return instant.toISOString();
}
