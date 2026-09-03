import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentDiff, diffVersions, diffSummary, diffLinesHtml, sectionLines, type ReadingLine } from '../src/index.js';
import { FIXTURES, index, loadBill, type BillFixture } from './fixtures.js';

const UPDATE = process.env.UPDATE_FIXTURES === '1';

function line(text: string, depth = 1, owner = 'b'): ReadingLine {
  return { depth, kind: 'text', text, tokens: (text.match(/\s+|\S+/g) ?? []).map((t) => ({ text: t })), owner };
}

describe('documentDiff', () => {
  it('reports no changes for identical lines', () => {
    const d = documentDiff([line('a b c'), line('d e f')], [line('a b c'), line('d e f')]);
    expect(diffSummary(d)).toBe('No changes');
    expect(d.lines.every((l) => l.mark === 'equal')).toBe(true);
  });

  it('pairs an edited figure as one changed line with word-level spans', () => {
    const d = documentDiff([line('The sum of $5,000,000 is appropriated.')], [line('The sum of $7,500,000 is appropriated.')]);
    expect(d.changed).toBe(1);
    expect(d.lines[0]!.mark).toBe('changed');
    const spans = d.lines[0]!.spans;
    expect(spans.find((s) => s.mark === 'delete')?.text).toBe('$5,000,000');
    expect(spans.find((s) => s.mark === 'insert')?.text).toBe('$7,500,000');
  });

  it('keeps unrelated lines as a deletion and an insertion', () => {
    const d = documentDiff([line('Alpha beta gamma delta epsilon')], [line('One two three four five six seven')]);
    expect(d.changed).toBe(0);
    expect(d.deleted).toBe(1);
    expect(d.inserted).toBe(1);
  });

  it('does not shift later lines into changed when a line is inserted', () => {
    const d = documentDiff([line('one'), line('two'), line('three')], [line('one'), line('new'), line('two'), line('three')]);
    expect(d.inserted).toBe(1);
    expect(d.changed).toBe(0);
    expect(d.lines.map((l) => l.mark)).toEqual(['equal', 'insert', 'equal', 'equal']);
  });

  it('treats a word that moved from plain to struck as a change in as-printed mode', () => {
    const fromLine: ReadingLine = { depth: 1, kind: 'text', text: 'pay the tax', tokens: [{ text: 'pay' }, { text: ' ' }, { text: 'the' }, { text: ' ' }, { text: 'tax' }], owner: 'b' };
    const toLine: ReadingLine = { depth: 1, kind: 'text', text: 'pay ((the)) tax', tokens: [{ text: 'pay' }, { text: ' ' }, { text: '((the))', billMark: 'del' }, { text: ' ' }, { text: 'tax' }], owner: 'b' };
    const d = documentDiff([fromLine], [toLine]);
    expect(d.changed).toBe(1);
    expect(d.lines[0]!.spans.some((s) => s.mark === 'insert' && s.billMark === 'del')).toBe(true);
    const html = diffLinesHtml(d.lines, 'b');
    expect(html).toContain('<ins><span class="bill-del">((the))</span></ins>');
    expect(html).toContain('id="diff-focus"');
  });
});

function bill(file: string) {
  return loadBill(index.find((f) => f.file === file) as BillFixture);
}

function compare(actual: unknown, name: string): void {
  const p = join(FIXTURES, 'expected', name);
  if (UPDATE || !existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(actual, null, 1) + '\n');
  }
  expect(actual).toEqual(JSON.parse(readFileSync(p, 'utf8')));
}

describe('diffVersions on the fixture corpus', () => {
  it('HB 2402 I → S: sections align by identity and the summary is stable', () => {
    const d = diffVersions(bill('2402.xml'), bill('2402-S.xml'));
    expect(d.from).toBe('I');
    expect(d.to).toBe('S');
    expect(d.sections.length).toBeGreaterThanOrEqual(5);
    expect(d.sections.some((s) => s.status === 'changed')).toBe(true);
    compare(d, 'diff-2402-I-S.json');
  });

  it('SB 5814 S → S.E: engrossment diff', () => {
    const d = diffVersions(bill('5814-S.xml'), bill('5814-S.E.xml'));
    expect(d.summary.sectionsChanged).toBeGreaterThan(0);
    expect(d.sections.filter((s) => s.status === 'equal').length).toBeGreaterThan(0);
    compare(d, 'diff-5814-S-S.E.json');
  });

  it('a document diffed against itself has no changes and lists every section as equal', () => {
    const a = bill('2081.xml');
    const d = diffVersions(a, a);
    expect(d.summary).toEqual({ changed: 0, inserted: 0, deleted: 0, sectionsChanged: 0 });
    expect(d.sections.every((s) => s.status === 'equal')).toBe(true);
  });

  it('effect mode drops struck text and keeps inserted text as plain', () => {
    const a = bill('6137.xml');
    const s = a.sections.find((x) => x.identity === 'rcw:9.46.038')!;
    const printed = sectionLines(s, 'as-printed');
    const effect = sectionLines(s, 'effect');
    expect(printed.some((l) => l.tokens.some((t) => t.billMark === 'del'))).toBe(true);
    expect(effect.some((l) => l.tokens.some((t) => t.billMark))).toBe(false);
    expect(effect.map((l) => l.text).join(' ')).not.toContain('((');
  });
});
