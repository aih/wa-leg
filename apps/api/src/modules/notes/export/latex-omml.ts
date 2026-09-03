// A small LaTeX subset rendered with the `docx` Math classes (OMML): fractions, sub/superscripts, roots, sums,
// brackets, common operators and Greek letters. Anything else falls back to the source text in a math run, so
// the formula stays legible in Word. Full LaTeX → OMML conversion needs an LGPL converter, which the shipped
// bundle avoids (docs/OPEN-ITEMS.md).
import { MathCurlyBrackets, MathFraction, MathRadical, MathRoundBrackets, MathRun, MathSquareBrackets, MathSubScript, MathSubSuperScript, MathSum, MathSuperScript, type MathComponent } from 'docx';

const SYMBOLS: Record<string, string> = {
  times: '×',
  cdot: '·',
  div: '÷',
  pm: '±',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  infty: '∞',
  rightarrow: '→',
  to: '→',
  leftarrow: '←',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  Delta: 'Δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  Sigma: 'Σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  percent: '%',
  ldots: '…',
  cdots: '⋯',
  quad: '  ',
  ',': ' ',
  ';': ' ',
  '\\': ' ',
  '{': '{',
  '}': '}',
  '%': '%',
  '$': '$',
  '&': '&',
  '#': '#',
  _: '_',
  '^': '^',
};

const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'min', 'max', 'sum', 'lim']);

class Parser {
  pos = 0;
  constructor(private readonly src: string) {}

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  /** Parse until `}` or end; the caller consumes the brace. */
  parseSequence(stopAt: string | null = null): MathComponent[] {
    const out: MathComponent[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(new MathRun(text));
      text = '';
    };
    while (!this.eof()) {
      const c = this.peek();
      if (stopAt && c === stopAt) break;
      if (c === '}' || c === ']' && stopAt === ']') break;
      if (c === '\\') {
        flush();
        out.push(...this.parseCommand());
        continue;
      }
      if (c === '{') {
        flush();
        this.pos++;
        const inner = this.parseSequence();
        this.expect('}');
        out.push(...inner);
        continue;
      }
      if (c === '^' || c === '_') {
        // Scripts attach to the previous component (or an empty base).
        flush();
        const base = out.length ? [out.pop()!] : [new MathRun('')];
        this.pos++;
        const script = this.parseGroup();
        let sup: MathComponent[] | null = c === '^' ? script : null;
        let sub: MathComponent[] | null = c === '_' ? script : null;
        const next = this.peek();
        if ((next === '^' && !sup) || (next === '_' && !sub)) {
          this.pos++;
          const second = this.parseGroup();
          if (next === '^') sup = second;
          else sub = second;
        }
        if (sup && sub) out.push(new MathSubSuperScript({ children: base, subScript: sub, superScript: sup }));
        else if (sup) out.push(new MathSuperScript({ children: base, superScript: sup }));
        else if (sub) out.push(new MathSubScript({ children: base, subScript: sub }));
        continue;
      }
      if (c === '(' || c === '[') {
        flush();
        this.pos++;
        const close = c === '(' ? ')' : ']';
        const inner = this.parseSequence(close);
        if (this.peek() === close) this.pos++;
        out.push(c === '(' ? new MathRoundBrackets({ children: inner }) : new MathSquareBrackets({ children: inner }));
        continue;
      }
      if (c === ')' || c === ']') {
        // Unbalanced close: emit literally.
        text += c;
        this.pos++;
        continue;
      }
      text += c;
      this.pos++;
    }
    flush();
    return out;
  }

  private expect(ch: string): void {
    if (this.peek() === ch) this.pos++;
  }

  /** `{...}` or a single token. */
  private parseGroup(): MathComponent[] {
    if (this.peek() === '{') {
      this.pos++;
      const inner = this.parseSequence();
      this.expect('}');
      return inner;
    }
    if (this.peek() === '\\') return this.parseCommand();
    const c = this.peek();
    this.pos++;
    return [new MathRun(c)];
  }

  private parseCommand(): MathComponent[] {
    this.pos++; // backslash
    let name = '';
    if (/[a-zA-Z]/.test(this.peek())) {
      while (/[a-zA-Z]/.test(this.peek())) name += this.src[this.pos++];
    } else {
      name = this.src[this.pos++] ?? '';
    }
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac': {
        const num = this.parseGroup();
        const den = this.parseGroup();
        return [new MathFraction({ numerator: num, denominator: den })];
      }
      case 'sqrt': {
        let degree: MathComponent[] | undefined;
        if (this.peek() === '[') {
          this.pos++;
          degree = this.parseSequence(']');
          this.expect(']');
        }
        return [new MathRadical({ children: this.parseGroup(), degree })];
      }
      case 'sum':
      case 'prod': {
        let sub: MathComponent[] | undefined;
        let sup: MathComponent[] | undefined;
        for (let i = 0; i < 2; i++) {
          if (this.peek() === '_') {
            this.pos++;
            sub = this.parseGroup();
          } else if (this.peek() === '^') {
            this.pos++;
            sup = this.parseGroup();
          }
        }
        // The summand is the next group; sums without one still render the operator.
        const body = this.peek() && this.peek() !== '}' ? this.parseGroup() : [new MathRun('')];
        if (name === 'prod') return [new MathRun('∏'), ...(sub ? [new MathSubScript({ children: [new MathRun('')], subScript: sub })] : []), ...body];
        return [new MathSum({ children: body, subScript: sub, superScript: sup })];
      }
      case 'text':
      case 'mathrm':
      case 'textrm':
      case 'operatorname': {
        const inner = this.parseGroup();
        return inner;
      }
      case 'left':
      case 'right':
        // \left( ... \right): the bracket characters that follow are parsed as plain brackets.
        return [];
      case 'left.':
      case 'right.':
        return [];
      default:
        break;
    }
    if (name === '{' || name === '}') return [new MathCurlyBrackets({ children: [] })];
    if (FUNCTIONS.has(name)) return [new MathRun(name + ' ')];
    if (SYMBOLS[name] !== undefined) return [new MathRun(SYMBOLS[name]!)];
    return [new MathRun(`\\${name}`)];
  }
}

/** Convert a LaTeX string to docx math components. Never throws: unknown constructs pass through as text. */
export function latexToMath(latex: string): MathComponent[] {
  try {
    const parts = new Parser(latex.trim()).parseSequence();
    return parts.length ? parts : [new MathRun(latex)];
  } catch {
    return [new MathRun(latex)];
  }
}
