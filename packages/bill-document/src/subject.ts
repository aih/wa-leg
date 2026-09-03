// Section subjects for outlines: the RCW caption when the source carries one, otherwise a short paraphrase of
// the section's first sentence. Browser-safe (string operations only).
import type { BillSection, Block } from './types.js';
import { runsText } from './text.js';

export interface SectionSubject {
  /** The caption or paraphrase, without brackets. */
  text: string;
  /** True when the text was derived from the body rather than copied from a caption. */
  paraphrased: boolean;
}

const MAX_CHARS = 64;

function firstBlockText(blocks: Block[]): string {
  for (const b of blocks) {
    if (b.table) continue;
    const own = runsText(b.runs).trim();
    if (own) return own;
    const child = firstBlockText(b.children);
    if (child) return child;
  }
  return '';
}

/** Body text of the section: the first paragraph with words, or the intro text for sections that have no body. */
function leadText(s: BillSection): string {
  const body = firstBlockText(s.blocks);
  if (body) return body;
  return s.introText ? runsText(s.introText).trim() : '';
}

/** Strip a trailing "(Effective January 1, 2024.)" style note from an RCW caption. */
export function cleanCaption(caption: string): string {
  return caption
    .replace(/\s*\((?:Effective|Expires|Contingent)[^)]*\)\s*\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DATE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/;

function sentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.*?[.;:])(?:\s|$)/.exec(t);
  return m ? m[1]!.replace(/[.;:]$/, '') : t;
}

/** Drop leading designators, cross-references and dates from a sentence: "(1) Except as provided in ..., beginning January 1, 2030, it is ..." */
function trimPreamble(text: string): string {
  let t = text.replace(/^(?:\(\w{1,4}\)\s*)+/, '');
  // Iterate: several preambles can stack ("Except as provided in ..., beginning January 1, 2030, in addition to ...").
  for (let i = 0; i < 5; i++) {
    const before = t;
    t = t
      .replace(/^(?:Except|Subject to|Notwithstanding|In addition to|Pursuant to|Unless|Until|On and after|Beginning|Effective|Starting|As of|For purposes of|For the purposes of|In accordance with|Commencing)\b[^,;]*?(?:,\s*\d{4})?,\s*/i, '')
      .replace(/^(?:as|and|but|however,|then)\s+/i, '')
      .replace(/^(?:by|on|before|after|no later than|within)\s+[^,;]*?\d{4},\s*/i, '')
      .replace(/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4},\s*/i, '');
    if (t === before) break;
  }
  return t.trim();
}

const REWRITES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^the definitions in this (?:section|chapter) apply/i, () => 'Definitions'],
  [/^(?:this act|this chapter|this section) may be (?:known and )?cited as (?:the )?(?:"|“)?(.+?)(?:"|”)?$/i, (m) => `Short title: ${cap(m[1]!)}`],
  [/^RCW 82\.32\.805 and 82\.32\.808 do not apply/i, () => 'Exempt from tax preference performance review'],
  [/^this section is the tax preference performance statement/i, () => 'Tax preference performance statement'],
  [/^this act is necessary for the (?:immediate )?support of (?:the )?state government/i, () => 'Necessary for support of state government'],
  [/^(?:the )?legislature finds and declares/i, () => 'Findings and declarations'],
  [/^(?:the )?legislature finds/i, () => 'Findings'],
  [/^it is the intent of the legislature/i, () => 'Intent'],
  [/^(?:the )?legislature intends/i, () => 'Intent'],
  [/^sections? [\d,\s\-–]+(?:through|and|to)?[\d,\s\-–]* of this act (?:constitutes?|are added to and constitutes?|are each added to) (?:a )?new chapter in title (\d+[A-Z]?) RCW/i, (m) => `New chapter in Title ${m[1]} RCW`],
  [/^sections? [\d,\s\-–]+(?:through|and|to)?[\d,\s\-–]* of this act (?:are|is) (?:each )?added to chapter ([\d.A-Z]+) RCW/i, (m) => `Added to chapter ${m[1]} RCW`],
  [/^(?:the )?(.+?) (?:may|shall|must) adopt (?:any )?rules/i, (m) => `Rule-making authority: ${m[1]!.replace(/^the /i, '')}`],
  [/^there is (?:hereby )?(?:created|established) (?:an?|the) (.+?)(?: in the custody of| in the state treasury| within| to be| which|,|$)/i, (m) => cap(m[1]!)],
  [/^(?:an?|the) (.+?) is (?:hereby )?(?:created|established) in (?:the custody of the state treasurer|the state treasury)/i, (m) => cap(m[1]!)],
  [/^it is (?:unlawful|prohibited|illegal) (?:for (?:a |an |any )?[^,]+? )?to (.+)/i, (m) => `Prohibited: ${lower(m[1]!)}`],
  [/^no (person|dealer|employer|manufacturer|retailer|entity|state agency|agency|city|county|local government|public agency|licensee) (?:may|shall) (.+)/i, (m) => `Prohibition: ${lower(m[1]!)} may not ${lower(m[2]!)}`],
  [/^(?:if|when) (?:specific )?funding for (?:the purposes of )?this act.*(?:null and void|is not provided)/i, () => 'Null and void unless funded'],
];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function truncate(s: string, max = MAX_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim().replace(/[,;:]$/, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut.slice(0, max)).replace(/[,;:(]$/, '')}…`;
}

/** Paraphrase the first sentence of a section into a short subject line. */
export function paraphrase(text: string): string {
  const raw = sentence(text.replace(/\(\((?:[^()]|\([^()]*\))*\)\)/g, '')); // drop struck text
  const t = trimPreamble(raw);
  for (const [re, fn] of REWRITES) {
    const m = re.exec(t);
    if (m) return truncate(fn(m));
  }
  return truncate(cap(t));
}

const KIND_SUBJECTS: Partial<Record<BillSection['kind'], (s: BillSection, text: string) => string>> = {
  severability: () => 'Severability',
  emergency: () => 'Emergency clause',
  'effective-date': (_, text) => {
    const d = DATE.exec(text)?.[0];
    return d ? `Effective date: ${d}` : 'Effective date';
  },
  expiration: (_, text) => {
    const d = DATE.exec(text)?.[0];
    return d ? `Expiration: ${d}` : 'Expiration';
  },
  appropriation: () => 'Appropriation',
  contingent: (_, text) => (/null and void/i.test(text) ? 'Null and void unless funded' : 'Contingent effect'),
};

/**
 * Subject of a section for outlines and section bars.
 * Amendatory and repealing sections use the RCW caption; new sections are paraphrased from their first sentence.
 */
export function sectionSubject(s: BillSection): SectionSubject | null {
  const caption = s.heading ?? s.target?.caption ?? (s.target?.repealed?.length === 1 ? s.target.repealed[0]!.caption : undefined);
  if (caption) {
    const text = cleanCaption(caption);
    if (text) return { text, paraphrased: false };
  }
  if (s.target?.action === 'repeal' && (s.target.repealed?.length ?? 0) > 1) {
    return { text: `Repeals ${s.target.repealed!.length} sections`, paraphrased: true };
  }
  const text = leadText(s);
  const byKind = KIND_SUBJECTS[s.kind];
  if (byKind) return { text: byKind(s, text), paraphrased: true };
  if (s.kind === 'intent') {
    const p = paraphrase(text);
    return { text: /^(Findings|Intent)/.test(p) ? p : 'Findings and intent', paraphrased: true };
  }
  if (s.sourceKind === 'addchap' && s.target?.title && !/constitute/i.test(text)) return { text: `New chapter in Title ${s.target.title} RCW`, paraphrased: true };
  if (s.target?.action === 'amend' && s.target.uncodified) return { text: `Amends ${s.target.uncodified} (uncodified)`, paraphrased: true };
  if (!text) return null;
  return { text: paraphrase(text), paraphrased: true };
}
