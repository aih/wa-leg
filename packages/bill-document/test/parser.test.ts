import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmendmentXml, parseBillHtm, validateBillDocument, validateAmendmentDocument, textHash, sha256, sectionText } from '../src/index.js';
import { FIXTURES, index, loadBill, compare, FETCHED_AT, type BillFixture } from './fixtures.js';

describe('fixture corpus', () => {
  it('has twenty bill versions and covers every required kind', () => {
    const bills = index.filter((f) => f.kind === 'bill');
    expect(bills.length).toBeGreaterThanOrEqual(20);
    const covered = new Set(index.flatMap((f) => f.covers));
    for (const k of ['amendatory', 'new-chapter', 'repealer', 'effective-date', 'emergency', 'part-numbered', 'table', 'passed-legislature', 'session-law', 'striking-amendment', 'page-line-amendment']) {
      expect(covered, `covers ${k}`).toContain(k);
    }
  });

  for (const f of index) {
    it(`${f.file}: source hash matches, parses, validates, and equals the expected JSON`, () => {
      const raw = readFileSync(join(FIXTURES, f.file));
      expect(sha256(raw)).toBe(f.sha256);
      if (f.kind === 'bill') {
        const doc = loadBill(f);
        expect(validateBillDocument(doc)).toEqual([]);
        expect(doc.sections.length).toBeGreaterThan(0);
        const ids = new Set<string>();
        for (const s of doc.sections) {
          expect(ids.has(s.id), `duplicate section id ${s.id}`).toBe(false);
          ids.add(s.id);
          expect(s.textHash).toBe(textHash(s));
          expect(s.identity).not.toBe('');
        }
        expect(new Set(doc.sections.map((s) => s.identity)).size).toBe(doc.sections.length);
        for (const k of f.covers) {
          if (k === 'amendatory') expect(doc.sections.some((s) => s.kind === 'amendatory')).toBe(true);
          if (k === 'new-chapter') expect(doc.sections.some((s) => s.sourceKind === 'addchap')).toBe(true);
          if (k === 'repealer') expect(doc.sections.some((s) => s.kind === 'repealer' && (s.target?.repealed?.length ?? 0) > 0)).toBe(true);
          if (k === 'effective-date') expect(doc.sections.some((s) => s.kind === 'effective-date')).toBe(true);
          if (k === 'emergency') expect(doc.sections.some((s) => s.kind === 'emergency')).toBe(true);
          if (k === 'part-numbered') expect(doc.header.parts?.length ?? 0).toBeGreaterThan(0);
          if (k === 'table') expect(JSON.stringify(doc.sections).includes('"kind":"table"')).toBe(true);
          if (k === 'session-law') expect(doc.certificate?.chapter).toBeGreaterThan(0);
          if (k === 'passed-legislature') expect(doc.certificate?.passed?.length).toBe(2);
          if (k === 'partial-veto') expect(doc.certificate?.partialVeto).toBe(true);
        }
        compare(doc, f.file);
      } else {
        const xml = readFileSync(join(FIXTURES, f.file), 'utf8');
        const doc = parseAmendmentXml(xml, { biennium: f.biennium, billId: f.billId, amendmentId: f.amendmentId, baseVersion: f.baseVersion, fetchedAt: FETCHED_AT, sourceHash: f.sha256 });
        expect(validateAmendmentDocument(doc)).toEqual([]);
        for (const k of f.covers) {
          if (k === 'striking-amendment') {
            expect(doc.kind).toBe('striking');
            expect(doc.body?.sections.length).toBeGreaterThan(0);
          }
          if (k === 'page-line-amendment') {
            expect(doc.kind).toBe('page-line');
            expect(doc.instructions?.some((i) => i.location.page !== undefined)).toBe(true);
          }
        }
        compare(doc, f.file);
      }
    });
  }
});

describe('HTM fallback parser', () => {
  it('parses 2402-S.htm to the same sections and reading text as the XML', () => {
    const htm = readFileSync(join(FIXTURES, '2402-S.htm'), 'utf8');
    const fromHtm = parseBillHtm(htm, { biennium: '2025-26', type: 'HB', number: 2402, versionCode: 'S', fetchedAt: FETCHED_AT });
    expect(validateBillDocument(fromHtm)).toEqual([]);
    const xmlFixture = index.find((f) => f.file === '2402-S.xml') as BillFixture;
    const fromXml = loadBill(xmlFixture);
    expect(fromHtm.sections.map((s) => s.id)).toEqual(fromXml.sections.map((s) => s.id));
    expect(fromHtm.sections.map((s) => s.kind)).toEqual(fromXml.sections.map((s) => s.kind));
    for (let i = 0; i < fromXml.sections.length; i++) {
      expect(sectionText(fromHtm.sections[i]!)).toBe(sectionText(fromXml.sections[i]!));
    }
    expect(fromHtm.header.title).toBe(fromXml.header.title);
    expect(fromHtm.provenance.parser).toBe('wa-bill-htm');
  });

  it('reads struck and inserted text from inline styles', () => {
    const htm = readFileSync(join(FIXTURES, '6137.htm'), 'utf8');
    const doc = parseBillHtm(htm, { biennium: '2025-26', type: 'SB', number: 6137, versionCode: 'I', fetchedAt: FETCHED_AT });
    const sec2 = doc.sections.find((s) => s.identity === 'rcw:9.46.038')!;
    expect(sec2.kind).toBe('amendatory');
    expect(sec2.target?.cite).toBe('9.46.038');
    const runs = JSON.stringify(sec2.blocks);
    expect(runs).toContain('"t":"del"');
    expect(runs).toContain('"t":"ins"');
    expect(runs).toMatch(/\(\(, other than such an institution/);
  });
});
