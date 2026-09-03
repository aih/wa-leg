// Redline between two note versions: reading lines through the bill viewer's two-pass diff, plus a
// cell-by-cell diff of the estimate tables (editor.md section 5.2).
import { documentDiff, diffLinesHtml, diffSummary, type DiffLine, type ReadingLine } from '@wa-leg/bill-document/browser';
import { textOf, type PMNode } from './doc.js';
import { extractEstimateData, type EstimateData } from './extract.js';

function tokens(text: string): { text: string }[] {
  return (text.match(/\s+|\S+/g) ?? []).map((t) => ({ text: t }));
}

/** One reading line per block, with the owning slot or section as the line id. */
export function noteReadingLines(doc: PMNode): ReadingLine[] {
  const out: ReadingLine[] = [];
  let section = '';
  const push = (depth: number, text: string, kind: 'text' | 'note' = 'text', owner = section) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) out.push({ depth, kind, text: t, tokens: tokens(t), owner });
  };
  const visit = (n: PMNode, depth: number) => {
    switch (n.type) {
      case 'doc':
        for (const c of n.content ?? []) visit(c, depth);
        break;
      case 'noteSection':
        section = String(n.attrs?.part ?? '');
        for (const c of n.content ?? []) visit(c, 1);
        break;
      case 'heading':
        push(depth, textOf(n), 'note');
        break;
      case 'paragraph':
        push(depth, textOf(n), n.attrs?.locked ? 'note' : 'text', String(n.attrs?.slot ?? section));
        break;
      case 'bulletList':
      case 'orderedList':
      case 'listItem':
        for (const c of n.content ?? []) visit(c, n.type === 'listItem' ? depth : depth + 1);
        break;
      case 'noteTable':
        for (const row of n.content ?? []) push(depth + 1, (row.content ?? []).map((c) => textOf(c).trim()).join(' | '), row.attrs?.header ? 'note' : 'text', `${String(n.attrs?.role ?? 'table')}/${String(row.attrs?.key ?? row.attrs?.rowKind ?? '')}`);
        break;
      case 'blockMath':
        push(depth, String(n.attrs?.latex ?? ''));
        break;
      default:
        if (n.content) for (const c of n.content) visit(c, depth);
        else push(depth, textOf(n));
    }
  };
  visit(doc, 1);
  return out;
}

export interface TableCellChange {
  table: string;
  row: string;
  column: string;
  old: number | null;
  new: number | null;
}

export interface NoteDiff {
  lines: DiffLine[];
  html: string;
  summary: string;
  changed: number;
  inserted: number;
  deleted: number;
  tables: TableCellChange[];
}

function rowsByKey(data: EstimateData): Map<string, { fy: Record<string, number>; biennia: Record<string, number> }> {
  const m = new Map<string, { fy: Record<string, number>; biennia: Record<string, number> }>();
  const add = (group: string, rows: { key: string; fy: Record<string, number>; biennia: Record<string, number> }[]) => {
    for (const r of rows) m.set(`${group}/${r.key}`, r);
  };
  add('revenue', data.revenue);
  add('expenditure', data.expenditure);
  add('fte', data.fte);
  add('local', data.local);
  add('objects', data.objects);
  return m;
}

export function diffTables(a: EstimateData, b: EstimateData): TableCellChange[] {
  const A = rowsByKey(a);
  const B = rowsByKey(b);
  const out: TableCellChange[] = [];
  const keys = new Set([...A.keys(), ...B.keys()]);
  for (const k of keys) {
    const ra = A.get(k);
    const rb = B.get(k);
    const [table, row] = k.split('/') as [string, string];
    const cols = new Set([...Object.keys(ra?.fy ?? {}), ...Object.keys(rb?.fy ?? {})]);
    for (const c of cols) {
      const o = ra?.fy[c] ?? null;
      const n = rb?.fy[c] ?? null;
      if (o !== n) out.push({ table, row, column: c, old: o, new: n });
    }
  }
  return out;
}

export function diffNotes(from: PMNode, to: PMNode, opts: { fiscalYears?: number[] } = {}): NoteDiff {
  const d = documentDiff(noteReadingLines(from), noteReadingLines(to));
  const tables = diffTables(extractEstimateData(from, opts), extractEstimateData(to, opts));
  return { lines: d.lines, html: diffLinesHtml(d.lines), summary: diffSummary(d), changed: d.changed, inserted: d.inserted, deleted: d.deleted, tables };
}
