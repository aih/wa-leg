// Template token context and `{{path}}` substitution (templates/README.md "Tokens").

export interface FiscalYearLabel {
  label: string; // FY 2026
  year: number; // 2026
  yy: string; // 26
}

export interface TemplateContext {
  bill: { number: string; numberOnly: string; version: string; title: string; effectiveDate?: string; effectiveSection?: string; prefExemptSection?: string; key?: string; versionCode?: string };
  agency: { code: string; name: string };
  request: { date?: string; id?: string; tenYearRequested?: boolean };
  legContact: { name?: string; phone?: string };
  preparer: { name?: string; phone?: string; date?: string; datetime?: string };
  approver: { name?: string; phone?: string; date?: string };
  ofm: { name?: string; phone?: string; date?: string };
  session: { year: number; biennium: string };
  fy: FiscalYearLabel[]; // index 0 = fy.1
  bien: string[]; // 2025-27, 2027-29, 2029-31
  cy: string[]; // CY 2026 ...
  impl?: { date?: string; leadMonths?: number };
  impact?: { months?: { state?: string; local?: string } };
  ref: { forecast: { vintage: string }; localRate: string; aprilShare: string; octoberShare: string; salary: Record<string, string>; tes: { year: number }; priorYear: number; priorFY: string; cpi?: Record<string, string> };
  prior?: Record<string, unknown>;
  note?: { id?: string; dueDate?: string };
  fteClass?: { title: string; salary: string }[];
  [key: string]: unknown;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Resolve a dotted path with optional `[i]` indexes against the context. `fy.1` is the first fiscal year. */
export function resolveToken(path: string, ctx: Record<string, unknown>): unknown {
  const m = /^fy\.(\d+)(?:\.(year|yy|label))?$/.exec(path);
  if (m) {
    const fy = (ctx.fy as FiscalYearLabel[] | undefined)?.[Number(m[1]) - 1];
    if (!fy) return undefined;
    return m[2] === 'year' ? fy.year : m[2] === 'yy' ? fy.yy : fy.label;
  }
  const b = /^bien\.(\d+)$/.exec(path);
  if (b) return (ctx.bien as string[] | undefined)?.[Number(b[1]) - 1];
  const c = /^cy\.(\d+)$/.exec(path);
  if (c) return (ctx.cy as string[] | undefined)?.[Number(c[1]) - 1];
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const raw of parts) {
    if (cur == null) return undefined;
    const im = /^([^[]+)((?:\[\d+\])+)$/.exec(raw);
    const key = im ? im[1]! : raw;
    cur = (cur as Record<string, unknown>)[key];
    if (im) {
      for (const idx of im[2]!.match(/\d+/g) ?? []) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(idx)];
      }
    }
  }
  return cur;
}

export interface SubstitutionResult {
  html: string;
  unknownTokens: string[];
}

/** Paths that live in the note's data model rather than the context: rendered as live computed spans. */
const DATA_MODEL = /^(fte|objects|receipts|expenditures|impact|shift|cyImpact|cyShift|credit|fee|pref|tenYear|fteClass|capital|flags)\./;

/**
 * Replace every `{{path}}` with its HTML-escaped value. Data-model paths become `<span data-computed>` so they
 * follow the analyst's figures; other unknown tokens are left literal and reported.
 */
export function substituteTokens(html: string, ctx: Record<string, unknown>): SubstitutionResult {
  const unknown = new Set<string>();
  const out = html.replace(/\{\{\s*([a-zA-Z_][\w.[\]]*)\s*\}\}/g, (whole, path: string) => {
    const v = resolveToken(path, ctx);
    if (v === undefined || v === null) {
      if (DATA_MODEL.test(path)) {
        const fm = /^(.*)\.(millions|thousands)$/.exec(path);
        const expr = fm ? `${fm[2]}(${fm[1]})` : path;
        const type = fm ? 'text' : /^fte\./.test(path) ? 'fte' : /^(impact|shift|cyImpact|cyShift)\./.test(path) ? 'money-thousands' : 'money';
        return `<span data-computed="${escapeHtml(expr)}" data-type="${type}"></span>`;
      }
      unknown.add(path);
      return whole;
    }
    return escapeHtml(String(v));
  });
  return { html: out, unknownTokens: [...unknown] };
}

/** Fiscal-year, biennium and calendar-year labels for a session (odd-year session: ensuing biennium first). */
export function sessionLabels(sessionYear: number): { fy: FiscalYearLabel[]; bien: string[]; cy: string[]; biennium: string } {
  // 2025 session → FY 2026..FY 2035; 2026 session → FY 2026..FY 2035 as well (current biennium 2025-27 first).
  const start = sessionYear % 2 === 1 ? sessionYear + 1 : sessionYear;
  const fy: FiscalYearLabel[] = [];
  for (let i = 0; i < 10; i++) {
    const y = start + i;
    fy.push({ label: `FY ${y}`, year: y, yy: String(y).slice(2) });
  }
  const bienStart = sessionYear % 2 === 1 ? sessionYear : sessionYear - 1;
  const bien = [0, 2, 4].map((o) => `${bienStart + o}-${String(bienStart + o + 2).slice(2)}`);
  const cy = Array.from({ length: 6 }, (_, i) => `CY ${start + i}`);
  return { fy, bien, cy, biennium: `${bienStart}-${String(bienStart + 1).slice(2)}` };
}
