// Computed cells: `data-computed` expressions evaluated over the slot values in the document
// (templates/README.md "Slots": sum, avg, max, abs, not, nonempty, millions, thousands, direction, concat, paths, wildcards).
import { cloneDoc, formatNumber, isNumericType, parseNumber, textOf, walk, type PMNode } from './doc.js';

export type Value = number | string | boolean | null;

export interface ValueMap {
  values: Map<string, Value>;
}

function keyOf(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1');
}

/** Collect every slot value and checkbox state from a document. */
export function collectValues(doc: PMNode): ValueMap {
  const values = new Map<string, Value>();
  walk(doc, (n) => {
    const slot = n.attrs?.slot as string | undefined;
    if (n.type === 'checkbox' && slot) {
      values.set(keyOf(slot), !!n.attrs?.checked);
      return;
    }
    if (!slot) return;
    const type = n.attrs?.slotType as string | undefined;
    if (n.type === 'noteCell' || isNumericType(type)) {
      const attrVal = n.attrs?.value;
      const v = typeof attrVal === 'number' ? attrVal : parseNumber(textOf(n));
      values.set(keyOf(slot), v);
      if (n.type === 'noteCell' || isNumericType(type)) return false;
    } else if (n.type === 'bulletList' || n.type === 'orderedList') {
      values.set(keyOf(slot), (n.content ?? []).map(textOf).join('\n').trim());
      return false;
    } else {
      values.set(keyOf(slot), textOf(n).trim());
      if (n.type === 'slot') return false;
    }
    return;
  });
  return { values };
}

/** Resolve a path or wildcard path against the value map, deriving biennium sums and FTE totals. */
export function resolvePath(vm: ValueMap, path: string): Value[] {
  const key = keyOf(path);
  if (key.includes('*')) {
    const re = new RegExp('^' + key.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '$');
    const out: Value[] = [];
    const seen = new Set<string>();
    for (const k of vm.values.keys()) {
      if (re.test(k) && !seen.has(k)) {
        seen.add(k);
        out.push(vm.values.get(k) ?? null);
      }
    }
    // Derived keys (bienN, fte.total) are not stored; expand them from the fiscal years.
    const bm = /^(.*)\.bien(\d)$/.exec(key);
    if (bm && bm[1]!.includes('*')) {
      const prefixRe = new RegExp('^' + bm[1]!.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '\\.fy\\d$');
      const rows = new Set<string>();
      for (const k of vm.values.keys()) if (prefixRe.test(k)) rows.add(k.replace(/\.fy\d$/, ''));
      for (const r of rows) out.push(derived(vm, `${r}.bien${bm[2]}`));
    }
    return out;
  }
  if (vm.values.has(key)) return [vm.values.get(key) ?? null];
  const d = derived(vm, key);
  return d === null ? [] : [d];
}

function num(v: Value): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return parseNumber(v);
  return null;
}

function derived(vm: ValueMap, key: string): Value {
  const bm = /^(.*)\.bien(\d)$/.exec(key);
  if (bm) {
    const n = Number(bm[2]);
    const a = num(vm.values.get(`${bm[1]}.fy${2 * n - 1}`) ?? null);
    const b = num(vm.values.get(`${bm[1]}.fy${2 * n}`) ?? null);
    if (a === null && b === null) return null;
    return (a ?? 0) + (b ?? 0);
  }
  const fm = /^fte\.total\.fy(\d)$/.exec(key);
  if (fm) {
    let sum = 0;
    let any = false;
    for (const [k, v] of vm.values) {
      if (/^fteClass\.\d+\.fy\d$/.test(k) && k.endsWith(`.fy${fm[1]}`)) {
        const x = num(v);
        if (x !== null) {
          sum += x;
          any = true;
        }
      }
    }
    return any ? sum : null;
  }
  const fb = /^fte\.total\.bien(\d)$/.exec(key);
  if (fb) {
    const n = Number(fb[1]);
    const a = num(derived(vm, `fte.total.fy${2 * n - 1}`));
    const b = num(derived(vm, `fte.total.fy${2 * n}`));
    if (a === null && b === null) return null;
    return ((a ?? 0) + (b ?? 0)) / 2;
  }
  return null;
}

// ---------- expression parser ----------

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(?:\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      out.push({ t: 'str', v: src.slice(i + 1, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w.*[\]]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    out.push({ t: 'op', v: c });
    i++;
  }
  return out;
}

export class Evaluator {
  private toks: Tok[] = [];
  private pos = 0;
  constructor(private readonly vm: ValueMap) {}

  eval(expr: string): Value {
    this.toks = tokenize(expr);
    this.pos = 0;
    const v = this.comparison();
    return v;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private take(): Tok {
    return this.toks[this.pos++]!;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }

  private comparison(): Value {
    const left = this.additive();
    const t = this.peek();
    if (t && t.t === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(t.v)) {
      this.take();
      const right = this.additive();
      const a = num(left);
      const b = num(right);
      if (a === null || b === null) return false;
      switch (t.v) {
        case '>':
          return a > b;
        case '<':
          return a < b;
        case '>=':
          return a >= b;
        case '<=':
          return a <= b;
        case '==':
          return a === b;
        default:
          return a !== b;
      }
    }
    return left;
  }

  private additive(): Value {
    let v = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.take().v;
      const r = this.multiplicative();
      const a = num(v);
      const b = num(r);
      v = a === null && b === null ? null : op === '+' ? (a ?? 0) + (b ?? 0) : (a ?? 0) - (b ?? 0);
    }
    return v;
  }

  private multiplicative(): Value {
    let v = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.take().v;
      const r = this.unary();
      const a = num(v);
      const b = num(r);
      if (a === null) v = null;
      else if (b === null) v = null;
      else v = op === '*' ? a * b : b === 0 ? null : a / b;
    }
    return v;
  }

  private unary(): Value {
    if (this.isOp('-')) {
      this.take();
      const v = num(this.unary());
      return v === null ? null : -v;
    }
    return this.primary();
  }

  private primary(): Value {
    const t = this.take();
    if (!t) return null;
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = this.comparison();
      if (this.isOp(')')) this.take();
      return v;
    }
    if (t.t === 'id') {
      if (this.isOp('(')) {
        this.take();
        const args: Value[][] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.argument());
            if (this.isOp(',')) {
              this.take();
              continue;
            }
            break;
          }
        }
        if (this.isOp(')')) this.take();
        return this.call(t.v, args);
      }
      const vals = resolvePath(this.vm, t.v);
      return vals.length === 1 ? vals[0]! : vals.length === 0 ? null : (num(vals[0]!) ?? null);
    }
    return null;
  }

  /** A function argument: a wildcard path expands to many values. */
  private argument(): Value[] {
    const t = this.peek();
    if (t && t.t === 'id' && t.v.includes('*')) {
      this.take();
      return resolvePath(this.vm, t.v);
    }
    return [this.comparison()];
  }

  private call(name: string, args: Value[][]): Value {
    const flat = args.flat();
    const nums = flat.map(num).filter((x): x is number => x !== null);
    switch (name) {
      case 'sum':
        return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
      case 'avg':
        return nums.length ? nums.reduce((a, b) => a + b, 0) / flat.length : null;
      case 'max':
        return nums.length ? Math.max(...nums) : null;
      case 'min':
        return nums.length ? Math.min(...nums) : null;
      case 'abs':
        return nums.length === 1 ? Math.abs(nums[0]!) : nums.length ? Math.max(...nums.map(Math.abs)) : null;
      case 'not':
        return !truthy(flat[0] ?? null);
      case 'nonempty':
        return flat.some((v) => truthy(v));
      case 'millions': {
        const v = nums[0];
        return v === undefined ? null : `$${(Math.abs(v) / 1_000_000).toFixed(1)} million`;
      }
      case 'thousands': {
        const v = nums[0];
        return v === undefined ? null : `$${Math.round(Math.abs(v) / 1000).toLocaleString('en-US')},000`;
      }
      case 'direction': {
        const v = nums[0];
        return v === undefined || v === 0 ? 'does not change' : v < 0 ? 'decreases' : 'increases';
      }
      case 'concat':
        return flat.map((v) => (v === null ? '' : String(v))).join('');
      default:
        return null;
    }
  }
}

export function truthy(v: Value): boolean {
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '';
  return v;
}

export interface RecomputeResult {
  doc: PMNode;
  changed: number;
  values: ValueMap;
}

/** Evaluate every computed cell and checkbox and write the result back (text and `value` attr). Pure. */
export function recompute(input: PMNode): RecomputeResult {
  const doc = cloneDoc(input);
  const vm = collectValues(doc);
  const ev = new Evaluator(vm);
  let changed = 0;
  // Two passes so computed cells that feed others (bienN wildcards) settle.
  for (let pass = 0; pass < 2; pass++) {
    walk(doc, (n, parents) => {
      const expr = n.attrs?.computed as string | undefined;
      if (!expr) {
        // Typed numeric cells: canonical value plus formatted display text.
        if ((n.type === 'noteCell' || n.type === 'slot') && n.attrs?.slot && isNumericType(n.attrs?.slotType as string) && !n.attrs?.readonly) {
          const raw = textOf(n);
          const precision = n.attrs?.precision ? Number(n.attrs.precision) : undefined;
          const current = typeof n.attrs?.value === 'number' ? (n.attrs.value as number) : null;
          // Display text unchanged since the last canonical value: keep the value (display may round).
          if (current !== null && raw.trim() === formatNumber(current, n.attrs?.slotType as string, precision)) return;
          const parsed = parseNumber(raw);
          const formatted = formatNumber(parsed, n.attrs?.slotType as string, precision);
          if (parsed !== null && (raw.trim() !== formatted || (n.attrs?.value ?? null) !== parsed)) {
            n.content = [{ type: 'text', text: formatted }];
            n.attrs = { ...n.attrs, value: parsed };
            changed++;
          } else if (parsed === null && (n.attrs?.value ?? null) !== null) {
            n.attrs = { ...n.attrs, value: null };
            changed++;
          }
        }
        return;
      }
      let result: Value;
      try {
        result = ev.eval(expr);
      } catch {
        result = null;
      }
      if (n.type === 'checkbox') {
        const checked = truthy(result);
        if (!!n.attrs?.checked !== checked) {
          n.attrs = { ...n.attrs, checked };
          changed++;
        }
        if (n.attrs?.slot) vm.values.set(keyOf(String(n.attrs.slot)), checked);
        return;
      }
      if (n.type === 'noteCell' || n.type === 'slot' || n.type === 'paragraph') {
        const table = parents.find((p) => p.type === 'noteTable');
        const row = parents.find((p) => p.type === 'noteRow');
        const inferred = table?.attrs?.unit === 'fte' || row?.attrs?.rowKind === 'fte' || /^avg\(/.test(expr) ? 'fte' : table?.attrs?.unit === 'thousands' ? 'money-thousands' : 'money';
        const type = (n.attrs?.slotType as string | undefined) ?? (typeof result === 'number' ? inferred : null);
        const text = typeof result === 'number' ? formatNumber(result, type, n.attrs?.precision ? Number(n.attrs.precision) : undefined) : result === null || result === false ? '' : String(result === true ? 'Yes' : result);
        const prevText = textOf(n);
        const numeric = typeof result === 'number' ? result : null;
        if (prevText !== text || (n.attrs?.value ?? null) !== numeric) {
          n.content = text ? [{ type: 'text', text }] : [];
          n.attrs = { ...n.attrs, value: numeric };
          changed++;
        }
        if (n.attrs?.slot) vm.values.set(keyOf(String(n.attrs.slot)), typeof result === 'number' ? result : text);
      }
    });
  }
  return { doc, changed, values: vm };
}
