// Parser for lawfilesext bill XML (namespace http://leg.wa.gov/2012/document) into a Bill Document.
// This is the only code that knows the WA XML vocabulary (design/research/leg-wa-gov-services.md "XML schema").
import { longLabel, versionSeq, type BillType } from '@wa-leg/billref';
import { parseXml, child, children, childText, isNode, textOf, find, findAll, type XNode } from './xmldom.js';
import type {
  BillDocument,
  BillSection,
  BillTypeCode,
  Block,
  BlockKind,
  Certificate,
  RcwAffected,
  RepealedEntry,
  Run,
  SectionKind,
  SectionTarget,
  SourceSectionKind,
  TableCell,
  TableData,
} from './types.js';
import { changeSummary, normalizeSpace, textHash } from './hash.js';
import { assignIdentities } from './identity.js';
import { parseTitle, rcwHref } from './title.js';

export const PARSER_NAME = 'wa-bill-xml';
export const PARSER_VERSION = '1.0.0';

export interface ParseMeta {
  biennium: string;
  type: BillType;
  number: number;
  versionCode: string;
  sourceUrl?: string;
  sourceHash?: string;
  fetchedAt?: string;
  /** Engrossed level for PL/SL labels when known from the version list. */
  engrossedLevel?: number;
  date?: string;
  isCurrent?: boolean;
}

export function billTypeCode(type: BillType): BillTypeCode {
  switch (type) {
    case 'HB':
    case 'SB':
      return 'B';
    case 'HJR':
    case 'SJR':
      return 'JR';
    case 'HJM':
    case 'SJM':
      return 'JM';
    case 'HCR':
    case 'SCR':
      return 'CR';
    default:
      return 'R';
  }
}

// ---------- runs ----------

interface RunCtx {
  mark: 'text' | 'ins' | 'del';
  veto: boolean;
}

interface ParsedP {
  runs: Run[];
  /** Label found on a RepealNumber child. */
  repealLabel?: string;
}

function pushRun(out: Run[], run: Run): void {
  if (!run.text && run.t !== 'cite') return;
  const last = out[out.length - 1];
  if (last && last.t === run.t && run.t !== 'cite' && !last.cite && (last as any).veto === (run as any).veto) {
    last.text += run.text;
    return;
  }
  out.push(run);
}

function citeFromNode(n: XNode): { kind: 'rcw' | 'rcw-chapter' | 'rcw-title' | 'session-law'; cite: string } | null {
  const title = childText(n, 'TitleNumber');
  const chapter = childText(n, 'ChapterNumber');
  const section = childText(n, 'SectionNumber');
  if (n.tag === 'SectionCite' && title && chapter && section) return { kind: 'rcw', cite: `${title}.${chapter}.${section}` };
  if (n.tag === 'ChapterCite' && title && chapter) return { kind: 'rcw-chapter', cite: `${title}.${chapter}` };
  if (n.tag === 'TitleCite' && title) return { kind: 'rcw-title', cite: title };
  if (n.tag === 'UncodCite') return { kind: 'session-law', cite: normalizeSpace(textOf(n)) };
  if (n.tag === 'SectionCite' && title && chapter) return { kind: 'rcw-chapter', cite: `${title}.${chapter}` };
  return null;
}

function runsOf(nodes: Array<XNode | string>, ctx: RunCtx, out: Run[], parsed?: ParsedP): Run[] {
  for (const c of nodes) {
    if (typeof c === 'string') {
      const r: Run = { t: ctx.mark, text: c };
      if (ctx.veto) (r as any).veto = true;
      pushRun(out, r);
      continue;
    }
    switch (c.tag) {
      case 'TextRun': {
        const style = c.attrs.amendingStyle;
        const veto = ctx.veto || c.attrs.lineVeto === 'yes';
        if (style === 'add') {
          runsOf(c.children, { mark: 'ins', veto }, out, parsed);
        } else if (style === 'strike') {
          pushRun(out, vetoed({ t: 'del', text: '((' }, veto));
          runsOf(c.children, { mark: 'del', veto }, out, parsed);
          pushRun(out, vetoed({ t: 'del', text: '))' }, veto));
        } else if (style === 'strikemarkleft') {
          pushRun(out, vetoed({ t: 'del', text: '((' }, veto));
          runsOf(c.children, { mark: 'del', veto }, out, parsed);
        } else if (style === 'strikemarknone') {
          runsOf(c.children, { mark: 'del', veto }, out, parsed);
        } else if (style === 'strikemarkright') {
          runsOf(c.children, { mark: 'del', veto }, out, parsed);
          pushRun(out, vetoed({ t: 'del', text: '))' }, veto));
        } else {
          runsOf(c.children, { ...ctx, veto }, out, parsed);
        }
        break;
      }
      case 'SectionCite':
      case 'ChapterCite':
      case 'TitleCite':
      case 'UncodCite': {
        const info = citeFromNode(c);
        const text = textOf(c);
        if (info) {
          const r: Run = { t: 'cite', text, cite: { kind: info.kind, text: normalizeSpace(text), cite: info.cite } };
          if (info.kind !== 'session-law') r.cite!.href = rcwHref(info.cite);
          if (ctx.mark !== 'text') r.mark = ctx.mark;
          if (ctx.veto) (r as any).veto = true;
          out.push(r);
        } else {
          pushRun(out, vetoed({ t: ctx.mark, text }, ctx.veto));
        }
        break;
      }
      case 'Hyphen': {
        const style = c.attrs.amendingStyle;
        pushRun(out, vetoed({ t: style === 'strikemarknone' ? 'del' : ctx.mark, text: '-' }, ctx.veto));
        break;
      }
      case 'RepealNumber': {
        if (parsed) parsed.repealLabel = `(${textOf(c).trim()})`;
        break;
      }
      case 'Value':
      case 'Caption':
      case 'BillSectionNumber':
        break;
      default:
        runsOf(c.children, ctx, out, parsed);
    }
  }
  return out;
}

function vetoed(r: Run, veto: boolean): Run {
  if (veto) (r as any).veto = true;
  return r;
}

function parseP(p: XNode): ParsedP {
  const parsed: ParsedP = { runs: [] };
  runsOf(p.children, { mark: 'text', veto: false }, parsed.runs, parsed);
  return parsed;
}

// ---------- subsection markers ----------

const MARKER_RE = /^\((\d{1,3}|[a-z]{1,4}|[A-Z]{1,4})\)/;

interface Marker {
  key: string;
  label: string;
}

/** Leading designators of a paragraph: "(1)(a)(i)" → three markers. Returns the run index and char offset after them. */
function leadingMarkers(runs: Run[]): { markers: Marker[]; mark?: 'ins' | 'del'; runIndex: number; offset: number } | null {
  let idx = 0;
  while (idx < runs.length && !runs[idx]!.text.trim()) idx++;
  const first = runs[idx];
  if (!first) return null;
  if (first.t === 'cite') return null;
  let text = first.text;
  let prefix = 0;
  if (first.t === 'del') {
    if (!text.startsWith('((')) return null;
    text = text.slice(2);
    prefix = 2;
  }
  const lead = /^\s*/.exec(text)![0].length;
  text = text.slice(lead);
  const markers: Marker[] = [];
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text.slice(consumed)))) {
    markers.push({ key: m[1]!, label: m[0] });
    consumed += m[0].length;
    if (markers.length >= 4) break;
  }
  if (markers.length === 0) return null;
  const after = text.slice(consumed);
  if (first.t === 'del') {
    // A struck designator must be the whole struck run: "((3))" then the rest of the line.
    if (!after.startsWith('))')) return null;
    return { markers, mark: 'del', runIndex: idx, offset: prefix + lead + consumed + 2 };
  }
  // The designator must be followed by whitespace, end of run, or a struck/inserted run.
  if (after && !/^\s/.test(after)) return null;
  const res: { markers: Marker[]; mark?: 'ins' | 'del'; runIndex: number; offset: number } = { markers, runIndex: idx, offset: prefix + lead + consumed };
  if (first.t === 'ins') res.mark = 'ins';
  return res;
}

function isRomanLower(k: string): boolean {
  return /^[ivxl]+$/.test(k);
}
function isRomanUpper(k: string): boolean {
  return /^[IVXL]+$/.test(k);
}
function prevLetter(k: string): string {
  return String.fromCharCode(k.charCodeAt(k.length - 1) - 1);
}

const KINDS: BlockKind[] = ['subsection', 'paragraph', 'subparagraph', 'item', 'subitem'];

class BlockTree {
  readonly root: Block[] = [];
  private stack: Block[] = [];
  private unlabeled = new Map<string, number>();
  private ids = new Set<string>();

  constructor(private readonly sectionId: string) {}

  private uniqueId(base: string): string {
    let id = base;
    let n = 2;
    while (this.ids.has(id)) id = `${base}_${n++}`;
    this.ids.add(id);
    return id;
  }

  /** Decide the level of one designator given the open stack. */
  private levelFor(key: string, chainLevel: number | null): number {
    if (chainLevel !== null) return chainLevel + 1;
    if (/^\d+$/.test(key)) return 1;
    const open = (level: number) => this.stack.find((b) => b.level === level);
    if (/^[a-z]+$/.test(key)) {
      if (isRomanLower(key)) {
        const l2 = open(2);
        const l2key = l2?.label?.replace(/[()]/g, '');
        // (i) after (h), (v) after (u), (x) after (w), (l) after (k): a letter, not a numeral.
        if (l2key && prevLetter(key) === l2key && key.length === 1) return 2;
        if (l2key && key.length > 1 && /^[a-z]$/.test(l2key) && key === l2key + l2key) return 2; // (aa) style
        return open(2) ? 3 : 2;
      }
      return 2;
    }
    if (/^[A-Z]+$/.test(key)) {
      if (isRomanUpper(key)) {
        const l4 = open(4);
        const l4key = l4?.label?.replace(/[()]/g, '');
        if (l4key && prevLetter(key) === l4key && key.length === 1) return 4;
        return open(4) ? 5 : 4;
      }
      return 4;
    }
    return 1;
  }

  private attach(b: Block): void {
    while (this.stack.length && this.stack[this.stack.length - 1]!.level >= b.level) this.stack.pop();
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.children.push(b);
    else this.root.push(b);
    this.stack.push(b);
  }

  addLabeled(markers: Marker[], mark: 'ins' | 'del' | undefined, runs: Run[], align?: string): Block {
    let chainLevel: number | null = null;
    let last: Block | null = null;
    markers.forEach((m, i) => {
      const level = this.levelFor(m.key, chainLevel);
      chainLevel = level;
      // Pop to the parent for this level.
      while (this.stack.length && this.stack[this.stack.length - 1]!.level >= level) this.stack.pop();
      const parent = this.stack[this.stack.length - 1];
      const id = this.uniqueId(`${parent ? parent.id : this.sectionId}.${m.key}`);
      const isLast = i === markers.length - 1;
      const b: Block = {
        id,
        label: m.label,
        level,
        kind: KINDS[Math.min(level, KINDS.length) - 1]!,
        runs: isLast ? runs : [],
        children: [],
      };
      if (mark) b.labelMark = mark;
      if (isLast && align && align !== 'left') b.align = align as Block['align'];
      this.attach(b);
      last = b;
    });
    return last!;
  }

  addUnlabeled(runs: Run[], kind: BlockKind = 'unnumbered', extra: Partial<Block> = {}): Block {
    const parent = this.stack[this.stack.length - 1];
    const parentId = parent ? parent.id : this.sectionId;
    const n = (this.unlabeled.get(parentId) ?? 0) + 1;
    this.unlabeled.set(parentId, n);
    const b: Block = { id: this.uniqueId(`${parentId}.p${n}`), level: parent ? parent.level + 1 : 1, kind, runs, children: [], ...extra };
    if (parent) parent.children.push(b);
    else this.root.push(b);
    return b;
  }
}

function addParagraph(tree: BlockTree, p: XNode): void {
  const parsed = parseP(p);
  const runs = parsed.runs;
  const align = p.attrs.textAlign;
  if (parsed.repealLabel) {
    trimLeading(runs);
    tree.addLabeled([{ key: parsed.repealLabel.replace(/[()]/g, ''), label: parsed.repealLabel }], undefined, runs, align);
    return;
  }
  const lm = leadingMarkers(runs);
  if (!lm) {
    trimLeading(runs);
    if (runs.length === 0) return;
    const extra: Partial<Block> = {};
    if (align && align !== 'left') extra.align = align as Block['align'];
    tree.addUnlabeled(runs, 'unnumbered', extra);
    return;
  }
  // Remove the designator text from the first run.
  const first = runs[lm.runIndex]!;
  let restText = first.text.slice(lm.offset);
  if (lm.mark === 'del' && restText === '') runs.splice(lm.runIndex, 1);
  else {
    if (lm.mark === 'del') restText = '((' + restText; // struck text continues after the designator
    first.text = restText;
    if (!first.text) runs.splice(lm.runIndex, 1);
  }
  // A struck designator followed by an inserted one is a renumbering: keep the struck text, label with the new one.
  if (lm.mark === 'del') {
    const next = runs[lm.runIndex];
    if (next && next.t === 'ins') {
      const nm = leadingMarkers([next]);
      if (nm) {
        next.text = next.text.slice(nm.offset);
        if (!next.text) runs.splice(lm.runIndex, 1);
        runs.splice(lm.runIndex, 0, { t: 'del', text: lm.markers.map((m) => `((${m.label}))`).join('') });
        trimLeading(runs.slice(lm.runIndex + 1));
        tree.addLabeled(nm.markers, 'ins', runs, align);
        return;
      }
    }
  }
  trimLeading(runs);
  tree.addLabeled(lm.markers, lm.mark, runs, align);
}

function trimLeading(runs: Run[]): void {
  while (runs.length) {
    const r = runs[0]!;
    r.text = r.text.replace(/^\s+/, '');
    if (r.text || r.t === 'cite') break;
    runs.shift();
  }
  if (runs.length) {
    const last = runs[runs.length - 1]!;
    last.text = last.text.replace(/\s+$/, '');
    if (!last.text && last.t !== 'cite') runs.pop();
  }
}

// ---------- tables ----------

function parseTable(t: XNode): TableData {
  const rows: TableCell[][] = [];
  const rowOf = (tr: XNode, header: boolean): TableCell[] =>
    children(tr).filter((c) => c.tag === 'TD' || c.tag === 'TDEnroll').map((td) => {
      const runs: Run[] = [];
      const ps = children(td, 'P');
      ps.forEach((p, i) => {
        if (i > 0) pushRun(runs, { t: 'text', text: ' ' });
        runsOf(p.children, { mark: 'text', veto: false }, runs);
      });
      if (ps.length === 0) runsOf(td.children, { mark: 'text', veto: false }, runs);
      trimLeading(runs);
      const cell: TableCell = { runs };
      if (td.attrs.colspan) cell.colspan = Number(td.attrs.colspan);
      if (td.attrs.rowspan) cell.rowspan = Number(td.attrs.rowspan);
      if (td.attrs.textAlign === 'center' || td.attrs.textAlign === 'right') cell.align = td.attrs.textAlign;
      if (header) cell.header = true;
      return cell;
    });
  for (const c of children(t)) {
    if (c.tag === 'THead') for (const tr of children(c, 'TR')) rows.push(rowOf(tr, true));
    else if (c.tag === 'TR') rows.push(rowOf(c, false));
  }
  return { rows };
}

// ---------- sections ----------

function sourceKindOf(sec: XNode): SourceSectionKind {
  const type = sec.attrs.type;
  const action = sec.attrs.action;
  if (action) {
    const known: SourceSectionKind[] = ['addsect', 'addchap', 'amend', 'remd', 'amenduncod', 'repeal', 'effdate', 'emerg', 'expdate'];
    if (known.includes(action as SourceSectionKind)) return action as SourceSectionKind;
    return 'other';
  }
  if (type === 'new') return 'new';
  if (type === 'amendatory') return 'amend';
  return 'other';
}

export function classifyNew(text: string): SectionKind {
  const t = text.toLowerCase();
  if (/takes? effect immediately|immediate preservation of the public peace/.test(t)) return 'emergency';
  if (/held invalid, the remainder|severab/.test(t)) return 'severability';
  if (/\bexpires?\b.*\bof this act\b|\bof this act\b.*\bexpires?\b/.test(t)) return 'expiration';
  if (/takes? effect .*(?:contingent|only if|if\b)|null and void/.test(t)) return 'contingent';
  if (/the sum of \$|is appropriated|appropriations? (?:is|are) made/.test(t)) return 'appropriation';
  if (/legislature finds|legislature intends|it is the intent|the intent of the legislature/.test(t)) return 'intent';
  return 'new';
}

function parseSection(sec: XNode, index: number, part: { label: string; heading?: string } | undefined, warnings: string[]): BillSection {
  const header = child(sec, 'BillSectionHeader');
  const numNode = header ? find(header, 'BillSectionNumber') : undefined;
  const valueNode = numNode ? child(numNode, 'Value') : undefined;
  let num = valueNode ? textOf(valueNode).trim() : String(index + 1);
  if (!num) num = String(index + 1);
  const fixed = valueNode?.attrs.fixed === 'true';
  const id = `sec-${num.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const sourceKind = sourceKindOf(sec);
  const isNew = sec.attrs.type === 'new' || sourceKind === 'repeal';
  const label = `${isNew ? 'NEW SECTION. ' : ''}Sec. ${num}.`;

  const tree = new BlockTree(id);
  const target: SectionTarget | undefined = (() => {
    switch (sourceKind) {
      case 'amend':
        return { action: 'amend' };
      case 'remd':
        return { action: 'reenact-amend' };
      case 'amenduncod':
        return { action: 'amend' };
      case 'addsect':
      case 'addchap':
        return { action: 'add' };
      case 'repeal':
        return { action: 'repeal' };
      default:
        return undefined;
    }
  })();

  // Header: intro text (everything except the number, caption, and header paragraphs) and the cite.
  const introRuns: Run[] = [];
  let heading: string | undefined;
  const headerPs: XNode[] = [];
  if (header) {
    for (const c of header.children) {
      if (typeof c === 'string') {
        pushRun(introRuns, { t: 'text', text: c });
        continue;
      }
      if (c.tag === 'BillSectionNumber') continue;
      if (c.tag === 'Caption') {
        heading = normalizeSpace(textOf(c));
        continue;
      }
      if (c.tag === 'P') {
        headerPs.push(c);
        continue;
      }
      runsOf([c], { mark: 'text', veto: false }, introRuns);
    }
  }
  trimLeading(introRuns);
  // Cite from intro runs or header paragraphs.
  const citeRun = introRuns.find((r) => r.t === 'cite') ?? undefined;
  if (target) {
    const citeNode = header ? find(header, 'SectionCite') ?? find(header, 'ChapterCite') ?? find(header, 'TitleCite') ?? find(header, 'UncodCite') : undefined;
    const info = citeNode ? citeFromNode(citeNode) : null;
    if (info?.kind === 'rcw') {
      target.cite = info.cite;
      target.chapter = info.cite.split('.').slice(0, 2).join('.');
      target.href = rcwHref(info.cite);
    } else if (info?.kind === 'rcw-chapter') {
      target.chapter = info.cite;
      target.href = rcwHref(info.cite);
    } else if (info?.kind === 'rcw-title') {
      target.title = info.cite;
      target.href = rcwHref(info.cite);
    } else if (info?.kind === 'session-law') {
      target.uncodified = info.cite;
    }
    if (heading) target.caption = heading;
    const introText = introRuns.map((r) => r.text).join('');
    const hm = /(?:^|\s)and\s+(.+?)\s+(?:is|are)\s+each\s+(?:reenacted and )?amended/i.exec(introText) ?? /\)\s*(?:and\s+)?(.+?)\s+(?:is|are)\s+(?:each\s+)?(?:reenacted and )?amended/i.exec(introText);
    if (hm && target.action !== 'add' && target.action !== 'repeal') target.history = normalizeSpace(hm[1]!);
    void citeRun;
  }

  // Body blocks: header paragraphs first (new sections carry the first paragraph in the header).
  for (const p of headerPs) addParagraph(tree, p);
  const notes: string[] = [];
  for (const c of sec.children) {
    if (!isNode(c)) continue;
    switch (c.tag) {
      case 'BillSectionHeader':
        break;
      case 'P':
        addParagraph(tree, c);
        break;
      case 'Table': {
        const table = parseTable(c);
        tree.addUnlabeled([], 'table', { table });
        break;
      }
      case 'History': {
        const h = normalizeSpace(textOf(c));
        if (h) notes.push(h);
        break;
      }
      case 'RCWNoteSection': {
        for (const n of findAll(c, 'NoteP')) {
          const t = normalizeSpace(textOf(n));
          if (t) notes.push(t);
        }
        break;
      }
      case 'SeeVetoNote':
        notes.push(normalizeSpace(textOf(c)));
        break;
      default:
        warnings.push(`section ${num}: unhandled element ${c.tag}`);
    }
  }

  // Repealer entries.
  if (target?.action === 'repeal') {
    const repealed: RepealedEntry[] = [];
    const headerCite = header ? find(header, 'SectionCite') : undefined;
    const candidates = [...headerPs, ...children(sec, 'P')].filter((p) => find(p, 'SectionCite') || (headerCite && headerPs.includes(p)));
    for (const p of candidates) {
      const cite = find(p, 'SectionCite') ?? headerCite;
      const info = cite ? citeFromNode(cite) : null;
      const text = normalizeSpace(textOf(p));
      const cap = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(text.replace(/^\d+\s*/, '').replace(/^RCW\s+[\d.A-Za-z]+\s*/, ''));
      const hist = /\)\s+and\s+(.+?);?$/.exec(text);
      const entry: RepealedEntry = { cite: info?.cite ?? text };
      if (cap?.[1]) entry.caption = cap[1];
      if (hist?.[1]) entry.history = hist[1].replace(/;$/, '');
      if (info) entry.href = rcwHref(info.cite);
      repealed.push(entry);
    }
    if (repealed.length === 0 && target.cite) {
      const entry: RepealedEntry = { cite: target.cite, href: rcwHref(target.cite) };
      if (heading) entry.caption = heading;
      repealed.push(entry);
    }
    target.repealed = repealed;
  }

  const blocks = tree.root;
  const section: BillSection = {
    id,
    num,
    label,
    isNewSection: isNew,
    kind: 'other',
    sourceKind,
    identity: '',
    blocks,
    textHash: '',
  };
  if (heading) section.heading = heading;
  if (part) section.part = part;
  if (target) section.target = target;
  if (introRuns.length) section.introText = introRuns;
  if (notes.length) section.notes = notes;
  if (fixed) section.fixedNumber = true;
  if (sec.attrs.veto) section.veto = true;

  const bodyText = blocks.map((b) => blockPlain(b)).join(' ');
  section.kind = (() => {
    switch (sourceKind) {
      case 'amend':
      case 'remd':
      case 'amenduncod':
        return 'amendatory';
      case 'addsect':
      case 'addchap':
        return 'new';
      case 'repeal':
        return 'repealer';
      case 'effdate':
        return 'effective-date';
      case 'emerg':
        return 'emergency';
      case 'expdate':
        return 'expiration';
      case 'new':
        return classifyNew(bodyText);
      default:
        return 'other';
    }
  })();
  section.textHash = textHash(section);
  const cs = changeSummary(blocks);
  if (cs.insWords || cs.delWords) section.changeSummary = cs;
  return section;
}

function blockPlain(b: Block): string {
  return [b.label ?? '', ...b.runs.map((r) => r.text), ...b.children.map(blockPlain)].join(' ');
}

// ---------- certificate ----------

function parseCertificate(cert: XNode | undefined, slHistory: XNode | undefined): Certificate | undefined {
  if (!cert && !slHistory) return undefined;
  const out: Certificate = {};
  if (cert) {
    const ch = child(cert, 'ChapterLaw');
    if (ch) {
      out.chapter = Number(textOf(ch).trim());
      if (ch.attrs.year) out.year = Number(ch.attrs.year);
    }
    const cap = childText(cert, 'SessionLawCaption');
    if (cap) out.caption = cap;
    const eff = child(cert, 'EffectiveDate');
    if (eff) out.effectiveDate = normalizeSpace(textOf(eff));
    if (child(cert, 'VetoAction')) out.partialVeto = true;
    const passed: NonNullable<Certificate['passed']> = [];
    for (const pb of findAll(cert, 'PassedBy')) {
      const date = childText(pb, 'PassedDate');
      if (!date) continue;
      const entry: NonNullable<Certificate['passed']>[number] = { chamber: pb.attrs.chamber?.toLowerCase() === 'h' ? 'H' : 'S', date };
      const yeas = childText(pb, 'Yeas');
      const nays = childText(pb, 'Nays');
      if (yeas) entry.yeas = Number(yeas);
      if (nays) entry.nays = Number(nays);
      passed.push(entry);
    }
    if (passed.length) out.passed = passed;
    const approved = find(cert, 'ApprovedDate');
    if (approved && textOf(approved).trim()) out.approvedDate = textOf(approved).trim();
    const filed = find(cert, 'FiledDate');
    if (filed && textOf(filed).trim()) out.filedDate = textOf(filed).trim();
    const gov = find(cert, 'Governor');
    if (gov && textOf(gov).trim()) out.governor = textOf(gov).trim();
  }
  if (slHistory) {
    out.history = children(slHistory, 'P').map((p) => normalizeSpace(textOf(p))).filter(Boolean);
  }
  return out;
}

// ---------- document ----------

export function parseBillXml(xml: string, meta: ParseMeta): BillDocument {
  const root = parseXml(xml);
  const warnings: string[] = [];
  let billNode: XNode;
  let certificate: Certificate | undefined;
  if (root.tag === 'CertifiedBill') {
    billNode = child(root, 'Bill') ?? root;
    certificate = parseCertificate(child(root, 'EnrollingCertificate'), child(root, 'SLHistory'));
  } else if (root.tag === 'Bill') {
    billNode = root;
  } else {
    throw new Error(`Unexpected root element ${root.tag}`);
  }
  const heading = child(billNode, 'BillHeading');
  const body = child(billNode, 'BillBody');
  if (!body) throw new Error('BillBody missing');

  const titleText = normalizeSpace(textOf(child(body, 'BillTitle')));
  const parsedTitle = parseTitle(titleText);
  const sponsorsText = heading ? childText(heading, 'Sponsors') : undefined;
  const readDate = heading ? childText(child(heading, 'BillHistory') ?? heading, 'ReadDate') : undefined;
  const longBillId = heading ? childText(heading, 'LongBillId') : undefined;

  const header: BillDocument['header'] = { title: titleText };
  if (parsedTitle.relatingTo) header.relatingTo = parsedTitle.relatingTo;
  if (parsedTitle.actions.length) header.titleActions = parsedTitle.actions;
  if (sponsorsText) {
    header.sponsors = [sponsorsText];
    const byReq = /by request of (.+?)\)?$/i.exec(sponsorsText);
    if (byReq) header.byRequestOf = byReq[1]!.replace(/\)$/, '');
  }
  if (heading) {
    const brief = childText(heading, 'BriefDescription');
    if (brief) header.briefDescription = brief;
    const req = childText(heading, 'RequestNumber');
    if (req) header.requestNumber = req;
    const sid = childText(heading, 'ShortBillId');
    if (sid) header.shortBillId = sid;
    if (longBillId) header.longBillId = longBillId;
    const leg = childText(heading, 'Legislature');
    if (leg) header.legislature = leg;
    const ses = childText(heading, 'Session');
    if (ses) header.session = ses;
    const asAmended = childText(heading, 'AsAmended');
    if (asAmended) header.asAmended = asAmended;
    const hist = child(heading, 'BillHistory');
    if (hist) {
      const pre = childText(hist, 'PrefiledDate');
      if (pre) header.prefiledDate = pre;
      const ref = childText(hist, 'ReferredCommittee');
      if (ref) header.referredTo = ref;
    }
  }
  if (readDate) {
    const m = /(\d{2})\/(\d{2})\/(\d{2})/.exec(readDate);
    if (m) header.readFirstTime = `20${m[3]}-${m[1]}-${m[2]}`;
  }

  // Sections, with Part headings carried along.
  const sections: BillSection[] = [];
  const parts: { label: string; heading?: string }[] = [];
  let currentPart: { label: string; heading?: string } | undefined;
  let index = 0;
  const walkBody = (node: XNode) => {
    for (const c of children(node)) {
      if (c.tag === 'Part') {
        const ps = children(c, 'P').map((p) => normalizeSpace(textOf(p))).filter(Boolean);
        if (ps.length) {
          currentPart = ps[1] ? { label: ps[0]!, heading: ps[1] } : { label: ps[0]! };
          parts.push(currentPart);
        }
        walkBody(c); // sections may be nested inside Part
      } else if (c.tag === 'BillSection') {
        sections.push(parseSection(c, index++, currentPart, warnings));
      }
    }
  };
  walkBody(body);
  if (parts.length) header.parts = parts;
  assignIdentities(sections);

  // Engrossed level from LongBillId ("SECOND ENGROSSED SUBSTITUTE ...") for PL/SL labels.
  let engrossed = meta.engrossedLevel;
  if (engrossed === undefined && longBillId) {
    const m = /^(?:(SECOND|THIRD|FOURTH)\s+)?ENGROSSED\b/i.exec(longBillId);
    if (m) engrossed = m[1] ? { SECOND: 2, THIRD: 3, FOURTH: 4 }[m[1].toUpperCase()]! : 1;
  }

  const doc: BillDocument = {
    schemaVersion: '1.0',
    bill: {
      biennium: meta.biennium,
      chamber: meta.type.startsWith('H') ? 'H' : 'S',
      type: billTypeCode(meta.type),
      number: meta.number,
      id: `${meta.type}${meta.number}`,
      billPageUrl: `https://app.leg.wa.gov/billsummary?BillNumber=${meta.number}&Year=${meta.biennium.slice(0, 4)}&Initiative=false`,
    },
    version: {
      code: meta.versionCode,
      label: longLabel(meta.type, meta.versionCode, engrossed),
      seq: versionSeq(meta.versionCode),
    },
    header,
    sections,
    rcwAffected: deriveRcwAffected(sections),
    provenance: {
      fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
      parser: PARSER_NAME,
      parserVersion: PARSER_VERSION,
      warnings,
      hasLineNumbers: false,
    },
  };
  if (header.briefDescription) doc.bill.shortTitle = header.briefDescription;
  if (meta.date) doc.version.date = meta.date;
  if (meta.isCurrent !== undefined) doc.version.isCurrent = meta.isCurrent;
  if (meta.sourceUrl) {
    doc.version.sourceUrls = {
      xml: meta.sourceUrl,
      htm: meta.sourceUrl.replace('/Xml/', '/Htm/').replace(/\.xml$/, '.htm'),
      pdf: meta.sourceUrl.replace('/Xml/', '/Pdf/').replace(/\.xml$/, '.pdf'),
    };
    doc.provenance.sourceUrl = meta.sourceUrl;
  }
  if (meta.sourceHash) doc.version.sourceHash = meta.sourceHash;
  if (certificate) doc.certificate = certificate;
  return doc;
}

export function deriveRcwAffected(sections: BillSection[]): RcwAffected[] {
  const map = new Map<string, RcwAffected>();
  const add = (cite: string, action: RcwAffected['action'], sectionId: string, caption?: string, chapter?: string) => {
    const key = `${action}:${cite}`;
    let row = map.get(key);
    if (!row) {
      row = { cite, action, sectionIds: [], href: rcwHref(cite) };
      if (chapter) row.chapter = chapter;
      if (caption) row.caption = caption;
      map.set(key, row);
    }
    if (!row.sectionIds.includes(sectionId)) row.sectionIds.push(sectionId);
  };
  for (const s of sections) {
    const t = s.target;
    if (!t) continue;
    if ((t.action === 'amend' || t.action === 'reenact-amend') && t.cite) add(t.cite, t.action, s.id, t.caption, t.chapter);
    else if (t.action === 'add' && t.chapter) add(t.chapter, 'add', s.id, undefined, t.chapter);
    else if (t.action === 'add' && t.title) add(t.title, 'add', s.id);
    else if (t.action === 'repeal') for (const r of t.repealed ?? []) add(r.cite, 'repeal', s.id, r.caption, r.cite.split('.').slice(0, 2).join('.'));
  }
  const rows = [...map.values()];
  const key = (c: string) => c.split('.').map((p) => p.padStart(6, '0')).join('.');
  rows.sort((a, b) => (key(a.cite) < key(b.cite) ? -1 : key(a.cite) > key(b.cite) ? 1 : 0));
  return rows;
}

export { parseSectionForAmendment };

/** Parse a BillSection node outside a bill (amendment bodies). */
function parseSectionForAmendment(sec: XNode, index: number, warnings: string[]): BillSection {
  return parseSection(sec, index, undefined, warnings);
}
