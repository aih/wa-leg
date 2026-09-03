import { sql } from 'drizzle-orm';
import { label as shortLabelOf, parse as parseRef, parseBillId, versionSeq, type BillType, type ParseOptions } from '@wa-leg/billref';
import { diffVersions, type AmendmentDocument, type BillDocument, type DiffMode, type VersionDiff } from '@wa-leg/bill-document';
import type { Db } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';

export interface VersionRow {
  code: string;
  label: string;
  shortLabel: string;
  seq: number;
  status: string;
  date?: string;
  amendmentIds: string[];
  sourceUrls: { xml?: string; pdf?: string; htm?: string };
}

export interface HearingRow {
  id: string;
  billKey: string;
  versionCode?: string;
  committee: string;
  chamber?: string;
  kind: string;
  hearingAt: string;
  location?: string;
  description?: string;
  cancelled: boolean;
  hasNote?: boolean;
}

export interface BillSummary {
  billKey: string;
  biennium: string;
  id: string;
  type: string;
  number: number;
  chamber: string;
  title: string;
  description?: string;
  status?: string;
  statusDate?: string;
  sponsors: unknown[];
  committee?: unknown;
  currentVersionCode: string;
  versions: VersionRow[];
  hearings: HearingRow[];
  priorFiscalNotes: { id: string; packageId?: number; label: string; versionLabel?: string; kind?: string; url: string; publishedAt?: string }[];
  companion?: { billKey: string; id: string; title?: string } | null;
  rcwAffected: unknown[];
  history: unknown[];
  updatedAt: string;
}

function iso(v: unknown): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

export class BillsService {
  constructor(private readonly db: Db) {}

  billKey(biennium: string, id: string): string {
    const p = parseBillId(id);
    if (!p) throw badRequest('bad_bill_id', `Unrecognised bill id ${id}`);
    return `WA:${biennium}:${p.type}${p.number}`;
  }

  async getBill(biennium: string, id: string): Promise<BillSummary> {
    const key = this.billKey(biennium, id);
    const bill = (await this.db.execute(sql`SELECT * FROM bills WHERE bill_key = ${key}`)).rows[0] as any;
    if (!bill) throw notFound(`Bill ${id} (${biennium})`);
    const versions = await this.listVersions(key);
    const hearings = await this.listHearings(key);
    const priors = (await this.db.execute(sql`SELECT * FROM prior_fiscal_notes WHERE bill_key = ${key} ORDER BY published_at NULLS LAST, id`)).rows as any[];
    const current = versions.find((v) => v.code === bill.current_version_code) ?? versions[versions.length - 1];
    let rcwAffected: unknown[] = [];
    if (current) {
      const doc = (await this.db.execute(sql`SELECT document->'rcwAffected' AS rcw FROM bill_versions WHERE bill_key = ${key} AND version_code = ${current.code}`)).rows[0] as any;
      rcwAffected = doc?.rcw ?? [];
    }
    let companion: BillSummary['companion'] = null;
    const sasts = (bill.sasts ?? []) as { type: string; sast_bill_number: string }[];
    const cross = sasts.find((s) => s.type === 'Crossfiled');
    if (cross) {
      const cp = parseBillId(cross.sast_bill_number);
      if (cp) {
        const ck = `WA:${biennium}:${cp.type}${cp.number}`;
        const crow = (await this.db.execute(sql`SELECT title FROM bills WHERE bill_key = ${ck}`)).rows[0] as any;
        companion = { billKey: ck, id: `${cp.type}${cp.number}`, title: crow?.title };
      }
    }
    return {
      billKey: key,
      biennium: bill.biennium,
      id: bill.id,
      type: bill.type,
      number: bill.number,
      chamber: bill.chamber,
      title: bill.title,
      description: bill.description ?? undefined,
      status: bill.status ?? undefined,
      statusDate: iso(bill.status_date)?.slice(0, 10),
      sponsors: bill.sponsors ?? [],
      committee: bill.committee ?? undefined,
      currentVersionCode: bill.current_version_code ?? current?.code ?? 'I',
      versions,
      hearings,
      priorFiscalNotes: priors.map((p) => ({
        id: p.id,
        packageId: p.package_id ?? undefined,
        label: p.label,
        versionLabel: p.version_label ?? undefined,
        kind: p.kind ?? undefined,
        url: p.url,
        publishedAt: iso(p.published_at)?.slice(0, 10),
      })),
      companion,
      rcwAffected,
      history: bill.history ?? [],
      updatedAt: iso(bill.updated_at)!,
    };
  }

  async listBills(opts: { biennium?: string; page: number; size: number; q?: string }): Promise<{ billKey: string; id: string; biennium: string; title: string; status: string | null; currentVersionCode: string | null; updatedAt: string }[]> {
    const conds = [sql`true`];
    if (opts.biennium) conds.push(sql`biennium = ${opts.biennium}`);
    if (opts.q) conds.push(sql`(id ILIKE ${'%' + opts.q + '%'} OR title ILIKE ${'%' + opts.q + '%'})`);
    const rows = (await this.db.execute(sql`SELECT bill_key, id, biennium, title, status, current_version_code, updated_at FROM bills
        WHERE ${sql.join(conds, sql` AND `)} ORDER BY biennium, number LIMIT ${opts.size} OFFSET ${(opts.page - 1) * opts.size}`)).rows as any[];
    return rows.map((r) => ({ billKey: r.bill_key, id: r.id, biennium: r.biennium, title: r.title, status: r.status ?? null, currentVersionCode: r.current_version_code ?? null, updatedAt: iso(r.updated_at)! }));
  }

  async listVersions(key: string): Promise<VersionRow[]> {
    const rows = (await this.db.execute(sql`SELECT v.version_code, v.label, v.short_label, v.seq, v.status, v.source_url_xml, v.source_url_pdf, v.source_url_htm,
        v.document->'header'->>'readFirstTime' AS read_first_time,
        (SELECT coalesce(json_agg(a.amendment_id ORDER BY a.action_date, a.amendment_id), '[]'::json) FROM amendments a WHERE a.bill_key = v.bill_key AND a.base_version_code = v.version_code) AS amendment_ids
      FROM bill_versions v WHERE v.bill_key = ${key} ORDER BY v.seq`)).rows as any[];
    return rows.map((r) => ({
      code: r.version_code,
      label: r.label,
      shortLabel: r.short_label,
      seq: r.seq,
      status: r.status,
      date: r.read_first_time ?? undefined,
      amendmentIds: r.amendment_ids ?? [],
      sourceUrls: { xml: r.source_url_xml ?? undefined, pdf: r.source_url_pdf ?? undefined, htm: r.source_url_htm ?? undefined },
    }));
  }

  async resolveCode(key: string, code: string): Promise<string> {
    if (code !== 'current') return code;
    const row = (await this.db.execute(sql`SELECT current_version_code FROM bills WHERE bill_key = ${key}`)).rows[0] as any;
    if (!row) throw notFound('Bill');
    if (row.current_version_code) return row.current_version_code;
    const versions = await this.listVersions(key);
    return versions[versions.length - 1]?.code ?? 'I';
  }

  async getVersion(biennium: string, id: string, code: string): Promise<{ document: BillDocument; resolvedCode: string; explicit: boolean }> {
    const key = this.billKey(biennium, id);
    const resolved = await this.resolveCode(key, code);
    const row = (await this.db.execute(sql`SELECT document, status, error FROM bill_versions WHERE bill_key = ${key} AND version_code = ${resolved}`)).rows[0] as any;
    if (!row) throw notFound(`Version ${resolved} of ${id}`);
    if (!row.document) throw notFound(`Text of version ${resolved} of ${id} (${row.status}${row.error ? ': ' + row.error : ''})`);
    const doc = row.document as BillDocument;
    const versions = await this.listVersions(key);
    doc.versions = versions.map((v) => ({ code: v.code, label: v.shortLabel, seq: v.seq, date: v.date, amendmentIds: v.amendmentIds }));
    const current = await this.resolveCode(key, 'current');
    doc.version.isCurrent = resolved === current;
    return { document: doc, resolvedCode: resolved, explicit: code !== 'current' };
  }

  async getSection(biennium: string, id: string, code: string, sectionId: string) {
    const { document } = await this.getVersion(biennium, id, code);
    const s = document.sections.find((x) => x.id === sectionId);
    if (!s) throw notFound(`Section ${sectionId}`);
    return s;
  }

  async getAmendment(biennium: string, id: string, amendmentId: string): Promise<AmendmentDocument> {
    const key = this.billKey(biennium, id);
    const name = amendmentId.replace(/_/g, ' ');
    const row = (await this.db.execute(sql`SELECT document, status, error FROM amendments WHERE bill_key = ${key} AND amendment_id = ${name}`)).rows[0] as any;
    if (!row) throw notFound(`Amendment ${name}`);
    if (!row.document) throw notFound(`Text of amendment ${name} (${row.status})`);
    return row.document as AmendmentDocument;
  }

  async listAmendments(biennium: string, id: string) {
    const key = this.billKey(biennium, id);
    const rows = (await this.db.execute(sql`SELECT amendment_id, base_version_code, chamber, sponsor, kind, scope, adopted, floor_action, action_date, status,
        source_url_pdf, document->>'effect' AS effect, document->>'drafterCode' AS drafter_code, document->>'floorNumber' AS floor_number
      FROM amendments WHERE bill_key = ${key} ORDER BY action_date NULLS LAST, amendment_id`)).rows as any[];
    return rows.map((r) => ({
      amendmentId: r.amendment_id,
      kind: r.kind ?? 'unknown',
      scope: r.scope ?? undefined,
      chamber: r.chamber ?? undefined,
      sponsor: r.sponsor ?? undefined,
      baseVersionCode: r.base_version_code,
      adopted: r.adopted,
      floorAction: r.floor_action ?? undefined,
      date: iso(r.action_date)?.slice(0, 10),
      status: r.status,
      effect: r.effect ?? undefined,
      drafterCode: r.drafter_code ?? undefined,
      floorNumber: r.floor_number ?? undefined,
      pdfUrl: r.source_url_pdf ?? undefined,
    }));
  }

  /** Upcoming hearings across bills inside a window, with bill facts, for the reviewer dashboard. */
  async listUpcomingHearings(opts: { from?: string; to?: string; biennium?: string; limit?: number } = {}): Promise<(HearingRow & { biennium: string; billId: string; title: string })[]> {
    const from = opts.from ?? new Date().toISOString();
    const to = opts.to ?? new Date(Date.now() + 72 * 3_600_000).toISOString();
    const rows = (await this.db.execute(sql`SELECT h.*, b.current_version_code, b.biennium, b.id AS bill_id, b.title FROM hearings h JOIN bills b ON b.bill_key = h.bill_key
      WHERE NOT h.cancelled AND h.hearing_at >= ${from}::timestamptz AND h.hearing_at <= ${to}::timestamptz AND (${opts.biennium ?? null}::text IS NULL OR b.biennium = ${opts.biennium ?? null})
      ORDER BY h.hearing_at LIMIT ${Math.min(opts.limit ?? 500, 2000)}`)).rows as any[];
    return rows.map((r) => ({
      id: r.id,
      billKey: r.bill_key,
      biennium: r.biennium,
      billId: r.bill_id,
      title: r.title,
      versionCode: r.current_version_code ?? undefined,
      committee: r.committee,
      chamber: r.chamber ?? undefined,
      kind: r.kind,
      hearingAt: iso(r.hearing_at)!,
      location: r.location ?? undefined,
      description: r.description ?? undefined,
      cancelled: r.cancelled,
    }));
  }

  async listHearings(key: string): Promise<HearingRow[]> {
    const rows = (await this.db.execute(sql`SELECT h.*, b.current_version_code FROM hearings h JOIN bills b ON b.bill_key = h.bill_key WHERE h.bill_key = ${key} ORDER BY h.hearing_at`)).rows as any[];
    return rows.map((r) => ({
      id: r.id,
      billKey: r.bill_key,
      versionCode: r.current_version_code ?? undefined,
      committee: r.committee,
      chamber: r.chamber ?? undefined,
      kind: r.kind,
      hearingAt: iso(r.hearing_at)!,
      location: r.location ?? undefined,
      description: r.description ?? undefined,
      cancelled: r.cancelled,
    }));
  }

  async diff(biennium: string, id: string, from: string, to: string, mode: DiffMode): Promise<VersionDiff> {
    const key = this.billKey(biennium, id);
    const fromDoc = (await this.getVersion(biennium, id, from)).document;
    if (to.startsWith('amend:')) {
      const amd = await this.getAmendment(biennium, id, to.slice('amend:'.length));
      if (amd.kind !== 'striking' || !amd.body) throw badRequest('not_striking', 'Only striking amendments can be compared as a version');
      const toDoc: BillDocument = { ...fromDoc, version: { ...fromDoc.version, code: amd.id, label: amd.id, seq: fromDoc.version.seq }, sections: amd.body.sections };
      return diffVersions(fromDoc, toDoc, mode, `amend:${amd.id}`);
    }
    const toDoc = (await this.getVersion(biennium, id, to)).document;
    void key;
    return diffVersions(fromDoc, toDoc, mode);
  }

  /** Parse a reference and resolve it against the database. */
  async resolve(ref: string, opts: ParseOptions) {
    const r = parseRef(ref, opts);
    if (!r.ref) throw badRequest('unparsed', `Could not parse "${ref}" as a reference`, { normalized: r.normalized });
    const base = { input: ref, parsed: r.ref, remainder: r.remainder, ambiguous: false, candidates: [] as unknown[] };
    const parsed = r.ref;
    if (parsed.kind === 'bill') {
      const key = `WA:${parsed.biennium}:${parsed.type}${parsed.number}`;
      const bill = (await this.db.execute(sql`SELECT bill_key, id, type, number, title, current_version_code FROM bills WHERE bill_key = ${key}`)).rows[0] as any;
      if (!bill) {
        // Offer the inferred type when the written type does not match the number range.
        const alt = parseRef(String(parsed.number), opts).ref;
        if (alt && alt.kind === 'bill' && alt.type !== parsed.type) {
          const altKey = `WA:${alt.biennium}:${alt.type}${alt.number}`;
          const altBill = (await this.db.execute(sql`SELECT bill_key, id, title FROM bills WHERE bill_key = ${altKey}`)).rows[0] as any;
          if (altBill) return { ...base, resolved: null, ambiguous: true, candidates: [{ bill_key: altKey, id: altBill.id, title: altBill.title, url: `/bills/${alt.biennium}/${altBill.id}` }], notFound: true };
        }
        return { ...base, resolved: null, notFound: true };
      }
      const versions = await this.listVersions(key);
      let code = parsed.versionExplicit ? parsed.versionCode : (bill.current_version_code ?? versions[versions.length - 1]?.code ?? 'I');
      let v = versions.find((x) => x.code === code);
      if (!v && parsed.versionExplicit) {
        // Ask for a later stage of the same lineage (SHB → S.E) when the exact code is missing.
        v = versions.filter((x) => x.code.startsWith(parsed.versionCode)).sort((a, b) => a.seq - b.seq)[0];
        code = v?.code ?? code;
      }
      const url = `/bills/${parsed.biennium}/${bill.id}/${code}` + (parsed.amendment?.drafterNumber ? `?amendment=${encodeURIComponent(parsed.amendment.drafterNumber)}` : '');
      let amendmentId: string | undefined;
      if (parsed.amendment?.drafterNumber) {
        const a = (await this.db.execute(sql`SELECT amendment_id FROM amendments WHERE bill_key = ${key} AND amendment_id LIKE ${'%' + parsed.amendment.drafterNumber}`)).rows[0] as any;
        amendmentId = a?.amendment_id;
      }
      return {
        ...base,
        resolved: { bill_key: key, id: bill.id, title: bill.title, version_code: code, version_label: v?.shortLabel ?? shortLabelOf({ type: bill.type as BillType, number: bill.number, versionCode: code }), version_found: !!v, url, amendmentId },
      };
    }
    if (parsed.kind === 'amendment' && parsed.drafterNumber) {
      const rows = (await this.db.execute(sql`SELECT a.amendment_id, a.bill_key, a.base_version_code, b.id, b.biennium FROM amendments a JOIN bills b ON b.bill_key = a.bill_key
          WHERE a.amendment_id LIKE ${'%' + parsed.drafterNumber} ORDER BY a.amendment_id`)).rows as any[];
      if (rows.length === 1) {
        const a = rows[0];
        return { ...base, resolved: { bill_key: a.bill_key, id: a.id, version_code: a.base_version_code, amendmentId: a.amendment_id, url: `/bills/${a.biennium}/${a.id}/${a.base_version_code}?amendment=${encodeURIComponent(a.amendment_id)}` } };
      }
      return { ...base, resolved: null, ambiguous: rows.length > 1, candidates: rows.map((a) => ({ bill_key: a.bill_key, amendmentId: a.amendment_id, url: `/bills/${a.biennium}/${a.id}/${a.base_version_code}` })), notFound: rows.length === 0 };
    }
    return { ...base, resolved: null, external: externalUrl(parsed as unknown as { kind: string } & Record<string, unknown>) };
  }

  /** Short label for a version, using the engrossed level recorded by the parser for PL/SL. */
  async shortLabel(key: string, code: string): Promise<string> {
    const row = (await this.db.execute(sql`SELECT short_label FROM bill_versions WHERE bill_key = ${key} AND version_code = ${code}`)).rows[0] as any;
    if (row) return row.short_label;
    const b = (await this.db.execute(sql`SELECT type, number FROM bills WHERE bill_key = ${key}`)).rows[0] as any;
    return b ? shortLabelOf({ type: b.type, number: b.number, versionCode: code }) : `${key} ${code}`;
  }
}

function externalUrl(ref: { kind: string } & Record<string, unknown>): string | null {
  switch (ref.kind) {
    case 'rcw':
      return `https://app.leg.wa.gov/RCW/default.aspx?cite=${ref.cite}`;
    case 'fiscal_note_package':
      return `https://fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=${ref.packageId}`;
    case 'session_law':
      return `https://app.leg.wa.gov/billsummary?Chapter=${ref.chapter}&Year=${ref.year}`;
    case 'initiative':
      return 'https://app.leg.wa.gov/billinfo/initiatives.aspx';
    default:
      return null;
  }
}

export { versionSeq };
