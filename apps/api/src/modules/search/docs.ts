// Builds search documents from the bills module's API responses (search.md sections 3.4-3.8).
import { label as shortLabelOf, parse as parseRef } from '@wa-leg/billref';
import type { AmendmentDocument, BillDocument, BillSection } from '@wa-leg/bill-document';
import { sectionText } from '@wa-leg/bill-document';
import type { SearchDoc } from './backend.js';

export interface BillSummaryLike {
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
  sponsors: any[];
  committee?: any;
  currentVersionCode: string;
  versions: { code: string; shortLabel: string; label: string; seq: number; status: string; date?: string; amendmentIds: string[] }[];
  hearings: { hearingAt: string; cancelled: boolean }[];
  priorFiscalNotes: { id: string; packageId?: number; label: string; versionLabel?: string; kind?: string; url: string; publishedAt?: string }[];
  companion?: { billKey: string; id: string } | null;
  rcwAffected: { cite: string; chapter?: string; action: string; sectionIds: string[] }[];
  history: { date: string; action: string }[];
  updatedAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  introduced: 'in_committee',
  engrossed: 'passed_origin',
  enrolled: 'passed_legislature',
  passed: 'passed',
  vetoed: 'vetoed',
  failed: 'failed',
  unknown: 'prefiled',
};

export function billNumberForms(type: string, number: number, versions: { shortLabel: string }[]): string[] {
  const forms = new Set<string>([`${type}${number}`, `${type} ${number}`, String(number)]);
  for (const v of versions) {
    forms.add(v.shortLabel);
    forms.add(v.shortLabel.replace(/\s+/g, ''));
  }
  return [...forms];
}

function chapterOf(history: { action: string }[]): { year: number; number: number; pv: boolean } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = /^Chapter (\d+), (\d{4}) Laws( PV)?\.?$/.exec(history[i]!.action);
    if (m) return { number: Number(m[1]), year: Number(m[2]), pv: !!m[3] };
  }
  return null;
}

export function rcwPartsOf(rcwAffected: BillSummaryLike['rcwAffected']): { cites: string[]; chapters: string[]; titles: string[] } {
  const cites = new Set<string>();
  const chapters = new Set<string>();
  const titles = new Set<string>();
  for (const r of rcwAffected) {
    const parts = r.cite.split('.');
    if (parts.length === 3) {
      cites.add(r.cite);
      chapters.add(parts.slice(0, 2).join('.'));
      titles.add(parts[0]!);
    } else if (parts.length === 2) {
      chapters.add(r.cite);
      titles.add(parts[0]!);
    } else titles.add(r.cite);
  }
  return { cites: [...cites], chapters: [...chapters], titles: [...titles] };
}

export function buildBillDoc(b: BillSummaryLike): SearchDoc {
  const now = new Date();
  const upcoming = b.hearings.filter((h) => !h.cancelled && new Date(h.hearingAt) > now).map((h) => h.hearingAt).sort();
  const last = b.history[b.history.length - 1];
  const { cites, chapters, titles } = rcwPartsOf(b.rcwAffected);
  const latest = b.versions[b.versions.length - 1];
  const sponsors = (b.sponsors as any[]).map((s) => ({
    people_id: String(s.people_id ?? ''),
    name: String(s.name ?? ''),
    last_name: String(s.last_name ?? ''),
    party: String(s.party ?? ''),
    district: String(s.district ?? ''),
    primary: s.sponsor_type_id === 1 || s.sponsor_order === 1,
  }));
  const status = STATUS_LABEL[b.status ?? 'unknown'] ?? b.status ?? 'unknown';
  const titleWords = b.title.replace(/^Concerning\s+/i, '').split(/\s+/).slice(0, 6).join(' ');
  const chapter = chapterOf(b.history);
  const doc: SearchDoc = {
    id: b.billKey,
    doc_type: 'bill',
    bill_key: b.billKey,
    biennium: b.biennium,
    chamber: b.chamber,
    type: b.type,
    number: b.number,
    bill_number: b.id,
    bill_number_forms: billNumberForms(b.type, b.number, b.versions),
    display: `${b.type} ${b.number}`,
    title: b.title,
    description: b.description ?? b.title,
    status,
    status_code: null,
    committee: b.committee ? { id: String(b.committee.committee_id ?? ''), name: b.committee.name, chamber: b.committee.chamber } : null,
    sponsors,
    sponsor_names: sponsors.map((s) => s.name).join(' '),
    companion_bill_key: b.companion?.billKey ?? null,
    version_codes: b.versions.map((v) => v.code),
    latest_version_code: latest?.code ?? 'I',
    version_label: latest?.shortLabel ?? `${b.type} ${b.number}`,
    has_fiscal_note: b.priorFiscalNotes.length > 0,
    fiscal_note_count: b.priorFiscalNotes.length,
    fiscal_note_status: b.priorFiscalNotes.length ? 'published' : null,
    fiscal_note_package_ids: b.priorFiscalNotes.map((p) => String(p.packageId ?? p.id)),
    rcw_cites: cites,
    rcw_chapters: chapters,
    rcw_titles: titles,
    history_text: b.history.map((h) => h.action).join(' '),
    last_action: last?.action ?? null,
    last_action_date: last?.date ?? b.statusDate ?? null,
    next_hearing_date: upcoming[0] ?? null,
    hearing_count: b.hearings.length,
    url: `/bills/${b.biennium}/${b.id}/${latest?.code ?? 'I'}`,
    visibility: 'public',
    allowed_roles: [],
    allowed_user_ids: [],
    suggest: {
      input: [...billNumberForms(b.type, b.number, b.versions), titleWords].filter(Boolean),
      weight: chapter ? 30 : status === 'passed' ? 25 : status === 'passed_legislature' ? 20 : status === 'passed_origin' ? 15 : 10,
    },
    updated_at: b.updatedAt,
    source_hash: null,
  };
  return doc;
}

function sectionAction(s: BillSection): string {
  switch (s.sourceKind) {
    case 'amend':
      return 'amend';
    case 'remd':
      return 'reenact';
    case 'amenduncod':
      return 'uncodified';
    case 'repeal':
      return 'repeal';
    default:
      return 'new';
  }
}

function markedText(s: BillSection, mark: 'ins' | 'del'): string {
  const out: string[] = [];
  const walk = (blocks: BillSection['blocks']) => {
    for (const b of blocks) {
      for (const r of b.runs) if (r.t === mark || (r.t === 'cite' && r.mark === mark)) out.push(r.text);
      if (b.table) for (const row of b.table.rows) for (const c of row) for (const r of c.runs) if (r.t === mark) out.push(r.text);
      walk(b.children);
    }
  };
  walk(s.blocks);
  return out.join(' ').replace(/\(\(|\)\)/g, '').replace(/\s+/g, ' ').trim();
}

/** Section text as it reads after the amendment: struck runs removed, inserted kept. */
function effectiveText(s: BillSection): string {
  const out: string[] = [];
  const walk = (blocks: BillSection['blocks']) => {
    for (const b of blocks) {
      const parts: string[] = [];
      if (b.label && b.labelMark !== 'del') parts.push(b.label);
      for (const r of b.runs) if (r.t !== 'del' && !(r.t === 'cite' && r.mark === 'del')) parts.push(r.text);
      if (b.table) for (const row of b.table.rows) parts.push(row.map((c) => c.runs.filter((r) => r.t !== 'del').map((r) => r.text).join('')).join(' | '));
      out.push(parts.join(' '));
      walk(b.children);
    }
  };
  walk(s.blocks);
  return out.join('\n').replace(/[ \t]+/g, ' ').trim();
}

export function buildSectionDocs(b: BillSummaryLike, doc: BillDocument, versionShortLabel: string, isLatest: boolean): SearchDoc[] {
  const { cites, chapters, titles } = rcwPartsOf(b.rcwAffected);
  void cites;
  void chapters;
  void titles;
  const status = STATUS_LABEL[b.status ?? 'unknown'] ?? b.status ?? 'unknown';
  return doc.sections.map((s, i) => {
    const intro = s.introText ? s.introText.map((r) => r.text).join('') : '';
    const heading = `${s.label} ${intro}`.replace(/\s+/g, ' ').trim();
    const t = s.target;
    const rcwCite = t?.cite ?? null;
    const rcwChapter = t?.chapter ?? (t?.cite ? t.cite.split('.').slice(0, 2).join('.') : null);
    const rcwTitle = t?.title ?? (rcwChapter ? rcwChapter.split('.')[0]! : null);
    const sd: SearchDoc = {
      id: `${b.billKey}:${doc.version.code}:${s.id}`,
      doc_type: 'section',
      bill_key: b.billKey,
      biennium: b.biennium,
      chamber: b.chamber,
      type: b.type,
      bill_number: b.id,
      display: versionShortLabel,
      title: b.title,
      version_code: doc.version.code,
      version_label: versionShortLabel,
      is_latest_version: isLatest,
      section_id: s.id,
      section_no: s.num,
      ordinal: i + 1,
      heading,
      action: sectionAction(s),
      rcw_cite: rcwCite,
      rcw_chapter: rcwChapter,
      rcw_title: rcwTitle,
      rcw_cites: rcwCite ? [rcwCite] : (t?.repealed?.map((r) => r.cite) ?? []),
      rcw_chapters: rcwChapter ? [rcwChapter] : [],
      rcw_titles: rcwTitle ? [rcwTitle] : [],
      text: effectiveText(s),
      added_text: markedText(s, 'ins') || null,
      struck_text: markedText(s, 'del') || null,
      body: sectionText(s),
      status,
      committee: b.committee ? { name: b.committee.name } : null,
      has_fiscal_note: b.priorFiscalNotes.length > 0,
      fiscal_note_status: b.priorFiscalNotes.length ? 'published' : null,
      url: `/bills/${b.biennium}/${b.id}/${doc.version.code}#${s.id}`,
      visibility: 'public',
      allowed_roles: [],
      allowed_user_ids: [],
      updated_at: doc.provenance.fetchedAt,
      source_hash: doc.version.sourceHash ?? null,
    };
    return sd;
  });
}

export function buildAmendmentDoc(b: BillSummaryLike, a: { amendmentId: string; kind: string; scope?: string; chamber?: string; sponsor?: string; baseVersionCode: string; adopted: boolean; floorAction?: string; date?: string; status: string; effect?: string; drafterCode?: string; floorNumber?: string; pdfUrl?: string }, doc: AmendmentDocument | null): SearchDoc {
  const base = b.versions.find((v) => v.code === a.baseVersionCode);
  const text = doc
    ? [
        ...(doc.instructions ?? []).map((i) => i.text),
        ...(doc.body?.sections ?? []).map((s) => sectionText(s)),
        ...(doc.instructions ?? []).flatMap((i) => (i.insertSections ?? []).map((s) => sectionText(s))),
        doc.effect ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const cites = new Set<string>();
  for (const s of [...(doc?.body?.sections ?? []), ...(doc?.instructions ?? []).flatMap((i) => i.insertSections ?? [])]) if (s.target?.cite) cites.add(s.target.cite);
  const drafter = /([HS]\d{4}\.(?:\d+|E))$/.exec(a.amendmentId)?.[1] ?? a.drafterCode ?? null;
  return {
    id: `${b.billKey}:AMD:${a.amendmentId}`,
    doc_type: 'amendment',
    amendment_id: a.amendmentId,
    bill_key: b.billKey,
    biennium: b.biennium,
    chamber: b.chamber,
    type: b.type,
    bill_number: b.id,
    display: `${b.type} ${b.number}`,
    title: b.title,
    target_version_code: a.baseVersionCode,
    version_code: a.baseVersionCode,
    version_label: base?.shortLabel ?? null,
    amending_chamber: a.chamber ?? null,
    kind: a.scope ?? (a.kind === 'striking' ? 'floor' : null),
    sponsor: a.sponsor ?? null,
    drafter_number: drafter,
    amd_number: a.floorNumber ? Number(a.floorNumber) : null,
    disposition: a.floorAction ?? (a.adopted ? 'adopted' : 'unknown'),
    disposition_date: a.date ?? null,
    description: `${a.sponsor ?? ''} ${a.amendmentId}`.trim(),
    text,
    body: text,
    heading: `${a.amendmentId} (${a.kind}${a.adopted ? ', adopted' : ''})`,
    rcw_cites: [...cites],
    rcw_chapters: [...new Set([...cites].map((c) => c.split('.').slice(0, 2).join('.')))],
    status: STATUS_LABEL[b.status ?? 'unknown'] ?? b.status ?? 'unknown',
    url: `/bills/${b.biennium}/${b.id}/${a.baseVersionCode}?amendment=${encodeURIComponent(a.amendmentId)}`,
    visibility: 'public',
    allowed_roles: [],
    allowed_user_ids: [],
    updated_at: b.updatedAt,
    source_hash: null,
  };
}

export function buildOfmNoteDocs(b: BillSummaryLike): SearchDoc[] {
  return b.priorFiscalNotes.map((p) => {
    const parsed = parseRef(p.label.replace(/\((Final|Partial|Revised)\)\s*$/i, ''), { currentBiennium: b.biennium });
    const versionLabel = parsed.ref?.kind === 'bill' ? shortLabelOf(parsed.ref) : p.versionLabel ?? null;
    return {
      id: `fn:ofm:${p.packageId ?? p.id}`,
      doc_type: 'fiscal_note',
      note_id: `fn:ofm:${p.packageId ?? p.id}`,
      source: 'ofm',
      bill_key: b.billKey,
      biennium: b.biennium,
      chamber: b.chamber,
      type: b.type,
      bill_number: b.id,
      display: versionLabel ?? `${b.type} ${b.number}`,
      version_label: versionLabel,
      version_code: parsed.ref?.kind === 'bill' ? parsed.ref.versionCode : null,
      package_id: p.packageId ? String(p.packageId) : null,
      ofm_kind: p.kind ?? null,
      title: `${p.label} fiscal note`,
      description: p.label,
      status: 'published',
      body: `${p.label} ${b.title}`,
      last_action_date: p.publishedAt ?? null,
      url: p.url,
      visibility: 'public',
      allowed_roles: [],
      allowed_user_ids: [],
      updated_at: b.updatedAt,
      source_hash: null,
    };
  });
}

export function buildRcwDocs(b: BillSummaryLike): SearchDoc[] {
  return b.rcwAffected
    .filter((r) => r.cite.split('.').length === 3)
    .map((r) => ({
      id: `rcw:${r.cite}`,
      doc_type: 'rcw_section' as const,
      cite: r.cite,
      rcw_cite: r.cite,
      rcw_title: r.cite.split('.')[0]!,
      rcw_chapter: r.cite.split('.').slice(0, 2).join('.'),
      rcw_cites: [r.cite],
      rcw_chapters: [r.cite.split('.').slice(0, 2).join('.')],
      rcw_titles: [r.cite.split('.')[0]!],
      caption: (r as any).caption ?? null,
      title: `RCW ${r.cite}${(r as any).caption ? ` ${(r as any).caption}` : ''}`,
      heading: `RCW ${r.cite}`,
      biennium: b.biennium,
      bill_key: null,
      affected_by: [{ bill_key: b.billKey, version_code: b.currentVersionCode, action: r.action, display: `${b.type} ${b.number}` }],
      affected_by_bill_keys: [b.billKey],
      url: `https://app.leg.wa.gov/RCW/default.aspx?cite=${r.cite}`,
      visibility: 'public' as const,
      allowed_roles: [],
      allowed_user_ids: [],
      updated_at: b.updatedAt,
      source_hash: null,
    }));
}
