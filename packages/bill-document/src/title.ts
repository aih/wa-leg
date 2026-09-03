import type { CiteRef, TitleAction } from './types.js';

export const RCW_BASE = 'https://app.leg.wa.gov/RCW/default.aspx?cite=';

export function rcwHref(cite: string): string {
  return `${RCW_BASE}${cite}`;
}

/** Extract RCW section, chapter, and title cites from prose. */
export function citesIn(text: string): CiteRef[] {
  const out: CiteRef[] = [];
  const seen = new Set<string>();
  const push = (c: CiteRef) => {
    const key = `${c.kind}:${c.cite}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  // "RCW 82.04.260, 82.04.270, and 82.08.020" — a list after one RCW keyword
  const re = /\bRCW\s+((?:\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?(?:\.\d{3,4}[A-Za-z]?)?)(?:\s*,\s*(?:and\s+)?\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?(?:\.\d{3,4}[A-Za-z]?)?)*(?:,?\s+and\s+\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?(?:\.\d{3,4}[A-Za-z]?)?)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const cite of m[1]!.match(/\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?(?:\.\d{3,4}[A-Za-z]?)?/g) ?? []) {
      const parts = cite.split('.');
      if (parts.length === 3) push({ kind: 'rcw', text: `RCW ${cite}`, cite, href: rcwHref(cite) });
      else push({ kind: 'rcw-chapter', text: `chapter ${cite} RCW`, cite, href: rcwHref(cite) });
    }
  }
  const chRe = /\bchapters?\s+((?:\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?)(?:\s*,\s*(?:and\s+)?\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?)*(?:,?\s+and\s+\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?)?)\s+RCW/g;
  while ((m = chRe.exec(text))) {
    for (const cite of m[1]!.match(/\d{1,2}[A-Z]?\.\d{2,3}[A-Z]?/g) ?? []) {
      push({ kind: 'rcw-chapter', text: `chapter ${cite} RCW`, cite, href: rcwHref(cite) });
    }
  }
  const tRe = /\bTitles?\s+(\d{1,2}[A-Z]?)\s+RCW/g;
  while ((m = tRe.exec(text))) {
    push({ kind: 'rcw-title', text: `Title ${m[1]} RCW`, cite: m[1]!, href: rcwHref(m[1]!) });
  }
  return out;
}

/** Parse the "AN ACT Relating to ...; amending RCW ...; ..." title into clauses. */
export function parseTitle(title: string): { relatingTo?: string; actions: TitleAction[] } {
  const t = title.replace(/\s+/g, ' ').trim();
  const rel = /^AN ACT Relating to\s+(.*?)(?:;|\.$|$)/i.exec(t);
  const relatingTo = rel?.[1]?.trim();
  const rest = rel ? t.slice(rel[0].length) : t;
  const clauses = rest
    .split(';')
    .map((c) => c.replace(/^\s*(?:and\s+)?/, '').replace(/\.\s*$/, '').trim())
    .filter(Boolean);
  const actions: TitleAction[] = [];
  for (const c of clauses) {
    const lower = c.toLowerCase();
    let kind: TitleAction['kind'] = 'other';
    if (lower.startsWith('reenacting and amending')) kind = 'reenacting-and-amending';
    else if (lower.startsWith('amending')) kind = 'amending';
    else if (lower.startsWith('adding') && /new chapter/i.test(c)) kind = 'adding-chapter';
    else if (lower.startsWith('adding') && /new section/i.test(c)) kind = 'adding-section';
    else if (lower.startsWith('adding')) kind = 'adding-section';
    else if (lower.startsWith('repealing')) kind = 'repealing';
    else if (lower.startsWith('decodifying')) kind = 'decodifying';
    else if (lower.startsWith('recodifying')) kind = 'recodifying';
    else if (lower.startsWith('creating') && /new section/i.test(c)) kind = 'creating-new-sections';
    else if (lower.startsWith('providing an effective date') || lower.startsWith('providing effective dates')) kind = 'effective-date';
    else if (lower.startsWith('declaring an emergency')) kind = 'emergency';
    else if (lower.startsWith('providing an expiration') || lower.startsWith('providing expiration')) kind = 'expiration';
    else if (lower.startsWith('making an appropriation') || lower.startsWith('making appropriations')) kind = 'appropriation';
    const cites = citesIn(c);
    const a: TitleAction = { kind, text: c };
    if (cites.length) a.cites = cites;
    actions.push(a);
  }
  return relatingTo ? { relatingTo, actions } : { actions };
}
