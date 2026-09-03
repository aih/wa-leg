// Structured estimate data extracted from note tables at save time (editor.md section 3.3; openapi EstimateData).
import { findAll, parseNumber, textOf, type PMNode } from './doc.js';
import { collectValues, resolvePath } from './compute.js';

export interface EstimateRow {
  key: string;
  fund: string;
  fundName: string;
  source?: string;
  salary?: number | null;
  fy: Record<string, number>;
  biennia: Record<string, number>;
}

export interface EstimateData {
  revenue: EstimateRow[];
  expenditure: EstimateRow[];
  fte: EstimateRow[];
  local: EstimateRow[];
  objects: EstimateRow[];
  tenYear: { key: string; title: string; account: string; fy: Record<string, number>; total: number }[];
  flags: Record<string, boolean>;
  /** II.B series in thousands, state and local, by fiscal year. */
  series: { state: Record<string, number>; local: Record<string, number> };
  fiscalYears: number[];
  biennia: string[];
}

export interface ExtractOptions {
  /** Six fiscal years for fy1..fy6, e.g. [2026, 2027, 2028, 2029, 2030, 2031]. Derived from the tables when absent. */
  fiscalYears?: number[];
}

function yearsFromHeader(table: PMNode): number[] {
  const header = (table.content ?? []).find((r) => r.attrs?.header);
  const years: number[] = [];
  for (const c of header?.content ?? []) {
    const m = /FY\s*(\d{4})/.exec(textOf(c));
    if (m) years.push(Number(m[1]));
  }
  return years;
}

export function fiscalYearsOf(doc: PMNode, opts: ExtractOptions = {}): number[] {
  if (opts.fiscalYears?.length) return opts.fiscalYears;
  for (const t of findAll(doc, 'noteTable')) {
    const ys = yearsFromHeader(t);
    if (ys.length >= 2) {
      const start = ys[0]!;
      return Array.from({ length: 10 }, (_, i) => start + i);
    }
  }
  const y = new Date().getFullYear() + 1;
  return Array.from({ length: 10 }, (_, i) => y + i);
}

export function bienniaOf(years: number[]): string[] {
  const first = years[0] ?? 2026;
  const start = first - 1;
  return [0, 2, 4].map((o) => `${start + o}-${String(start + o + 2).slice(2)}`);
}

function rowLabel(row: PMNode): { fund: string; fundName: string; source?: string } {
  const th = (row.content ?? []).find((c) => c.attrs?.header) ?? row.content?.[0];
  const slots = th ? findAll(th, 'slot') : [];
  const account = slots.find((s) => /\.(account|title)$/.test(String(s.attrs?.slot ?? '')));
  const source = slots.find((s) => /\.source$/.test(String(s.attrs?.slot ?? '')));
  const fundName = account ? textOf(account).trim() : textOf(th).split('\n')[0]!.trim();
  return { fund: String(row.attrs?.account ?? row.attrs?.key ?? ''), fundName, source: source ? textOf(source).trim() : undefined };
}

function seriesRow(vm: ReturnType<typeof collectValues>, prefix: string, years: number[]): { fy: Record<string, number>; biennia: Record<string, number> } {
  const fy: Record<string, number> = {};
  for (let i = 1; i <= 6; i++) {
    const v = resolvePath(vm, `${prefix}.fy${i}`)[0];
    if (typeof v === 'number') fy[String(years[i - 1] ?? i)] = v;
  }
  const biennia: Record<string, number> = {};
  const b = bienniaOf(years);
  for (let n = 1; n <= 3; n++) {
    const a = fy[String(years[2 * n - 2] ?? '')];
    const c = fy[String(years[2 * n - 1] ?? '')];
    if (a !== undefined || c !== undefined) biennia[b[n - 1]!] = (a ?? 0) + (c ?? 0);
  }
  return { fy, biennia };
}

/** Extract Part I, II.B, III.A, III.B and ten-year data from a note document. */
export function extractEstimateData(doc: PMNode, opts: ExtractOptions = {}): EstimateData {
  const years = fiscalYearsOf(doc, opts);
  const biennia = bienniaOf(years);
  const vm = collectValues(doc);
  const data: EstimateData = { revenue: [], expenditure: [], fte: [], local: [], objects: [], tenYear: [], flags: {}, series: { state: {}, local: {} }, fiscalYears: years.slice(0, 6), biennia };
  const seenKeys = new Set<string>();
  for (const table of findAll(doc, 'noteTable')) {
    const role = String(table.attrs?.role ?? '');
    const rows = (table.content ?? []).filter((r) => !r.attrs?.header && !r.attrs?.footer);
    if (role === 'cash-receipts' || role === 'expenditures-by-account') {
      for (const row of rows) {
        if (row.attrs?.rowKind === 'fte') continue;
        const slotCell = findAll(row, 'noteCell').find((c) => c.attrs?.slot);
        const prefix = slotCell ? String(slotCell.attrs!.slot).replace(/\.fy\d$/, '') : null;
        if (!prefix) continue;
        const label = rowLabel(row);
        const series = seriesRow(vm, prefix, years);
        const entry: EstimateRow = { key: String(row.attrs?.key ?? prefix.split('.').pop()), fund: label.fund, fundName: label.fundName, ...series };
        if (label.source) entry.source = label.source;
        (role === 'cash-receipts' ? data.revenue : data.expenditure).push(entry);
        seenKeys.add(prefix);
      }
    } else if (role === 'fte-by-class') {
      for (const row of rows) {
        const slotCell = findAll(row, 'noteCell').find((c) => c.attrs?.slot && /\.fy\d$/.test(String(c.attrs.slot)));
        if (!slotCell) continue;
        const prefix = String(slotCell.attrs!.slot).replace(/\.fy\d$/, '');
        const titleSlot = findAll(row, 'slot').find((s) => /\.title$/.test(String(s.attrs?.slot ?? '')));
        const salaryCell = findAll(row, 'noteCell').find((c) => /\.salary$/.test(String(c.attrs?.slot ?? '')));
        const series = seriesRow(vm, prefix, years);
        const bienAvg: Record<string, number> = {};
        for (const [k, v] of Object.entries(series.biennia)) bienAvg[k] = v / 2;
        const title = titleSlot ? textOf(titleSlot).trim() : textOf(row.content?.[0]).trim();
        if (!title && Object.keys(series.fy).length === 0) continue;
        data.fte.push({ key: prefix, fund: title, fundName: title, salary: salaryCell ? (typeof salaryCell.attrs?.value === 'number' ? salaryCell.attrs.value : parseNumber(textOf(salaryCell))) : null, fy: series.fy, biennia: bienAvg });
      }
    } else if (role === 'expenditures-by-object') {
      for (const row of rows) {
        const slotCell = findAll(row, 'noteCell').find((c) => c.attrs?.slot && /\.fy\d$/.test(String(c.attrs.slot)));
        if (!slotCell) continue;
        const prefix = String(slotCell.attrs!.slot).replace(/\.fy\d$/, '');
        const label = textOf(row.content?.[0]).trim();
        const series = seriesRow(vm, prefix, years);
        data.objects.push({ key: String(row.attrs?.object ?? row.attrs?.key ?? prefix.split('.').pop()), fund: label, fundName: label, ...series });
      }
    } else if (role === 'impact-series') {
      const scope = String(table.attrs?.scope ?? '');
      const target = scope.startsWith('impact.local') ? data.series.local : scope.startsWith('impact.state') ? data.series.state : null;
      if (target) {
        // Row i holds fiscal year i; value from the input slot or the computed cell.
        rows.forEach((row, i) => {
          const cell = (row.content ?? []).find((c) => !c.attrs?.header);
          if (!cell) return;
          const v = typeof cell.attrs?.value === 'number' ? (cell.attrs.value as number) : parseNumber(textOf(cell));
          if (v !== null) target[String(years[i] ?? i + 1)] = v;
        });
      }
      if (scope.startsWith('impact.local')) {
        const series = seriesRow(vm, 'impact.local', years);
        if (Object.keys(series.fy).length) data.local.push({ key: 'local', fund: 'local', fundName: 'Local Government', ...series });
      }
    } else if (role === 'ten-year-analysis') {
      for (const row of rows) {
        const cells = findAll(row, 'noteCell');
        const slotCell = cells.find((c) => c.attrs?.slot && /\.fy\d+$/.test(String(c.attrs.slot)));
        if (!slotCell) continue;
        const prefix = String(slotCell.attrs!.slot).replace(/\.fy\d+$/, '');
        const fy: Record<string, number> = {};
        let total = 0;
        for (let i = 1; i <= 10; i++) {
          const v = resolvePath(vm, `${prefix}.fy${i}`)[0];
          if (typeof v === 'number') {
            fy[String(years[i - 1] ?? i)] = v;
            total += v;
          }
        }
        const titleSlot = findAll(row, 'slot').find((s) => /\.title$/.test(String(s.attrs?.slot ?? '')));
        const acctSlot = findAll(row, 'slot').find((s) => /\.account$/.test(String(s.attrs?.slot ?? '')));
        data.tenYear.push({ key: prefix, title: titleSlot ? textOf(titleSlot).trim() : textOf(cells[0]).trim(), account: acctSlot ? textOf(acctSlot).trim() : '', fy, total });
      }
    }
  }
  for (const cb of findAll(doc, 'checkbox')) {
    const slot = cb.attrs?.slot as string | undefined;
    if (slot) data.flags[slot.replace(/^flags\./, '')] = !!cb.attrs?.checked;
  }
  const ind = vm.values.get('flags.indeterminateReceipts');
  if (ind !== undefined) data.flags.indeterminateReceipts = !!ind;
  return data;
}
