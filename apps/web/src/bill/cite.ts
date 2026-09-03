import type { BillDocument, BillSection, Block, CiteEvent } from '@wa-leg/bill-document/browser';
import { label as shortLabel, type BillType } from '@wa-leg/billref';

export interface BillUrlBuilder {
  version(bill: { biennium: string; id: string }, code: string, hash?: string): string;
  compare(bill: { biennium: string; id: string }, from: string, to: string, at?: string): string;
  amendment(bill: { biennium: string; id: string }, code: string, amendmentId: string, hash?: string): string;
  rcw(cite: string): string;
  source(url: string): string;
}

export const defaultUrlBuilder: BillUrlBuilder = {
  version: (b, code, hash) => `/bills/${b.biennium}/${b.id}/${code}${hash ? `#${hash}` : ''}`,
  compare: (b, from, to, at) => `/bills/${b.biennium}/${b.id}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${at ? `&at=${encodeURIComponent(at)}` : ''}`,
  amendment: (b, code, amendmentId, hash) => `/bills/${b.biennium}/${b.id}/${code}?amendment=${encodeURIComponent(amendmentId)}${hash ? `#${hash}` : ''}`,
  rcw: (cite) => `https://app.leg.wa.gov/RCW/default.aspx?cite=${cite}`,
  source: (url) => url,
};

/** "SHB 2402" from a Bill Document. */
export function versionShortLabel(doc: BillDocument): string {
  const fromList = doc.versions?.find((v) => v.code === doc.version.code)?.label;
  if (fromList && /^[0-9A-Z]*(HB|SB|HJR|SJR|HJM|SJM|HCR|SCR|HR|SR) \d+/.test(fromList)) return fromList;
  const type = billTypeOf(doc);
  const m = /^(?:(SECOND|THIRD)\s+)?ENGROSSED/i.exec(doc.header.longBillId ?? '');
  const eng = m ? (m[1] ? (m[1].toUpperCase() === 'SECOND' ? 2 : 3) : 1) : undefined;
  return shortLabel({ type, number: doc.bill.number, versionCode: doc.version.code }, eng);
}

export function billTypeOf(doc: BillDocument): BillType {
  const m = /^(HB|SB|HJR|SJR|HJM|SJM|HCR|SCR|HR|SR|SI|HI)/.exec(doc.bill.id);
  return (m?.[1] ?? 'HB') as BillType;
}

/** Path of labels from the section root to a block id ("sec-3.1.a" → ["(1)", "(a)"]). */
export function labelPath(section: BillSection, blockId: string | null): string[] {
  if (!blockId) return [];
  const path: string[] = [];
  const walk = (blocks: Block[]): boolean => {
    for (const b of blocks) {
      if (b.label) path.push(b.label);
      if (b.id === blockId) return true;
      if (walk(b.children)) return true;
      if (b.label) path.pop();
    }
    return false;
  };
  walk(section.blocks);
  return path;
}

/** "Section 1(2)(a) of SHB 2402". */
export function citationString(doc: BillDocument, section: BillSection, blockId: string | null, amendmentId?: string): string {
  const labels = labelPath(section, blockId).join('');
  const base = `Section ${section.num}${labels} of ${versionShortLabel(doc)}`;
  return amendmentId ? `${base} as amended by ${amendmentId}` : base;
}

export function blockPlainText(b: Block): string {
  const parts: string[] = [];
  if (b.table) for (const row of b.table.rows) parts.push(row.map((c) => c.runs.map((r) => r.text).join('')).join(' | '));
  else parts.push(b.runs.map((r) => r.text).join(''));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function sectionPlainText(s: BillSection): string {
  const parts: string[] = [s.label];
  if (s.introText) parts.push(s.introText.map((r) => r.text).join(''));
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      parts.push([b.label ?? '', blockPlainText(b)].filter(Boolean).join(' '));
      walk(b.children);
    }
  };
  walk(s.blocks);
  return parts.join('\n').replace(/[ \t]+/g, ' ').trim();
}

export function findBlock(section: BillSection, blockId: string): Block | null {
  const walk = (blocks: Block[]): Block | null => {
    for (const b of blocks) {
      if (b.id === blockId) return b;
      const c = walk(b.children);
      if (c) return c;
    }
    return null;
  };
  return walk(section.blocks);
}

export function makeCiteEvent(
  doc: BillDocument,
  section: BillSection,
  blockId: string | null,
  range: { start: number; end: number } | null,
  text: string,
  urls: BillUrlBuilder,
  amendmentId?: string,
): CiteEvent {
  const bill = { biennium: doc.bill.biennium, id: doc.bill.id };
  const labels = labelPath(section, blockId);
  const ev: CiteEvent = {
    bill,
    versionCode: doc.version.code,
    sectionId: section.id,
    sectionNum: section.num,
    blockId,
    label: labels.length ? labels.join('') : null,
    range,
    text,
    citation: citationString(doc, section, blockId, amendmentId),
    href: amendmentId ? urls.amendment(bill, doc.version.code, amendmentId, blockId ?? section.id) : urls.version(bill, doc.version.code, blockId ?? section.id),
  };
  if (amendmentId) ev.amendmentId = amendmentId;
  return ev;
}

export const KIND_LABELS: Record<string, string> = {
  amendatory: 'amends',
  new: 'new section',
  repealer: 'repeals',
  'effective-date': 'effective date',
  emergency: 'emergency clause',
  severability: 'severability',
  expiration: 'expiration',
  intent: 'intent',
  appropriation: 'appropriation',
  contingent: 'contingent',
  other: '',
};

/** Short description of what a section does: "amends RCW 82.04.260", "adds to ch. 82.12". */
export function sectionGloss(s: BillSection): string {
  const t = s.target;
  if (t) {
    if ((t.action === 'amend' || t.action === 'reenact-amend') && t.cite) return `${t.action === 'reenact-amend' ? 'reenacts and amends' : 'amends'} RCW ${t.cite}`;
    if (t.action === 'amend' && t.uncodified) return `amends ${t.uncodified} (uncodified)`;
    if (t.action === 'add' && t.chapter) return `adds to ch. ${t.chapter} RCW`;
    if (t.action === 'add' && t.title) return `new chapter in Title ${t.title} RCW`;
    if (t.action === 'repeal') {
      const n = t.repealed?.length ?? 0;
      return n === 1 ? `repeals RCW ${t.repealed![0]!.cite}` : `repeals ${n} sections`;
    }
  }
  return KIND_LABELS[s.kind] ?? s.kind;
}
