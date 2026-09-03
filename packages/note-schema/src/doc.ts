// ProseMirror JSON helpers shared by the loader, evaluator, extractor and validator.

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function textOf(n: PMNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'billCitation') return String(n.attrs?.label ?? n.attrs?.citation ?? '');
  if (n.type === 'inlineMath' || n.type === 'blockMath') return String(n.attrs?.latex ?? '');
  if (n.type === 'checkbox') return n.attrs?.checked ? '☒' : '☐';
  return (n.content ?? []).map(textOf).join('');
}

/** Visit every node depth-first with its path of ancestors. */
export function walk(n: PMNode, fn: (node: PMNode, parents: PMNode[]) => void | false, parents: PMNode[] = []): void {
  if (fn(n, parents) === false) return;
  for (const c of n.content ?? []) walk(c, fn, [...parents, n]);
}

export function findAll(n: PMNode, type: string): PMNode[] {
  const out: PMNode[] = [];
  walk(n, (x) => {
    if (x.type === type) out.push(x);
  });
  return out;
}

export function cloneDoc<T>(d: T): T {
  return JSON.parse(JSON.stringify(d)) as T;
}

// ---------- number formatting ----------

export type SlotType = 'text' | 'multiline' | 'list' | 'money' | 'money-thousands' | 'fte' | 'int' | 'pct' | 'account' | 'revenue-source' | 'job-class' | 'wac' | 'account-3char';

/** Parse a typed cell: "$(1,250,000)" → -1250000. Returns null for blank or non-numeric text. */
export function parseNumber(text: string): number | null {
  const t = text.replace(/\s+/g, '').replace(/\$/g, '').replace(/,/g, '');
  if (t === '' || t === '-' || t === '—') return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  const core = t.replace(/[()-]/g, '').replace(/%$/, '');
  if (core === '' || !/^\d*(?:\.\d+)?$/.test(core)) return null;
  const v = Number(core);
  return neg ? -v : v;
}

const NUMERIC_TYPES = new Set<SlotType>(['money', 'money-thousands', 'fte', 'int', 'pct']);
export function isNumericType(t: string | null | undefined): boolean {
  return !!t && NUMERIC_TYPES.has(t as SlotType);
}

export function formatNumber(v: number | null, type: string | null | undefined, precision?: number | null): string {
  if (v === null || Number.isNaN(v)) return '';
  const neg = v < 0;
  const abs = Math.abs(v);
  let s: string;
  switch (type) {
    case 'money':
      s = Math.round(abs).toLocaleString('en-US');
      return neg ? `(${s})` : s;
    case 'money-thousands':
      s = Math.round(abs).toLocaleString('en-US');
      return neg ? `($${s})` : `$${s}`;
    case 'fte':
      s = abs.toFixed(precision ?? 1);
      return neg ? `(${s})` : s;
    case 'int':
      s = Math.round(abs).toLocaleString('en-US');
      return neg ? `-${s}` : s;
    case 'pct':
      s = `${abs.toFixed(precision ?? 1)}%`;
      return neg ? `-${s}` : s;
    default:
      s = abs.toLocaleString('en-US', { maximumFractionDigits: 2 });
      return neg ? `(${s})` : s;
  }
}
