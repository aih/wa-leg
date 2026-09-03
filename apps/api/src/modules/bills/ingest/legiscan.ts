// Legiscan dataset loader: bill JSON → bills, versions (fetched from lawfilesext as XML), amendments,
// hearings, prior fiscal notes. Design: design/research/legiscan-data.md, ARCHITECTURE.md "Bills".
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { billKey as makeBillKey, label as shortLabel, parse as parseRef, parseVersionFile, versionSeq, type BillType } from '@wa-leg/billref';
import { parseBillXml, parseBillHtm, parseAmendmentXml, PARSER_VERSION, type BillDocument, type AmendmentDocument } from '@wa-leg/bill-document';
import type { Db, DbOrTx } from '../../../db/client.js';
import { emitEvent } from '../../../lib/outbox.js';
import { xmlUrlFromPdf, htmUrlFromPdf, fileNameOf, mapLimit, type DocumentFetcher } from './lawfiles.js';
import { pacificToIso } from './time.js';

export interface LegiscanBill {
  bill_id: number;
  change_hash: string;
  session: { year_start: number; year_end: number; session_name: string };
  state_link: string;
  status: number;
  status_date: string;
  progress: unknown[];
  bill_number: string;
  bill_type: string;
  body: string;
  current_body: string;
  title: string;
  description: string;
  committee: unknown;
  referrals: unknown[];
  history: { date: string; action: string; chamber: string; importance: number }[];
  sponsors: unknown[];
  sasts: { type: string; sast_bill_number: string; sast_bill_id: number }[];
  texts: { doc_id: number; date: string; type: string; type_id: number; state_link: string; text_hash: string }[];
  amendments: { amendment_id: number; adopted: number; chamber: string; date: string; title: string; description: string; state_link: string; amendment_hash: string }[];
  supplements: { supplement_id: number; date: string; type: string; title: string; description: string; state_link: string; supplement_hash: string }[];
  calendar: { type_id: number; event_hash: string; type: string; date: string; time: string; location: string; description: string }[];
}

export const STATUS_NAMES: Record<number, string> = { 0: 'unknown', 1: 'introduced', 2: 'engrossed', 3: 'enrolled', 4: 'passed', 5: 'vetoed', 6: 'failed' };

export interface IngestOptions {
  limit?: number;
  /** Only these bill numbers (HB2402). */
  bills?: string[];
  /** Skip document fetching (index only). */
  fetchDocuments?: boolean;
  concurrency?: number;
  onProgress?: (msg: string) => void;
  /** Re-fetch documents even when the hash is unchanged. */
  force?: boolean;
}

export interface IngestStats {
  billsSeen: number;
  billsUpserted: number;
  billsUnchanged: number;
  versionsParsed: number;
  versionsMissing: number;
  versionsErrored: number;
  amendmentsParsed: number;
  amendmentsMissing: number;
  hearings: number;
  priorFiscalNotes: number;
  errors: string[];
}

export function bienniumOfSession(s: LegiscanBill['session']): string {
  return `${s.year_start}-${String(s.year_end).slice(2)}`;
}

export function parseAmendmentName(name: string): { number: number; versionFile: string; house: 'AMH' | 'AMS' | 'AMC'; sponsor: string; drafter: string } | null {
  const m = /^(\d{4})((?:-S\d?)?(?:\.E\d?)?)\s+(AMH|AMS|AMC)\s+([A-Z&]{2,5})\s+(.+)$/.exec(name);
  if (!m) return null;
  return { number: Number(m[1]), versionFile: `${m[1]}${m[2]}`, house: m[3] as 'AMH' | 'AMS' | 'AMC', sponsor: m[4]!, drafter: m[5]! };
}

export function hearingKind(description: string): 'public_hearing' | 'executive_session' | 'other' {
  const d = description.toLowerCase();
  if (d.includes('public hearing')) return 'public_hearing';
  if (d.includes('executive session') || d.includes('executive action')) return 'executive_session';
  return 'other';
}

export function committeeOf(location: string): { chamber: 'H' | 'S' | null; committee: string } {
  const m = /^(House|Senate|Joint)\s+Committee on\s+(.+)$/i.exec(location.trim());
  if (m) return { chamber: m[1]!.toLowerCase() === 'house' ? 'H' : m[1]!.toLowerCase() === 'senate' ? 'S' : null, committee: m[2]!.trim() };
  return { chamber: null, committee: location.trim() };
}

export function fiscalNoteLabel(description: string): { versionLabel?: string; kind?: string; amendmentName?: string } {
  const m = /^(.*?)\s*\((Final|Partial|Revised)\)\s*$/i.exec(description.trim());
  const head = (m?.[1] ?? description).trim();
  const out: { versionLabel?: string; kind?: string; amendmentName?: string } = {};
  if (m) out.kind = m[2]!;
  const r = parseRef(head, { currentBiennium: '2025-26' });
  if (r.ref?.kind === 'bill') {
    out.versionLabel = shortLabel(r.ref);
    if (r.ref.amendment?.drafterNumber) out.amendmentName = head.replace(/^\d+\s+\S+\s+/, '');
  } else out.versionLabel = head;
  return out;
}

export function readDataset(dir: string, opts: Pick<IngestOptions, 'limit' | 'bills'> = {}): LegiscanBill[] {
  const billDir = existsSync(join(dir, 'bill')) ? join(dir, 'bill') : dir;
  let files = readdirSync(billDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (opts.bills?.length) {
    const want = new Set(opts.bills.map((b) => b.toUpperCase().replace(/\s+/g, '')));
    files = files.filter((f) => want.has(f.replace(/\.json$/i, '').toUpperCase()));
  }
  if (opts.limit) files = files.slice(0, opts.limit);
  return files.map((f) => (JSON.parse(readFileSync(join(billDir, f), 'utf8')) as { bill: LegiscanBill }).bill);
}

export interface LoaderDeps {
  db: Db;
  fetcher: DocumentFetcher;
  log: Logger;
}

function typeOf(b: LegiscanBill): BillType {
  const m = /^([A-Z]+)(\d+)$/.exec(b.bill_number);
  return (m?.[1] ?? (b.body === 'H' ? 'HB' : 'SB')) as BillType;
}

/** Load a set of Legiscan bills. Idempotent: unchanged bills (same change_hash) are skipped unless forced. */
export async function ingestLegiscanBills(deps: LoaderDeps, billsJson: LegiscanBill[], opts: IngestOptions = {}): Promise<IngestStats> {
  const stats: IngestStats = {
    billsSeen: 0,
    billsUpserted: 0,
    billsUnchanged: 0,
    versionsParsed: 0,
    versionsMissing: 0,
    versionsErrored: 0,
    amendmentsParsed: 0,
    amendmentsMissing: 0,
    hearings: 0,
    priorFiscalNotes: 0,
    errors: [],
  };
  const fetchDocs = opts.fetchDocuments ?? true;
  await mapLimit(billsJson, opts.concurrency ?? 4, async (b) => {
    stats.billsSeen += 1;
    try {
      const changed = await ingestOneBill(deps, b, opts, stats, fetchDocs);
      if (changed) stats.billsUpserted += 1;
      else stats.billsUnchanged += 1;
      opts.onProgress?.(`${b.bill_number} ${changed ? 'loaded' : 'unchanged'} (${stats.billsSeen}/${billsJson.length})`);
    } catch (err) {
      const msg = `${b.bill_number}: ${(err as Error).message}`;
      stats.errors.push(msg);
      deps.log.error({ err, bill: b.bill_number }, 'ingest failed');
    }
  });
  return stats;
}

async function ingestOneBill(deps: LoaderDeps, b: LegiscanBill, opts: IngestOptions, stats: IngestStats, fetchDocs: boolean): Promise<boolean> {
  const { db } = deps;
  const biennium = bienniumOfSession(b.session);
  const type = typeOf(b);
  const number = Number(b.bill_number.replace(/^[A-Z]+/, ''));
  const key = makeBillKey({ biennium, type, number });
  const existing = (await db.execute(sql`SELECT change_hash, current_version_code, status FROM bills WHERE bill_key = ${key}`)).rows[0] as
    | { change_hash: string | null; current_version_code: string | null; status: string | null }
    | undefined;
  if (existing && existing.change_hash === b.change_hash && !opts.force) {
    // Still make sure documents that were never fetched get another try.
    if (fetchDocs) await fetchPendingVersions(deps, key, biennium, type, number, stats, b);
    return false;
  }

  // Versions from texts[]: derive the code from the file name, fall back to the Legiscan type.
  const versions = b.texts
    .map((t) => {
      const name = fileNameOf(t.state_link);
      const vf = parseVersionFile(name);
      const code = vf?.code ?? codeFromLegiscanType(t.type);
      return { text: t, code, name };
    })
    .filter((v, i, arr) => arr.findIndex((x) => x.code === v.code) === i)
    .sort((a, c) => versionSeq(a.code) - versionSeq(c.code));
  const currentCode = versions.length ? versions[versions.length - 1]!.code : 'I';
  const status = STATUS_NAMES[b.status] ?? 'unknown';

  await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO bills (bill_key, biennium, chamber, type, number, id, title, description, status, status_date,
        current_version_code, legiscan_bill_id, change_hash, sponsors, committee, history, calendar, sasts, referrals, progress, updated_at)
      VALUES (${key}, ${biennium}, ${type.startsWith('H') ? 'H' : 'S'}, ${type}, ${number}, ${`${type}${number}`}, ${b.title}, ${b.description ?? null},
        ${status}, ${b.status_date && b.status_date !== '0000-00-00' ? b.status_date : null}, ${currentCode}, ${b.bill_id}, ${b.change_hash},
        ${JSON.stringify(b.sponsors ?? [])}::jsonb, ${b.committee ? JSON.stringify(b.committee) : null}::jsonb, ${JSON.stringify(b.history ?? [])}::jsonb,
        ${JSON.stringify(b.calendar ?? [])}::jsonb, ${JSON.stringify(b.sasts ?? [])}::jsonb, ${JSON.stringify(b.referrals ?? [])}::jsonb,
        ${JSON.stringify(b.progress ?? [])}::jsonb, now())
      ON CONFLICT (bill_key) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
        status_date = EXCLUDED.status_date, current_version_code = EXCLUDED.current_version_code, change_hash = EXCLUDED.change_hash,
        sponsors = EXCLUDED.sponsors, committee = EXCLUDED.committee, history = EXCLUDED.history, calendar = EXCLUDED.calendar,
        sasts = EXCLUDED.sasts, referrals = EXCLUDED.referrals, progress = EXCLUDED.progress, updated_at = now()`);
    if (!existing) await emitEvent(tx, 'bill.created', { billKey: key });
    else if (existing.status !== status) {
      await emitEvent(tx, 'bill.status_changed', { billKey: key, status, action: b.history[b.history.length - 1]?.action ?? null, date: b.status_date });
    }

    // Version rows (documents fetched after the transaction).
    for (const v of versions) {
      const pdf = v.text.state_link;
      await tx.execute(sql`INSERT INTO bill_versions (bill_key, version_code, seq, label, short_label, legiscan_type, legiscan_doc_id, legiscan_text_hash,
          source_url_xml, source_url_pdf, source_url_htm, status)
        VALUES (${key}, ${v.code}, ${versionSeq(v.code)}, ${v.code}, ${shortLabel({ type, number, versionCode: v.code })}, ${v.text.type}, ${v.text.doc_id},
          ${v.text.text_hash}, ${xmlUrlFromPdf(pdf)}, ${pdf}, ${htmUrlFromPdf(pdf)}, 'pending')
        ON CONFLICT (bill_key, version_code) DO UPDATE SET legiscan_type = EXCLUDED.legiscan_type, legiscan_doc_id = EXCLUDED.legiscan_doc_id,
          legiscan_text_hash = EXCLUDED.legiscan_text_hash, source_url_pdf = EXCLUDED.source_url_pdf, source_url_xml = EXCLUDED.source_url_xml,
          source_url_htm = EXCLUDED.source_url_htm,
          status = CASE WHEN bill_versions.legiscan_text_hash IS DISTINCT FROM EXCLUDED.legiscan_text_hash THEN 'pending' ELSE bill_versions.status END`);
    }

    // Amendments index.
    for (const a of b.amendments ?? []) {
      const name = fileNameOf(a.state_link).replace(/\.pdf$/i, '');
      const parsed = parseAmendmentName(name);
      const baseCode = parsed ? (parseVersionFile(parsed.versionFile)?.code ?? 'I') : 'I';
      const sponsor = a.description.replace(new RegExp(`\\s*${escapeRe(name)}\\s*$`), '').trim() || null;
      const chamber = parsed?.house === 'AMH' ? 'H' : parsed?.house === 'AMS' ? 'S' : a.chamber || null;
      await tx.execute(sql`INSERT INTO amendments (amendment_id, bill_key, base_version_code, chamber, sponsor, adopted, legiscan_amendment_id, legiscan_hash,
          source_url_xml, source_url_pdf, action_date, status)
        VALUES (${name}, ${key}, ${baseCode}, ${chamber}, ${sponsor}, ${a.adopted === 1}, ${a.amendment_id}, ${a.amendment_hash},
          ${xmlUrlFromPdf(a.state_link)}, ${a.state_link}, ${a.date && a.date !== '0000-00-00' ? a.date : null}, 'pending')
        ON CONFLICT (amendment_id) DO UPDATE SET adopted = EXCLUDED.adopted, sponsor = EXCLUDED.sponsor, legiscan_hash = EXCLUDED.legiscan_hash,
          action_date = COALESCE(EXCLUDED.action_date, amendments.action_date),
          status = CASE WHEN amendments.legiscan_hash IS DISTINCT FROM EXCLUDED.legiscan_hash THEN 'pending' ELSE amendments.status END`);
    }

    // Hearings from calendar[].
    const before = (await tx.execute(sql`SELECT id, hearing_at, cancelled FROM hearings WHERE bill_key = ${key}`)).rows as { id: string; hearing_at: Date; cancelled: boolean }[];
    const seen = new Set<string>();
    for (const c of b.calendar ?? []) {
      const at = pacificToIso(c.date, c.time);
      if (!at) continue;
      const id = `${key}:${c.event_hash}`;
      seen.add(id);
      const { chamber, committee } = committeeOf(c.location);
      const kind = hearingKind(c.description);
      const prev = before.find((h) => h.id === id);
      await tx.execute(sql`INSERT INTO hearings (id, bill_key, committee, chamber, hearing_at, kind, source, description, location, cancelled, revised_at)
        VALUES (${id}, ${key}, ${committee}, ${chamber}, ${at}::timestamptz, ${kind}, 'legiscan', ${c.description}, ${c.location}, false, now())
        ON CONFLICT (id) DO UPDATE SET committee = EXCLUDED.committee, chamber = EXCLUDED.chamber, hearing_at = EXCLUDED.hearing_at, kind = EXCLUDED.kind,
          description = EXCLUDED.description, location = EXCLUDED.location, cancelled = false,
          revised_at = CASE WHEN hearings.hearing_at <> EXCLUDED.hearing_at OR hearings.cancelled THEN now() ELSE hearings.revised_at END`);
      stats.hearings += 1;
      const payload = { billKey: key, versionCode: currentCode, hearingAt: at, committee, chamber, kind, hearingId: id };
      if (!prev) await emitEvent(tx, 'hearing.scheduled', payload);
      else if (new Date(prev.hearing_at).toISOString() !== new Date(at).toISOString() || prev.cancelled) await emitEvent(tx, 'hearing.rescheduled', payload);
    }
    for (const h of before) {
      if (!seen.has(h.id) && !h.cancelled && new Date(h.hearing_at) > new Date()) {
        await tx.execute(sql`UPDATE hearings SET cancelled = true, revised_at = now() WHERE id = ${h.id}`);
        await emitEvent(tx, 'hearing.cancelled', { billKey: key, hearingId: h.id, hearingAt: new Date(h.hearing_at).toISOString() });
      }
    }

    // Prior fiscal notes from supplements[].
    for (const s of b.supplements ?? []) {
      if (s.type !== 'Fiscal Note') continue;
      const pm = /packageID=(\d+)/i.exec(s.state_link);
      const packageId = pm ? Number(pm[1]) : null;
      const id = packageId ? `ofm:${packageId}` : `legiscan:${s.supplement_id}`;
      const parsed = fiscalNoteLabel(s.description);
      await tx.execute(sql`INSERT INTO prior_fiscal_notes (id, bill_key, package_id, label, version_label, kind, amendment_name, url, published_at, legiscan_supplement_id)
        VALUES (${id}, ${key}, ${packageId}, ${s.description}, ${parsed.versionLabel ?? null}, ${parsed.kind ?? null}, ${parsed.amendmentName ?? null}, ${s.state_link},
          ${s.date && s.date !== '0000-00-00' ? s.date : null}, ${s.supplement_id})
        ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, version_label = EXCLUDED.version_label, kind = EXCLUDED.kind, url = EXCLUDED.url,
          published_at = EXCLUDED.published_at`);
      stats.priorFiscalNotes += 1;
    }
  });

  if (fetchDocs) await fetchPendingVersions(deps, key, biennium, type, number, stats, b);
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function codeFromLegiscanType(type: string): string {
  switch (type) {
    case 'Comm Sub':
      return 'S';
    case 'Engrossed':
      return 'E';
    case 'Enrolled':
      return 'PL';
    case 'Chaptered':
      return 'SL';
    default:
      return 'I';
  }
}

/** Fetch and parse every pending version and amendment of a bill. */
export async function fetchPendingVersions(deps: LoaderDeps, key: string, biennium: string, type: BillType, number: number, stats: IngestStats, b?: LegiscanBill): Promise<void> {
  const { db, fetcher } = deps;
  const pending = (await db.execute(sql`SELECT version_code, source_url_xml, source_url_htm, source_url_pdf FROM bill_versions
      WHERE bill_key = ${key} AND status IN ('pending', 'error') ORDER BY seq`)).rows as {
    version_code: string;
    source_url_xml: string;
    source_url_htm: string;
    source_url_pdf: string;
  }[];
  const allCodes = ((await db.execute(sql`SELECT version_code FROM bill_versions WHERE bill_key = ${key}`)).rows as { version_code: string }[]).map((r) => r.version_code);
  const currentCode = allCodes.sort((a, c) => versionSeq(a) - versionSeq(c)).pop();
  for (const v of pending) {
    try {
      const res = await fetcher.fetch(v.source_url_xml);
      let doc: BillDocument | null = null;
      let parser = 'wa-bill-xml';
      let sourceHash = res.sha256;
      let fetchedAt = res.fetchedAt;
      let sourceUrl = v.source_url_xml;
      if (res.status === 200 && res.body) {
        doc = parseBillXml(res.body, { biennium, type, number, versionCode: v.version_code, sourceUrl: v.source_url_xml, sourceHash: res.sha256, fetchedAt: res.fetchedAt, isCurrent: v.version_code === currentCode });
      } else {
        const htm = await fetcher.fetch(v.source_url_htm);
        if (htm.status === 200 && htm.body) {
          doc = parseBillHtm(htm.body, { biennium, type, number, versionCode: v.version_code, sourceUrl: v.source_url_htm, sourceHash: htm.sha256, fetchedAt: htm.fetchedAt, isCurrent: v.version_code === currentCode });
          parser = 'wa-bill-htm';
          sourceHash = htm.sha256;
          fetchedAt = htm.fetchedAt;
          sourceUrl = v.source_url_htm;
        }
      }
      if (!doc) {
        await db.execute(sql`UPDATE bill_versions SET status = 'missing', error = 'XML and HTM not found', updated_at = now()
            WHERE bill_key = ${key} AND version_code = ${v.version_code}`);
        stats.versionsMissing += 1;
        continue;
      }
      doc.version.sourceUrls = { ...doc.version.sourceUrls, pdf: v.source_url_pdf, htm: v.source_url_htm, xml: v.source_url_xml };
      const label = doc.version.label;
      const engrossed = engrossedLevel(doc.header.longBillId);
      const short = shortLabel({ type, number, versionCode: v.version_code }, engrossed);
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE bill_versions SET document = ${JSON.stringify(doc)}::jsonb, label = ${label}, short_label = ${short},
            source_hash = ${sourceHash ?? null}, fetched_at = ${fetchedAt}::timestamptz, parser = ${parser}, parser_version = ${PARSER_VERSION},
            status = 'parsed', error = NULL, updated_at = now()
          WHERE bill_key = ${key} AND version_code = ${v.version_code}`);
        await emitEvent(tx, 'bill.version_added', { billKey: key, versionCode: v.version_code, label: short, sourceHash: sourceHash ?? null, sourceUrl });
      });
      stats.versionsParsed += 1;
    } catch (err) {
      stats.versionsErrored += 1;
      stats.errors.push(`${key}/${v.version_code}: ${(err as Error).message}`);
      await db.execute(sql`UPDATE bill_versions SET status = 'error', error = ${String((err as Error).message).slice(0, 500)}, updated_at = now()
          WHERE bill_key = ${key} AND version_code = ${v.version_code}`);
    }
  }

  const pendingAmd = (await db.execute(sql`SELECT amendment_id, base_version_code, adopted, source_url_xml FROM amendments
      WHERE bill_key = ${key} AND status IN ('pending', 'error')`)).rows as { amendment_id: string; base_version_code: string; adopted: boolean; source_url_xml: string }[];
  for (const a of pendingAmd) {
    try {
      const res = await fetcher.fetch(a.source_url_xml);
      if (res.status !== 200 || !res.body) {
        await db.execute(sql`UPDATE amendments SET status = 'missing', error = 'XML not found', updated_at = now() WHERE amendment_id = ${a.amendment_id}`);
        stats.amendmentsMissing += 1;
        continue;
      }
      const doc: AmendmentDocument = parseAmendmentXml(res.body, {
        biennium,
        billId: `${type}${number}`,
        amendmentId: a.amendment_id,
        baseVersion: a.base_version_code,
        sourceUrl: a.source_url_xml,
        sourceHash: res.sha256,
        fetchedAt: res.fetchedAt,
        adopted: a.adopted,
      });
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE amendments SET document = ${JSON.stringify(doc)}::jsonb, kind = ${doc.kind}, scope = ${doc.scope ?? null},
            chamber = COALESCE(${doc.chamber ?? null}, chamber), floor_action = ${doc.status ?? null}, action_date = COALESCE(${doc.actionDate ?? null}, action_date),
            sponsor = COALESCE(${doc.sponsor ?? doc.committee ?? null}, sponsor), adopted = adopted OR ${doc.status === 'adopted'},
            source_hash = ${res.sha256 ?? null}, fetched_at = ${res.fetchedAt}::timestamptz,
            status = 'parsed', error = NULL, updated_at = now()
          WHERE amendment_id = ${a.amendment_id}`);
        await emitEvent(tx, 'bill.amendment_added', { billKey: key, amendmentId: a.amendment_id, baseVersionCode: a.base_version_code, kind: doc.kind });
      });
      stats.amendmentsParsed += 1;
    } catch (err) {
      stats.errors.push(`${a.amendment_id}: ${(err as Error).message}`);
      await db.execute(sql`UPDATE amendments SET status = 'error', error = ${String((err as Error).message).slice(0, 500)}, updated_at = now() WHERE amendment_id = ${a.amendment_id}`);
    }
  }
  void b;
}

export function engrossedLevel(longBillId: string | undefined): number | undefined {
  if (!longBillId) return undefined;
  const m = /^(?:(SECOND|THIRD|FOURTH)\s+)?ENGROSSED\b/i.exec(longBillId);
  if (!m) return 0;
  return m[1] ? { SECOND: 2, THIRD: 3, FOURTH: 4 }[m[1].toUpperCase()]! : 1;
}

/** Re-check every parsed document against the source with a conditional GET; reparse when it changed. */
export async function refreshDocuments(deps: LoaderDeps, opts: { billKeys?: string[]; onProgress?: (m: string) => void } = {}): Promise<IngestStats> {
  const { db } = deps;
  const stats: IngestStats = { billsSeen: 0, billsUpserted: 0, billsUnchanged: 0, versionsParsed: 0, versionsMissing: 0, versionsErrored: 0, amendmentsParsed: 0, amendmentsMissing: 0, hearings: 0, priorFiscalNotes: 0, errors: [] };
  const cond = opts.billKeys?.length ? sql`WHERE bill_key = ANY(${pgArray(opts.billKeys)}::text[])` : sql``;
  const rows = (await db.execute(sql`SELECT bill_key, biennium, type, number FROM bills ${cond} ORDER BY bill_key`)).rows as { bill_key: string; biennium: string; type: BillType; number: number }[];
  for (const r of rows) {
    stats.billsSeen += 1;
    const versions = (await db.execute(sql`SELECT version_code, source_url_xml, source_hash, status FROM bill_versions WHERE bill_key = ${r.bill_key}`)).rows as { version_code: string; source_url_xml: string; source_hash: string | null; status: string }[];
    let changed = false;
    for (const v of versions) {
      if (v.status === 'missing') {
        await db.execute(sql`UPDATE bill_versions SET status = 'pending' WHERE bill_key = ${r.bill_key} AND version_code = ${v.version_code}`);
        changed = true;
        continue;
      }
      const res = await deps.fetcher.fetch(v.source_url_xml);
      if (res.status === 200 && res.sha256 && res.sha256 !== v.source_hash) {
        await db.execute(sql`UPDATE bill_versions SET status = 'pending' WHERE bill_key = ${r.bill_key} AND version_code = ${v.version_code}`);
        changed = true;
      }
    }
    if (changed) {
      await fetchPendingVersions(deps, r.bill_key, r.biennium, r.type, r.number, stats);
      stats.billsUpserted += 1;
    } else stats.billsUnchanged += 1;
    opts.onProgress?.(`${r.bill_key} ${changed ? 'refreshed' : 'unchanged'}`);
  }
  return stats;
}

function pgArray(values: string[]): string {
  return '{' + values.map((v) => '"' + v.replace(/"/g, '\\"') + '"').join(',') + '}';
}

export async function recordIngestRun(db: DbOrTx, run: { id: string; source: string; path?: string; requestedBy?: string }): Promise<void> {
  await db.execute(sql`INSERT INTO ingest_runs (id, source, path, requested_by) VALUES (${run.id}, ${run.source}, ${run.path ?? null}, ${run.requestedBy ?? null})`);
}

export async function finishIngestRun(db: DbOrTx, id: string, status: 'done' | 'failed', stats: unknown, error?: string): Promise<void> {
  await db.execute(sql`UPDATE ingest_runs SET finished_at = now(), status = ${status}, stats = ${JSON.stringify(stats)}::jsonb, error = ${error ?? null} WHERE id = ${id}`);
}
