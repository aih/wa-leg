// Two-pass reading-text diff, ported from uscode-redesign/frontend/src/lib/diffdoc.ts.
// Pass 1 aligns lines (each distinct line is one character for diff-match-patch); pass 2 diffs
// tokens inside a deleted/inserted pair when enough of the line survives (PAIR_THRESHOLD).
// Diff_Timeout is 0 throughout so the diff is never traded for speed.
import DiffMatchPatch from 'diff-match-patch';
import type { BillDocument, BillSection, Block, Run, BillMark } from './types.js';
import { normalizeSpace } from './hash.js';

export type Mark = 'equal' | 'insert' | 'delete';
export type DiffMode = 'as-printed' | 'effect';

export interface Token {
  text: string;
  billMark?: BillMark;
}

export interface ReadingLine {
  depth: number;
  kind: 'text' | 'note';
  /** Whitespace-normalized plain text (marks dropped) of the line. */
  text: string;
  /** Tokens with their bill marks; concatenation equals `text` up to whitespace. */
  tokens: Token[];
  owner: string | null;
}

export interface Span {
  mark: Mark;
  text: string;
  billMark?: BillMark;
}

export interface DiffLine {
  mark: Mark | 'changed';
  depth: number;
  kind: 'text' | 'note';
  blockId: string | null;
  spans: Span[];
}

export interface DocumentDiff {
  lines: DiffLine[];
  changed: number;
  inserted: number;
  deleted: number;
}

export interface SectionDiff {
  identity: string;
  fromSectionId: string | null;
  toSectionId: string | null;
  fromNum?: string;
  toNum?: string;
  status: 'equal' | 'changed' | 'added' | 'removed' | 'renumbered';
  lines: DiffLine[];
  summary: { changed: number; inserted: number; deleted: number };
}

export interface VersionDiff {
  bill: { biennium: string; id: string };
  from: string;
  to: string;
  mode: DiffMode;
  sections: SectionDiff[];
  summary: { changed: number; inserted: number; deleted: number; sectionsChanged: number };
}

const EQUAL = 0;
const INSERT = 1;
const DELETE = -1;
const PAIR_THRESHOLD = 0.4;

function engine(): DiffMatchPatch {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 0;
  return dmp;
}

// ---------- reading lines from a Bill Document ----------

function runTokens(runs: Run[], mode: DiffMode): Token[] {
  const out: Token[] = [];
  for (const r of runs) {
    let billMark: BillMark | undefined;
    if (r.t === 'ins') billMark = 'ins';
    else if (r.t === 'del') billMark = 'del';
    else if (r.t === 'cite' && r.mark) billMark = r.mark;
    if (mode === 'effect') {
      if (billMark === 'del') continue;
      billMark = undefined;
    }
    for (const piece of r.text.match(/\s+|\S+/g) ?? []) {
      out.push(billMark ? { text: piece, billMark } : { text: piece });
    }
  }
  return out;
}

function pushLine(out: ReadingLine[], depth: number, kind: 'text' | 'note', tokens: Token[], owner: string | null): void {
  // Collapse whitespace tokens so reformatting never shows as a change.
  const norm: Token[] = [];
  for (const t of tokens) {
    if (/^\s+$/.test(t.text)) {
      const last = norm[norm.length - 1];
      if (last && /^\s+$/.test(last.text)) continue;
      norm.push({ text: ' ' });
    } else norm.push(t);
  }
  while (norm.length && /^\s+$/.test(norm[0]!.text)) norm.shift();
  while (norm.length && /^\s+$/.test(norm[norm.length - 1]!.text)) norm.pop();
  const text = normalizeSpace(norm.map((t) => t.text).join(''));
  if (!text) return;
  out.push({ depth, kind, text, tokens: norm, owner });
}

function blockLines(b: Block, depth: number, mode: DiffMode, out: ReadingLine[]): void {
  const tokens: Token[] = [];
  if (b.label) {
    if (!(mode === 'effect' && b.labelMark === 'del')) {
      tokens.push(b.labelMark && mode === 'as-printed' ? { text: b.label, billMark: b.labelMark } : { text: b.label });
      tokens.push({ text: ' ' });
    }
  }
  if (b.table) {
    pushLine(out, depth, 'text', tokens, b.id);
    for (const row of b.table.rows) {
      const rowTokens: Token[] = [];
      row.forEach((cell, i) => {
        if (i > 0) rowTokens.push({ text: ' | ' });
        rowTokens.push(...runTokens(cell.runs, mode));
      });
      pushLine(out, depth + 1, 'text', rowTokens, b.id);
    }
  } else {
    tokens.push(...runTokens(b.runs, mode));
    pushLine(out, depth, 'text', tokens, b.id);
  }
  for (const c of b.children) blockLines(c, depth + 1, mode, out);
}

/** The reading lines of a section: intro text, blocks, then notes (muted). */
export function sectionLines(s: BillSection, mode: DiffMode): ReadingLine[] {
  const out: ReadingLine[] = [];
  const head: Token[] = [{ text: s.label }, { text: ' ' }];
  if (s.introText) head.push(...runTokens(s.introText, mode));
  pushLine(out, 1, 'text', head, s.id);
  for (const b of s.blocks) blockLines(b, 1, mode, out);
  for (const n of s.notes ?? []) pushLine(out, 1, 'note', [{ text: n }], s.id);
  return out;
}

// ---------- pass 1: line alignment ----------

interface LineOp {
  mark: Mark;
  lines: ReadingLine[];
}

function codePoint(index: number): string {
  return String.fromCharCode(index < 0xd800 ? index : index + 0x800);
}

function lineKey(l: ReadingLine): string {
  return `${l.kind}|${l.depth}|${l.tokens.map((t) => (t.billMark ? `${t.billMark}:${t.text}` : t.text)).join('')}`;
}

function alignLines(from: ReadingLine[], to: ReadingLine[]): LineOp[] {
  const codes = new Map<string, string>();
  const encode = (l: ReadingLine): string => {
    const key = lineKey(l);
    let code = codes.get(key);
    if (code === undefined) {
      code = codePoint(codes.size);
      codes.set(key, code);
    }
    return code;
  };
  const fromCodes = from.map(encode).join('');
  const toCodes = to.map(encode).join('');
  const diffs = engine().diff_main(fromCodes, toCodes, false);
  const ops: LineOp[] = [];
  let fromAt = 0;
  let toAt = 0;
  for (const [op, text] of diffs) {
    const count = text.length;
    if (op === EQUAL) {
      ops.push({ mark: 'equal', lines: to.slice(toAt, toAt + count) });
      fromAt += count;
      toAt += count;
    } else if (op === DELETE) {
      ops.push({ mark: 'delete', lines: from.slice(fromAt, fromAt + count) });
      fromAt += count;
    } else if (op === INSERT) {
      ops.push({ mark: 'insert', lines: to.slice(toAt, toAt + count) });
      toAt += count;
    }
  }
  return ops;
}

// ---------- pass 2: token diff inside a paired line ----------

function tokenKey(t: Token): string {
  return t.billMark ? `${t.billMark}:${t.text}` : t.text;
}

function wordSpans(before: Token[], after: Token[]): Span[] {
  const codes = new Map<string, string>();
  const encode = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        const key = tokenKey(token);
        let code = codes.get(key);
        if (code === undefined) {
          code = codePoint(codes.size);
          codes.set(key, code);
        }
        return code;
      })
      .join('');
  const diffs = engine().diff_main(encode(before), encode(after), false);
  const spans: Span[] = [];
  let beforeAt = 0;
  let afterAt = 0;
  for (const [op, text] of diffs) {
    const count = text.length;
    const mark: Mark = op === EQUAL ? 'equal' : op === INSERT ? 'insert' : 'delete';
    const source = op === DELETE ? before.slice(beforeAt, beforeAt + count) : after.slice(afterAt, afterAt + count);
    if (op !== INSERT) beforeAt += count;
    if (op !== DELETE) afterAt += count;
    for (const tok of source) {
      if (!tok.text) continue;
      const last = spans[spans.length - 1];
      if (last && last.mark === mark && last.billMark === tok.billMark) last.text += tok.text;
      else spans.push(tok.billMark ? { mark, text: tok.text, billMark: tok.billMark } : { mark, text: tok.text });
    }
  }
  return spans;
}

function plainSpans(l: ReadingLine): Span[] {
  const spans: Span[] = [];
  for (const tok of l.tokens) {
    const last = spans[spans.length - 1];
    if (last && last.billMark === tok.billMark) last.text += tok.text;
    else spans.push(tok.billMark ? { mark: 'equal', text: tok.text, billMark: tok.billMark } : { mark: 'equal', text: tok.text });
  }
  return spans;
}

function markedSpans(l: ReadingLine, mark: Mark): Span[] {
  return plainSpans(l).map((s) => ({ ...s, mark }));
}

function pairLine(removed: ReadingLine, added: ReadingLine): DiffLine {
  const spans = wordSpans(removed.tokens, added.tokens);
  let common = 0;
  for (const span of spans) if (span.mark === 'equal') common += span.text.length;
  const longer = Math.max(removed.text.length, added.text.length, 1);
  if (common / longer < PAIR_THRESHOLD) return deleteLine(removed);
  return { mark: 'changed', depth: added.depth, kind: added.kind, spans, blockId: added.owner };
}

function insertLine(l: ReadingLine): DiffLine {
  return { mark: 'insert', depth: l.depth, kind: l.kind, spans: markedSpans(l, 'insert'), blockId: l.owner };
}
function deleteLine(l: ReadingLine): DiffLine {
  return { mark: 'delete', depth: l.depth, kind: l.kind, spans: markedSpans(l, 'delete'), blockId: l.owner };
}

export function documentDiff(from: ReadingLine[], to: ReadingLine[]): DocumentDiff {
  const ops = alignLines(from, to);
  const lines: DiffLine[] = [];
  let changed = 0;
  let inserted = 0;
  let deleted = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.mark === 'equal') {
      for (const l of op.lines) lines.push({ mark: 'equal', depth: l.depth, kind: l.kind, spans: plainSpans(l), blockId: l.owner });
      continue;
    }
    if (op.mark === 'delete' && ops[i + 1]?.mark === 'insert') {
      const removed = op.lines;
      const added = ops[i + 1]!.lines;
      i += 1;
      const pairs = Math.min(removed.length, added.length);
      for (let p = 0; p < pairs; p++) {
        const line = pairLine(removed[p]!, added[p]!);
        lines.push(line);
        if (line.mark === 'changed') changed += 1;
        else {
          lines.push(insertLine(added[p]!));
          deleted += 1;
          inserted += 1;
        }
      }
      for (const l of removed.slice(pairs)) {
        lines.push(deleteLine(l));
        deleted += 1;
      }
      for (const l of added.slice(pairs)) {
        lines.push(insertLine(l));
        inserted += 1;
      }
      continue;
    }
    for (const l of op.lines) {
      if (op.mark === 'delete') {
        lines.push(deleteLine(l));
        deleted += 1;
      } else {
        lines.push(insertLine(l));
        inserted += 1;
      }
    }
  }
  return { lines, changed, inserted, deleted };
}

// ---------- section alignment ----------

function shingles(text: string, n = 1): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function sectionPlainText(s: BillSection): string {
  return sectionLines(s, 'effect')
    .filter((l) => l.kind === 'text')
    .map((l) => l.text)
    .join(' ');
}

/** Align and diff two section lists (design/research/bill-viewer.md section 6). */
export function diffSections(fromSections: BillSection[], toSections: BillSection[], mode: DiffMode): SectionDiff[] {
  const fromByIdentity = new Map<string, number>();
  fromSections.forEach((s, i) => {
    if (!fromByIdentity.has(s.identity)) fromByIdentity.set(s.identity, i);
  });
  const matchTo = new Map<number, number>(); // to index -> from index
  const matchedFrom = new Set<number>();
  toSections.forEach((s, i) => {
    const fi = fromByIdentity.get(s.identity);
    if (fi !== undefined && !matchedFrom.has(fi)) {
      matchTo.set(i, fi);
      matchedFrom.add(fi);
    }
  });
  // Similarity fallback for unmatched sections on both sides.
  const unmatchedTo = toSections.map((_, i) => i).filter((i) => !matchTo.has(i));
  const unmatchedFrom = fromSections.map((_, i) => i).filter((i) => !matchedFrom.has(i));
  if (unmatchedTo.length && unmatchedFrom.length) {
    const fromSh = new Map(unmatchedFrom.map((i) => [i, shingles(sectionPlainText(fromSections[i]!))]));
    const candidates: { ti: number; fi: number; score: number }[] = [];
    for (const ti of unmatchedTo) {
      const sh = shingles(sectionPlainText(toSections[ti]!));
      for (const fi of unmatchedFrom) {
        const score = jaccard(sh, fromSh.get(fi)!);
        if (score >= 0.6) candidates.push({ ti, fi, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (matchTo.has(c.ti) || matchedFrom.has(c.fi)) continue;
      matchTo.set(c.ti, c.fi);
      matchedFrom.add(c.fi);
    }
    // Same number and kind with some shared text: a rewritten section that kept its place.
    for (const ti of unmatchedTo) {
      if (matchTo.has(ti)) continue;
      const t = toSections[ti]!;
      const sh = shingles(sectionPlainText(t));
      for (const fi of unmatchedFrom) {
        if (matchedFrom.has(fi)) continue;
        const f = fromSections[fi]!;
        if (f.num === t.num && f.kind === t.kind && jaccard(sh, fromSh.get(fi)!) >= 0.3) {
          matchTo.set(ti, fi);
          matchedFrom.add(fi);
          break;
        }
      }
    }
  }

  const out: SectionDiff[] = [];
  const emittedFrom = new Set<number>();
  const emitRemoved = (upTo: number) => {
    for (let fi = 0; fi < upTo; fi++) {
      if (matchedFrom.has(fi) || emittedFrom.has(fi)) continue;
      emittedFrom.add(fi);
      const s = fromSections[fi]!;
      const lines = sectionLines(s, mode).map(deleteLine);
      out.push({
        identity: s.identity,
        fromSectionId: s.id,
        toSectionId: null,
        fromNum: s.num,
        status: 'removed',
        lines,
        summary: { changed: 0, inserted: 0, deleted: lines.length },
      });
    }
  };
  toSections.forEach((s, ti) => {
    const fi = matchTo.get(ti);
    if (fi !== undefined) emitRemoved(fi);
    if (fi === undefined) {
      const lines = sectionLines(s, mode).map(insertLine);
      out.push({
        identity: s.identity,
        fromSectionId: null,
        toSectionId: s.id,
        toNum: s.num,
        status: 'added',
        lines,
        summary: { changed: 0, inserted: lines.length, deleted: 0 },
      });
      return;
    }
    emittedFrom.add(fi);
    const f = fromSections[fi]!;
    if (f.textHash === s.textHash && mode === 'as-printed') {
      out.push({
        identity: s.identity,
        fromSectionId: f.id,
        toSectionId: s.id,
        fromNum: f.num,
        toNum: s.num,
        status: f.num === s.num ? 'equal' : 'renumbered',
        lines: [],
        summary: { changed: 0, inserted: 0, deleted: 0 },
      });
      return;
    }
    const d = documentDiff(sectionLines(f, mode), sectionLines(s, mode));
    const unchanged = d.changed + d.inserted + d.deleted === 0;
    out.push({
      identity: s.identity,
      fromSectionId: f.id,
      toSectionId: s.id,
      fromNum: f.num,
      toNum: s.num,
      status: unchanged ? (f.num === s.num ? 'equal' : 'renumbered') : 'changed',
      lines: unchanged ? [] : d.lines,
      summary: { changed: d.changed, inserted: d.inserted, deleted: d.deleted },
    });
  });
  emitRemoved(fromSections.length);
  return out;
}

export function diffVersions(from: BillDocument, to: BillDocument, mode: DiffMode = 'as-printed', toCode?: string): VersionDiff {
  const sections = diffSections(from.sections, to.sections, mode);
  const summary = { changed: 0, inserted: 0, deleted: 0, sectionsChanged: 0 };
  for (const s of sections) {
    summary.changed += s.summary.changed;
    summary.inserted += s.summary.inserted;
    summary.deleted += s.summary.deleted;
    if (s.status !== 'equal') summary.sectionsChanged += 1;
  }
  return {
    bill: { biennium: to.bill.biennium, id: to.bill.id },
    from: from.version.code,
    to: toCode ?? to.version.code,
    mode,
    sections,
    summary,
  };
}

export function diffSummary(d: { changed: number; inserted: number; deleted: number }): string {
  const parts: string[] = [];
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
  if (d.changed) parts.push(`${lines(d.changed)} changed`);
  if (d.inserted) parts.push(`${lines(d.inserted)} added`);
  if (d.deleted) parts.push(`${lines(d.deleted)} removed`);
  return parts.length > 0 ? parts.join(', ') : 'No changes';
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The redline as HTML: one <p> per line, <ins>/<del> for the diff, bill marks as classes. */
export function diffLinesHtml(lines: DiffLine[], focus?: string | null): string {
  let anchored = false;
  return lines
    .map((line) => {
      const classes = ['diff-line', `diff-line--${line.mark}`];
      if (line.kind === 'note') classes.push('diff-line--note');
      const inFocus = Boolean(focus && line.blockId && (line.blockId === focus || line.blockId.startsWith(`${focus}.`)));
      let attrs = '';
      if (inFocus) {
        classes.push('diff-line--focus');
        if (!anchored) {
          anchored = true;
          attrs = ' id="diff-focus"';
        }
      }
      const inner = line.spans
        .map((span) => {
          let text = escapeHtml(span.text);
          if (span.billMark) text = `<span class="bill-${span.billMark}">${text}</span>`;
          if (span.mark === 'insert') return `<ins>${text}</ins>`;
          if (span.mark === 'delete') return `<del>${text}</del>`;
          return text;
        })
        .join('');
      return `<p class="${classes.join(' ')}"${attrs} style="--depth: ${line.depth - 1}">${inner}</p>`;
    })
    .join('');
}
