// Validation: required slots and the reconciliation rules in design/research/fiscal-notes.md section 8.
import { findAll, parseNumber, textOf, type PMNode } from './doc.js';
import { collectValues, Evaluator, resolvePath } from './compute.js';
import { extractEstimateData, type EstimateData, type ExtractOptions } from './extract.js';
import { unfilledSlots } from './template.js';

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  unfilledSlots: string[];
}

const EPS = 0.5;
const FTE_EPS = 0.051;

function near(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

function cellValue(cell: PMNode): number | null {
  const v = cell.attrs?.value;
  if (typeof v === 'number') return v;
  return parseNumber(textOf(cell));
}

/** Validate a note document: required slots and table reconciliation. */
export function validateNote(doc: PMNode, opts: ExtractOptions & { requireSlots?: boolean } = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const vm = collectValues(doc);
  const ev = new Evaluator(vm);

  // 1. Every computed cell must show the value its expression yields (biennium sums, FTE averages, totals).
  for (const table of findAll(doc, 'noteTable')) {
    const role = String(table.attrs?.role ?? '');
    for (const row of table.content ?? []) {
      for (const cell of row.content ?? []) {
        const expr = cell.attrs?.computed as string | undefined;
        if (!expr) continue;
        let expected: unknown;
        try {
          expected = ev.eval(expr);
        } catch {
          continue;
        }
        if (typeof expected !== 'number') continue;
        const actual = cellValue(cell);
        const isFte = String(cell.attrs?.slotType ?? '') === 'fte' || /^avg\(/.test(expr) || table.attrs?.unit === 'fte';
        const eps = isFte ? FTE_EPS : EPS;
        if (actual === null || !near(actual, expected, eps)) {
          const code = /^avg\(/.test(expr) ? 'fte_biennium_average' : /^sum\([^*]*,[^*]*\)/.test(expr) && !expr.includes('*') ? 'biennium_sum' : 'computed_mismatch';
          errors.push({ code, path: `${role}/${String(row.attrs?.key ?? row.attrs?.rowKind ?? '')}/${String(cell.attrs?.col ?? '')}`, message: `${role}: expected ${expected} for ${expr}, found ${actual ?? 'blank'}` });
        }
      }
    }
  }

  // 2. Cross-table rules.
  const data = extractEstimateData(doc, opts);
  const fyKeys = data.fiscalYears.map(String);
  const sumRows = (rows: EstimateData['expenditure']) => {
    const out: Record<string, number> = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.fy)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const partI = sumRows(data.expenditure);
  const objects = sumRows(data.objects);
  if (data.objects.length && data.expenditure.length) {
    for (const k of fyKeys.slice(0, 6)) {
      const a = partI[k] ?? 0;
      const b = objects[k] ?? 0;
      if (!near(a, b, EPS)) errors.push({ code: 'part1_vs_3a', path: `expenditures/${k}`, message: `Part I expenditures (${a}) differ from III.A object totals (${b}) for FY ${k}` });
    }
  }
  // III.B FTE totals equal the Part I FTE row.
  const fteTotals = sumRows(data.fte);
  for (let i = 1; i <= 6; i++) {
    const partIfte = resolvePath(vm, `fte.total.fy${i}`)[0];
    const k = fyKeys[i - 1]!;
    const fromClasses = fteTotals[k];
    // The Part I FTE row is itself computed from III.B; compare against any explicit FTE row cell instead.
    const explicit = findAll(doc, 'noteTable')
      .filter((t) => t.attrs?.role === 'expenditures-by-account')
      .flatMap((t) => (t.content ?? []).filter((r) => r.attrs?.rowKind === 'fte'))
      .flatMap((r) => r.content ?? [])
      .find((c) => c.attrs?.col === `fy${i}`);
    if (explicit && fromClasses !== undefined) {
      const shown = cellValue(explicit);
      if (shown !== null && !near(shown, fromClasses, FTE_EPS)) errors.push({ code: 'fte_3b_vs_part1', path: `fte/fy${i}`, message: `Part I FTE row (${shown}) differs from III.B total (${fromClasses}) for FY ${k}` });
    }
    void partIfte;
  }
  // Receipts total row equals the sum of account rows.
  for (const table of findAll(doc, 'noteTable').filter((t) => t.attrs?.role === 'cash-receipts' || t.attrs?.role === 'expenditures-by-account')) {
    const total = (table.content ?? []).find((r) => r.attrs?.rowKind === 'total');
    if (!total) continue;
    const rows = table.attrs?.role === 'cash-receipts' ? data.revenue : data.expenditure;
    const sums = sumRows(rows);
    for (const cell of total.content ?? []) {
      const m = /fy(\d)$/.exec(String(cell.attrs?.computed ?? ''));
      if (!m) continue;
      const k = fyKeys[Number(m[1]) - 1]!;
      const shown = cellValue(cell);
      const expected = sums[k] ?? 0;
      if (shown !== null && !near(shown, expected, EPS)) errors.push({ code: 'total_row', path: `${String(table.attrs?.role)}/total/fy${m[1]}`, message: `Total row shows ${shown}, rows sum to ${expected}` });
    }
  }

  const unfilled = unfilledSlots(doc);
  if (unfilled.length && opts.requireSlots) errors.push({ code: 'required_slots', path: 'slots', message: `${unfilled.length} required slot(s) unfilled` });
  else if (unfilled.length) warnings.push({ code: 'required_slots', path: 'slots', message: `${unfilled.length} required slot(s) unfilled` });

  return { ok: errors.length === 0, errors, warnings, unfilledSlots: unfilled };
}
