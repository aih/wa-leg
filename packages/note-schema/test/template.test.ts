import { describe, expect, it } from 'vitest';
import { generateHTML } from '@tiptap/html';
import {
  loadTemplate,
  limitedExtensions,
  fullExtensions,
  recompute,
  extractEstimateData,
  validateNote,
  diffNotes,
  docToHtml,
  docToText,
  findAll,
  textOf,
  walk,
  unfilledSlots,
  formatNumber,
  parseNumber,
  substituteTokens,
  sessionLabels,
  type PMNode,
} from '../src/index.js';
import { JOB_CLASSES, manifest, sampleContext, templateFiles, templateHtml } from './fixtures.js';

const ctx = sampleContext();

function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(?:data-computed|data-hint|data-validate)="[^"]*"/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('template loader over the twelve templates', () => {
  it('manifest lists twelve templates and every file exists', () => {
    expect(manifest.templates.length).toBe(12);
    expect(templateFiles().length).toBe(12);
  });

  for (const t of manifest.templates) {
    it(`${t.id}: parses to ProseMirror JSON without losing narrative text`, () => {
      const html = templateHtml(t.file);
      const loaded = loadTemplate(html, ctx, { keepEmptyRepeats: true });
      expect(loaded.doc.type).toBe('doc');
      // Sections in order.
      const parts = (loaded.doc.content ?? []).filter((n) => n.type === 'noteSection').map((n) => n.attrs?.part);
      expect(parts.slice(0, 2)).toEqual(['header', 'I']);
      for (const p of t.parts) if (p !== '10YR') expect(parts).toContain(p);
      // Tables by role.
      const roles = new Set(findAll(loaded.doc, 'noteTable').map((n) => n.attrs?.role));
      const tableRoles = [...html.matchAll(/<table[^>]*data-role="([^"]+)"/g)].map((m) => m[1]);
      for (const r of t.tables) if (tableRoles.includes(r)) expect(roles, `table ${r}`).toContain(r);
      // Slots.
      const slotIds = new Set(loaded.slots.map((s) => s.id));
      for (const s of t.slots.filter((s) => !s.includes('extraYears'))) expect(slotIds, `slot ${s}`).toContain(s);
      // Every sentence of visible narrative survives the parse: compare word bags after token substitution.
      const substituted = substituteTokens(html.replace(/<!--[\s\S]*?-->/g, ''), ctx as never).html;
      const expectedWords = new Set(stripTags(substituted).toLowerCase().split(' ').filter((w) => w.length > 5));
      const actualText = docToText(loaded.doc).toLowerCase();
      const missing = [...expectedWords].filter((w) => !actualText.includes(w));
      expect(missing.length, `missing words: ${missing.slice(0, 10).join(', ')}`).toBeLessThan(Math.max(3, expectedWords.size * 0.01));
      // No tokens left unresolved except analyst-input ones.
      const stray = loaded.unknownTokens.filter((tok) => !/^(rules|narrative|prior|bill\.effective|ref\.|revision\.)/.test(tok));
      expect(stray, `unknown tokens ${stray.join(', ')}`).toEqual([]);
      // Round trip JSON → HTML → JSON is stable.
      const htmlOut = generateHTML(loaded.doc as never, limitedExtensions());
      if (tableRoles.includes('cash-receipts')) expect(htmlOut).toContain('data-role="cash-receipts"');
      expect(htmlOut.length).toBeGreaterThan(1000);
    });
  }

  it('substitutes tokens, keeps unknown ones literal, and reports them', () => {
    const r = substituteTokens('<p>{{bill.number}} {{fy.1}} {{fy.2.year}} {{bien.3}} {{nope.x}} {{ref.salary.EXCISE_TAX_EX_2}}</p>', ctx as never);
    expect(r.html).toBe('<p>2402 S HB FY 2026 2027 2029-31 {{nope.x}} 59,844</p>');
    expect(r.unknownTokens).toEqual(['nope.x']);
    const labels = sessionLabels(2025);
    expect(labels.fy[0]!.label).toBe('FY 2026');
    expect(labels.bien).toEqual(['2025-27', '2027-29', '2029-31']);
    expect(labels.biennium).toBe('2025-26');
  });

  it('data-condition drops the ten-year section when not requested; data-repeat expands job classes', () => {
    const html = templateHtml('03-bo-rate-change.html');
    const withTen = loadTemplate(html, ctx);
    const parts = (withTen.doc.content ?? []).map((n) => n.attrs?.part);
    expect(parts).toContain('10YR');
    const without = loadTemplate(html, sampleContext({ request: { date: '02/05/2026', tenYearRequested: false } }));
    expect((without.doc.content ?? []).map((n) => n.attrs?.part)).not.toContain('10YR');
    const expanded = loadTemplate(html, sampleContext({ fteClass: JOB_CLASSES }));
    const fte = findAll(expanded.doc, 'noteTable').find((t) => t.attrs?.role === 'fte-by-class')!;
    const classRows = (fte.content ?? []).filter((r) => r.attrs?.rowKind === 'class');
    expect(classRows.length).toBe(6);
    expect(textOf(classRows[2]!.content![0]!)).toContain('TAX POLICY SP 3');
    expect(textOf(classRows[2]!.content![1]!)).toBe('91,068');
    // The optional extra-years block becomes a snippet.
    expect(withTen.snippets.some((s) => s.path === 'narrative.expenditures.extraYears')).toBe(true);
    // Template rows survive when no class list is supplied.
    const kept = findAll(withTen.doc, 'noteTable').find((t) => t.attrs?.role === 'fte-by-class')!;
    expect((kept.content ?? []).filter((r) => r.attrs?.rowKind === 'class').length).toBeGreaterThan(6);
  });

  it('locks headings and form instructions; header fields become locked paragraphs with readonly slots', () => {
    const loaded = loadTemplate(templateHtml('01-no-fiscal-impact.html'), ctx);
    for (const h of findAll(loaded.doc, 'heading')) expect(h.attrs?.locked).toBe(true);
    const instr = findAll(loaded.doc, 'paragraph').filter((p) => p.attrs?.cssClass === 'form-instruction');
    expect(instr.length).toBeGreaterThan(0);
    expect(instr.every((p) => p.attrs?.locked)).toBe(true);
    const field = findAll(loaded.doc, 'paragraph').find((p) => p.attrs?.cssClass === 'field')!;
    expect(field.attrs?.locked).toBe(true);
    expect(textOf(field)).toContain('2402 S HB');
    const bill = findAll(loaded.doc, 'slot').find((s) => s.attrs?.slot === 'bill.number')!;
    expect(bill.attrs?.readonly).toBe(true);
  });

  it('reports unfilled required slots and excludes readonly, optional and computed ones', () => {
    const loaded = loadTemplate(templateHtml('04-sales-use-tax-exemption.html'), ctx);
    const unfilled = unfilledSlots(loaded.doc);
    expect(unfilled).toContain('receipts.gf.fy1');
    expect(unfilled).not.toContain('bill.number');
    expect(unfilled.every((id) => !id.startsWith('preparer.'))).toBe(true);
  });
});

function fill(doc: PMNode, values: Record<string, number | string>): PMNode {
  const d = JSON.parse(JSON.stringify(doc)) as PMNode;
  walk(d, (n) => {
    const slot = n.attrs?.slot as string | undefined;
    if (!slot || !(slot in values)) return;
    const v = values[slot]!;
    if (n.type === 'noteCell' || n.type === 'slot' || n.type === 'paragraph') {
      n.content = [{ type: 'text', text: String(v) }];
      if (typeof v === 'number') n.attrs = { ...n.attrs, value: v };
    }
  });
  return d;
}

describe('computed cells, extraction and validation', () => {
  const base = loadTemplate(templateHtml('04-sales-use-tax-exemption.html'), ctx).doc;
  const filled = recompute(
    fill(base, {
      'receipts.gf.fy1': -4310000,
      'receipts.gf.fy2': -10800000,
      'receipts.gf.fy3': -11220000,
      'receipts.gf.fy4': -11620000,
      'receipts.gf.fy5': -12100000,
      'receipts.gf.fy6': -12620000,
      'receipts.pag.fy1': -7000,
      'receipts.pag.fy2': -17000,
      'expenditures.gf.fy1': 275400,
      'expenditures.gf.fy2': 9700,
      'objects.A.fy1': 120000,
      'objects.B.fy1': 29200,
      'objects.C.fy1': 100000,
      'objects.E.fy1': 26200,
      'objects.A.fy2': 7000,
      'objects.B.fy2': 2700,
      'fteClass[0].fy1': 1.14,
      'fteClass[0].fy2': 0.05,
      'fteClass[1].fy1': 0.5,
    }),
  ).doc;

  it('auto-sums biennium columns, totals, the FTE row (averages) and the II.B series', () => {
    const receipts = findAll(filled, 'noteTable').find((t) => t.attrs?.role === 'cash-receipts')!;
    const gf = (receipts.content ?? []).find((r) => r.attrs?.key === 'gf')!;
    const cells = gf.content!;
    expect(textOf(cells.find((c) => c.attrs?.col === 'fy1')!)).toBe('(4,310,000)');
    expect(textOf(cells.find((c) => c.attrs?.col === 'bien1')!)).toBe('(15,110,000)');
    expect(textOf(cells.find((c) => c.attrs?.col === 'bien2')!)).toBe('');
    const total = (receipts.content ?? []).find((r) => r.attrs?.rowKind === 'total')!;
    expect(textOf(total.content![1]!)).toBe('(4,317,000)');
    expect(textOf(total.content![2]!)).toBe('(10,817,000)');
    const exp = findAll(filled, 'noteTable').find((t) => t.attrs?.role === 'expenditures-by-account')!;
    const fteRow = (exp.content ?? []).find((r) => r.attrs?.rowKind === 'fte')!;
    expect(textOf(fteRow.content!.find((c) => c.attrs?.col === 'fy1')!)).toBe('1.6');
    expect(textOf(fteRow.content!.find((c) => c.attrs?.col === 'bien1')!)).toBe('0.8'); // avg(1.64, 0.05) = 0.845 → 0.8
    const series = findAll(filled, 'noteTable').find((t) => t.attrs?.role === 'impact-series' && t.attrs?.scope === 'impact.state')!;
    expect(textOf(series.content![0]!.content![1]!)).toBe('($4,317)');
    const flag = findAll(filled, 'checkbox').find((c) => c.attrs?.slot === 'flags.over50k')!;
    expect(flag.attrs?.checked).toBe(true);
    const under = findAll(filled, 'checkbox').find((c) => c.attrs?.slot === 'flags.under50k')!;
    expect(under.attrs?.checked).toBe(false);
  });

  it('extracts estimate data with six fiscal years and biennia', () => {
    const data = extractEstimateData(filled);
    expect(data.fiscalYears).toEqual([2026, 2027, 2028, 2029, 2030, 2031]);
    expect(data.biennia).toEqual(['2025-27', '2027-29', '2029-31']);
    const gf = data.revenue.find((r) => r.key === 'gf')!;
    expect(gf.fundName).toBe('GF-STATE-State');
    expect(gf.source).toContain('Retail Sales Tax');
    expect(gf.fy['2026']).toBe(-4310000);
    expect(gf.fy['2027']).toBe(-10800000);
    expect(gf.biennia['2025-27']).toBe(-15110000);
    // Fiscal years three to six have no per-account cells in the templates; the II.B series cells take them in thousands.
    expect(data.series.state['2026']).toBe(-4317);
    expect(data.series.state['2027']).toBe(-10817);
    const six = recompute(fill(filled, { 'impact.state.fy3': -11220, 'impact.state.fy6': -12620, 'impact.local.fy1': -1600 })).doc;
    const sixData = extractEstimateData(six);
    expect(sixData.series.state['2028']).toBe(-11220);
    expect(sixData.series.state['2031']).toBe(-12620);
    expect(sixData.series.local['2026']).toBe(-1600);
    expect(sixData.local[0]!.fy['2026']).toBe(-1600);
    expect(data.expenditure[0]!.fy['2026']).toBe(275400);
    expect(data.fte.length).toBeGreaterThanOrEqual(2);
    expect(data.fte[0]!.fy['2026']).toBe(1.14);
    expect(data.fte[0]!.biennia['2025-27']).toBeCloseTo(0.595, 3);
    expect(data.objects.find((o) => o.key === 'A')!.fy['2026']).toBe(120000);
    expect(data.flags.over50k).toBe(true);
  });

  it('validates a reconciled document and reports each broken rule', () => {
    const ok = validateNote(filled);
    expect(ok.errors.filter((e) => e.code !== 'part1_vs_3a')).toEqual([]);
    // Part I expenditures 275,400 vs III.A objects 275,400 in FY 2026 — equal; FY 2027: 9,700 vs 9,700 — equal.
    expect(ok.errors).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.unfilledSlots.length).toBeGreaterThan(0);
    // Break the III.A total.
    const broken = fill(filled, { 'objects.A.fy1': 999999 });
    const r1 = validateNote(recompute(broken).doc);
    expect(r1.ok).toBe(false);
    expect(r1.errors.some((e) => e.code === 'part1_vs_3a')).toBe(true);
    // Stale biennium column (computed cell text edited by hand).
    const stale = JSON.parse(JSON.stringify(filled)) as PMNode;
    const receipts = findAll(stale, 'noteTable').find((t) => t.attrs?.role === 'cash-receipts')!;
    const gf = (receipts.content ?? []).find((r) => r.attrs?.key === 'gf')!;
    const bien1 = gf.content!.find((c) => c.attrs?.col === 'bien1')!;
    bien1.content = [{ type: 'text', text: '(1)' }];
    bien1.attrs = { ...bien1.attrs, value: -1 };
    const r2 = validateNote(stale);
    expect(r2.errors.some((e) => e.code === 'biennium_sum')).toBe(true);
    // FTE biennium average out of step.
    const staleFte = JSON.parse(JSON.stringify(filled)) as PMNode;
    const fte = findAll(staleFte, 'noteTable').find((t) => t.attrs?.role === 'fte-by-class')!;
    const row = (fte.content ?? []).find((r) => r.attrs?.rowKind === 'class')!;
    const b1 = row.content!.find((c) => c.attrs?.col === 'bien1')!;
    b1.content = [{ type: 'text', text: '9.0' }];
    b1.attrs = { ...b1.attrs, value: 9 };
    const r3 = validateNote(staleFte);
    expect(r3.errors.some((e) => e.code === 'fte_biennium_average')).toBe(true);
    // Part I FTE row edited away from the III.B total.
    const staleRow = JSON.parse(JSON.stringify(filled)) as PMNode;
    const exp = findAll(staleRow, 'noteTable').find((t) => t.attrs?.role === 'expenditures-by-account')!;
    const fteRow = (exp.content ?? []).find((r) => r.attrs?.rowKind === 'fte')!;
    const fy1 = fteRow.content!.find((c) => c.attrs?.col === 'fy1')!;
    fy1.content = [{ type: 'text', text: '7.0' }];
    fy1.attrs = { ...fy1.attrs, value: 7 };
    const r4 = validateNote(staleRow);
    expect(r4.errors.some((e) => e.code === 'fte_3b_vs_part1' || e.code === 'computed_mismatch')).toBe(true);
  });

  it('diffs two versions as reading lines plus table cell changes', () => {
    const later = recompute(fill(filled, { 'receipts.gf.fy1': -5000000, 'narrative.receipts.estimate': 'This bill decreases state revenues by an estimated $5.0 million.' })).doc;
    const d = diffNotes(filled, later);
    expect(d.tables.some((c) => c.table === 'revenue' && c.row === 'gf' && c.column === '2026' && c.old === -4310000 && c.new === -5000000)).toBe(true);
    expect(d.changed + d.inserted + d.deleted).toBeGreaterThan(0);
    expect(d.html).toContain('diff-line--');
    expect(d.summary).not.toBe('No changes');
    expect(diffNotes(filled, filled).summary).toBe('No changes');
  });

  it('derives HTML with math rendered and slots unwrapped for export', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'noteSection', attrs: { part: 'II.B' }, content: [{ type: 'paragraph', content: [{ type: 'slot', attrs: { slot: 'x', required: true }, content: [{ type: 'text', text: 'Rate ' }, { type: 'inlineMath', attrs: { latex: '\\frac{1}{2}' } }] }, { type: 'billCitation', attrs: { citation: 'Section 2 of SHB 2402', label: 'Sec. 2', href: '/bills/2025-26/HB2402/S#sec-2' } }] }] },
      ],
    };
    const html = docToHtml(doc, { renderMath: true, unwrapSlots: true, citationsAs: 'text' });
    expect(html).toContain('katex');
    expect(html).toContain('<math');
    expect(html).not.toContain('data-slot');
    expect(html).toContain('Section 2 of SHB 2402');
    expect(html).not.toContain('<a ');
    const linked = docToHtml(doc, { citationsAs: 'link', linkOrigin: 'https://example.test' });
    expect(linked).toContain('href="https://example.test/bills/2025-26/HB2402/S#sec-2"');
    expect(fullExtensions().length).toBeGreaterThan(limitedExtensions().length);
  });

  it('formats and parses currency, thousands, FTE and percentages', () => {
    expect(formatNumber(-1250000, 'money')).toBe('(1,250,000)');
    expect(formatNumber(1250000, 'money')).toBe('1,250,000');
    expect(formatNumber(-4310, 'money-thousands')).toBe('($4,310)');
    expect(formatNumber(1.14, 'fte', 2)).toBe('1.14');
    expect(formatNumber(0.845, 'fte')).toBe('0.8');
    expect(parseNumber('$(1,250,000)')).toBe(-1250000);
    expect(parseNumber('(4,310)')).toBe(-4310);
    expect(parseNumber('1.14')).toBe(1.14);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
});
