// Fallback parser for lawfilesext bill HTM (one <div> per paragraph, inline styles only).
// Used when the XML is missing. Section kinds are inferred from the amending clause text.
import { longLabel, versionSeq } from '@wa-leg/billref';
import type { BillDocument, BillSection, Block, Run, SectionKind, SectionTarget, SourceSectionKind } from './types.js';
import { changeSummary, normalizeSpace, textHash } from './hash.js';
import { assignIdentities } from './identity.js';
import { parseTitle, rcwHref } from './title.js';
import { billTypeCode, classifyNew, deriveRcwAffected, PARSER_VERSION, type ParseMeta } from './parse-xml.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Inline HTML of one paragraph → runs. */
export function inlineRuns(html: string): Run[] {
  const runs: Run[] = [];
  const push = (r: Run) => {
    if (!r.text) return;
    const last = runs[runs.length - 1];
    if (last && last.t === r.t && r.t !== 'cite') last.text += r.text;
    else runs.push(r);
  };
  const tagRe = /<(\/?)(span|a|u|s|strike|b|i|br)\b([^>]*)>|<!--.*?-->|<[^>]+>/gi;
  const stack: Array<'ins' | 'del' | 'text' | { cite: string }> = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  const current = (): 'ins' | 'del' | 'text' => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]!;
      if (typeof s === 'string' && s !== 'text') return s;
    }
    return 'text';
  };
  const citeCtx = (): string | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]!;
      if (typeof s === 'object') return s.cite;
    }
    return null;
  };
  const emit = (text: string) => {
    const t = decodeEntities(text);
    if (!t) return;
    const cite = citeCtx();
    if (cite) {
      const r: Run = { t: 'cite', text: t, cite: { kind: cite.includes('.') ? (cite.split('.').length === 3 ? 'rcw' : 'rcw-chapter') : 'rcw-title', text: `RCW ${t}`, cite, href: rcwHref(cite) } };
      const mk = current();
      if (mk !== 'text') r.mark = mk;
      runs.push(r);
    } else push({ t: current(), text: t });
  };
  while ((m = tagRe.exec(html))) {
    emit(html.slice(pos, m.index));
    pos = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2]?.toLowerCase();
    const attrs = m[3] ?? '';
    if (!tag) continue;
    if (tag === 'br') {
      emit(' ');
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    if (tag === 'a') {
      const cm = /cite=([0-9A-Za-z.]+)/.exec(attrs);
      stack.push(cm ? { cite: cm[1]! } : 'text');
    } else if (tag === 'u' || /text-decoration:\s*underline/i.test(attrs)) stack.push('ins');
    else if (tag === 's' || tag === 'strike' || /line-through/i.test(attrs)) stack.push('del');
    else stack.push('text');
  }
  emit(html.slice(pos));
  // Struck text is printed inside double parentheses that sit outside the styled span; fold them into the run.
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.t !== 'del') continue;
    const prev = runs[i - 1];
    const next = runs[i + 1];
    if (prev && prev.t === 'text' && prev.text.endsWith('((')) {
      prev.text = prev.text.slice(0, -2);
      r.text = '((' + r.text;
    }
    if (next && next.t === 'text' && next.text.startsWith('))')) {
      next.text = next.text.slice(2);
      r.text = r.text + '))';
    }
  }
  return runs.filter((r) => r.text || r.t === 'cite');
}

const MARKER_RE = /^\((\d{1,3}|[a-z]{1,4}|[A-Z]{1,4})\)/;

export function parseBillHtm(html: string, meta: ParseMeta): BillDocument {
  const src = html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
  const warnings: string[] = [];
  const field = (name: string): string | undefined => {
    const m = new RegExp(`<!-- field: ${name} -->([\\s\\S]*?)<!-- field: -->`).exec(src);
    return m ? normalizeSpace(decodeEntities(m[1]!.replace(/<[^>]+>/g, ''))) : undefined;
  };
  const titleText = field('CaptionsTitles') ?? '';
  const sponsors = field('Sponsors');
  const longId = /<div style="font-weight:bold;text-align:center;">([^<]*)<\/div>/.exec(src)?.[1];
  const readDate = /READ FIRST TIME (\d{2})\/(\d{2})\/(\d{2})/.exec(src);
  const parsedTitle = parseTitle(titleText);

  const header: BillDocument['header'] = { title: titleText };
  if (parsedTitle.relatingTo) header.relatingTo = parsedTitle.relatingTo;
  if (parsedTitle.actions.length) header.titleActions = parsedTitle.actions;
  if (sponsors) header.sponsors = [sponsors];
  if (longId) header.longBillId = normalizeSpace(decodeEntities(longId));
  if (readDate) header.readFirstTime = `20${readDate[3]}-${readDate[1]}-${readDate[2]}`;

  // Paragraph divs after the enacting clause.
  const bodyStart = src.indexOf('BE IT ENACTED');
  const bodyEnd = src.indexOf('--- END ---');
  const bodyHtml = src.slice(bodyStart < 0 ? 0 : bodyStart, bodyEnd < 0 ? undefined : bodyEnd);
  const divRe = /<div\b([^>]*)>([\s\S]*?)<\/div>/g;
  const paras: { attrs: string; html: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = divRe.exec(bodyHtml))) paras.push({ attrs: m[1] ?? '', html: m[2] ?? '' });

  const sections: BillSection[] = [];
  let current: { sec: BillSection; blocks: Block[]; stack: Block[]; unlabeled: number } | null = null;
  const finish = () => {
    if (!current) return;
    const s = current.sec;
    s.blocks = current.blocks;
    if (s.sourceKind === 'new' && s.kind === 'new') s.kind = classifyNew(s.blocks.map(plain).join(' '));
    s.textHash = textHash(s);
    const cs = changeSummary(s.blocks);
    if (cs.insWords || cs.delWords) s.changeSummary = cs;
    sections.push(s);
    current = null;
  };

  for (const p of paras) {
    if (p.html.includes('field: BeginningSection')) {
      finish();
      const isNew = /NEW SECTION\./.test(p.html);
      const numM = /Sec\.\s*(\d+[A-Za-z]?)\./.exec(decodeEntities(p.html.replace(/<[^>]+>/g, '')));
      const num = numM?.[1] ?? String(sections.length + 1);
      const id = `sec-${num.toLowerCase()}`;
      // Intro text: everything after "Sec. N." span.
      const afterNum = p.html.split(/Sec\.\s*\d+[A-Za-z]?\.\s*<\/span>/)[1] ?? '';
      const introRuns = inlineRuns(afterNum.replace(/<!--.*?-->/g, ''));
      const introText = normalizeSpace(introRuns.map((r) => r.text).join(''));
      let sourceKind: SourceSectionKind = isNew ? 'new' : 'amend';
      let kind: SectionKind = isNew ? 'new' : 'amendatory';
      let target: SectionTarget | undefined;
      const cite = introRuns.find((r) => r.t === 'cite')?.cite;
      if (/are each amended|is amended to read/i.test(introText) && !isNew) {
        sourceKind = /reenacted/i.test(introText) ? 'remd' : 'amend';
        kind = 'amendatory';
        target = { action: sourceKind === 'remd' ? 'reenact-amend' : 'amend' };
        if (cite?.cite) {
          target.cite = cite.cite;
          target.chapter = cite.cite.split('.').slice(0, 2).join('.');
          target.href = rcwHref(cite.cite);
        }
        const hm = /and\s+(.+?)\s+(?:is|are)\s+each\s+(?:reenacted and )?amended/i.exec(introText);
        if (hm) target.history = hm[1]!;
      } else if (/new section is added to chapter/i.test(introText)) {
        sourceKind = 'addsect';
        kind = 'new';
        target = { action: 'add' };
        if (cite?.cite) {
          target.chapter = cite.cite;
          target.href = rcwHref(cite.cite);
        }
      } else if (/are each repealed/i.test(introText)) {
        sourceKind = 'repeal';
        kind = 'repealer';
        target = { action: 'repeal', repealed: [] };
      } else if (/constitute a new chapter/i.test(introText)) {
        sourceKind = 'addchap';
        kind = 'new';
        target = { action: 'add' };
        if (cite?.cite) target.title = cite.cite;
      } else if (/takes? effect/i.test(introText) && /immediately|immediate preservation/i.test(introText)) {
        sourceKind = 'emerg';
        kind = 'emergency';
      } else if (/takes? effect/i.test(introText)) {
        sourceKind = 'effdate';
        kind = 'effective-date';
      } else if (/expires?/i.test(introText) && /of this act/i.test(introText)) {
        sourceKind = 'expdate';
        kind = 'expiration';
      } else if (/held invalid/i.test(introText)) {
        kind = 'severability';
      }
      const sec: BillSection = {
        id,
        num,
        label: `${isNew ? 'NEW SECTION. ' : ''}Sec. ${num}.`,
        isNewSection: isNew,
        kind,
        sourceKind,
        identity: '',
        blocks: [],
        textHash: '',
      };
      if (target) sec.target = target;
      current = { sec, blocks: [], stack: [], unlabeled: 0 };
      // For amendatory sections the intro is the amending clause; for new sections it is the first paragraph.
      if (target && (target.action === 'amend' || target.action === 'reenact-amend' || target.action === 'add') && sourceKind !== 'addchap') {
        sec.introText = introRuns;
      } else if (introRuns.length) {
        addBlock(current, introRuns);
      }
      continue;
    }
    if (!current) continue;
    const runs = inlineRuns(p.html.replace(/<!--.*?-->/g, ''));
    if (!runs.length) continue;
    const txt = normalizeSpace(runs.map((r) => r.text).join(''));
    if (current.sec.target?.action === 'repeal') {
      const cm = /^\(?(\d+)\)?\s*RCW\s+([0-9A-Za-z.]+)\s*\(([^)]*)\)\s*(?:and\s+(.+?))?;?$/.exec(txt);
      if (cm) {
        current.sec.target.repealed!.push({ cite: cm[2]!, caption: cm[3]!, history: cm[4] ?? '', href: rcwHref(cm[2]!) });
        runs[0]!.text = runs[0]!.text.replace(/^\(?\d+\)?\s*/, '');
        addBlock(current, runs, `(${cm[1]})`);
        continue;
      }
    }
    addBlock(current, runs);
  }
  finish();
  assignIdentities(sections);

  const doc: BillDocument = {
    schemaVersion: '1.0',
    bill: {
      biennium: meta.biennium,
      chamber: meta.type.startsWith('H') ? 'H' : 'S',
      type: billTypeCode(meta.type),
      number: meta.number,
      id: `${meta.type}${meta.number}`,
    },
    version: { code: meta.versionCode, label: longLabel(meta.type, meta.versionCode, meta.engrossedLevel), seq: versionSeq(meta.versionCode) },
    header,
    sections,
    rcwAffected: deriveRcwAffected(sections),
    provenance: { fetchedAt: meta.fetchedAt ?? new Date().toISOString(), parser: 'wa-bill-htm', parserVersion: PARSER_VERSION, warnings, hasLineNumbers: false },
  };
  if (meta.sourceUrl) doc.version.sourceUrls = { htm: meta.sourceUrl, pdf: meta.sourceUrl.replace('/Htm/', '/Pdf/').replace(/\.htm$/, '.pdf') };
  if (meta.sourceHash) doc.version.sourceHash = meta.sourceHash;
  return doc;
}

function plain(b: Block): string {
  return [b.label ?? '', ...b.runs.map((r) => r.text), ...b.children.map(plain)].join(' ');
}

function addBlock(cur: { sec: BillSection; blocks: Block[]; stack: Block[]; unlabeled: number }, runs: Run[], forcedLabel?: string): void {
  const KINDS: Block['kind'][] = ['subsection', 'paragraph', 'subparagraph', 'item', 'subitem'];
  const markers: string[] = [];
  let mark: 'ins' | 'del' | undefined;
  if (forcedLabel) markers.push(forcedLabel);
  else {
    const first = runs[0]!;
    let text = first.text;
    if (first.t === 'del' && text.startsWith('((')) text = text.slice(2);
    let consumed = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(text.slice(consumed)))) {
      markers.push(m[0]);
      consumed += m[0].length;
    }
    if (markers.length) {
      const rest = text.slice(consumed);
      if (rest && !/^\s|^\)\)/.test(rest)) markers.length = 0;
      else {
        if (first.t === 'ins') mark = 'ins';
        if (first.t === 'del') mark = 'del';
        first.text = (first.t === 'del' ? '((' : '') + rest.replace(/^\)\)/, '').replace(/^\s+/, '');
        if (!first.text || first.text === '((') runs.shift();
      }
    }
  }
  if (!markers.length) {
    const parent = cur.stack[cur.stack.length - 1];
    const parentId = parent ? parent.id : cur.sec.id;
    cur.unlabeled += 1;
    const b: Block = { id: `${parentId}.p${cur.unlabeled}`, level: parent ? parent.level + 1 : 1, kind: 'unnumbered', runs, children: [] };
    (parent ? parent.children : cur.blocks).push(b);
    return;
  }
  let chain: number | null = null;
  markers.forEach((label, i) => {
    const key = label.replace(/[()]/g, '');
    let level: number;
    if (chain !== null) level = chain + 1;
    else if (/^\d+$/.test(key)) level = 1;
    else if (/^[a-z]+$/.test(key)) {
      const l2 = cur.stack.find((b) => b.level === 2)?.label?.replace(/[()]/g, '');
      level = /^[ivxl]+$/.test(key) && !(l2 && String.fromCharCode(key.charCodeAt(0) - 1) === l2) && cur.stack.some((b) => b.level === 2) ? 3 : 2;
    } else if (/^[A-Z]+$/.test(key)) {
      const l4 = cur.stack.find((b) => b.level === 4)?.label?.replace(/[()]/g, '');
      level = /^[IVXL]+$/.test(key) && !(l4 && String.fromCharCode(key.charCodeAt(0) - 1) === l4) && cur.stack.some((b) => b.level === 4) ? 5 : 4;
    } else level = 1;
    chain = level;
    while (cur.stack.length && cur.stack[cur.stack.length - 1]!.level >= level) cur.stack.pop();
    const parent = cur.stack[cur.stack.length - 1];
    const b: Block = {
      id: `${parent ? parent.id : cur.sec.id}.${key}`,
      label,
      level,
      kind: KINDS[Math.min(level, KINDS.length) - 1]!,
      runs: i === markers.length - 1 ? runs : [],
      children: [],
    };
    if (mark) b.labelMark = mark;
    (parent ? parent.children : cur.blocks).push(b);
    cur.stack.push(b);
  });
}
