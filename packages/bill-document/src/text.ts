import type { Block, BillSection, Run } from './types.js';

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join('');
}

/** Plain reading text of a block subtree: label, runs, children, table cells. */
export function blockText(b: Block): string {
  const parts: string[] = [];
  if (b.label) parts.push(b.label);
  if (b.table) {
    for (const row of b.table.rows) parts.push(row.map((c) => runsText(c.runs)).join(' | '));
  } else {
    parts.push(runsText(b.runs));
  }
  for (const c of b.children) parts.push(blockText(c));
  return normalizeSpace(parts.join(' '));
}

/** Plain text of a section: intro text, then every block. Marks are dropped, text is kept. */
export function sectionText(s: Pick<BillSection, 'introText' | 'blocks'>): string {
  const parts: string[] = [];
  if (s.introText) parts.push(runsText(s.introText));
  for (const b of s.blocks) parts.push(blockText(b));
  return normalizeSpace(parts.join(' '));
}

/** Count words in ins and del runs. */
export function changeSummary(blocks: Block[]): { insWords: number; delWords: number } {
  let insWords = 0;
  let delWords = 0;
  const words = (t: string) => (t.match(/\S+/g) ?? []).length;
  const walk = (b: Block) => {
    for (const r of b.runs) {
      if (r.t === 'ins' || (r.t === 'cite' && r.mark === 'ins')) insWords += words(r.text);
      if (r.t === 'del' || (r.t === 'cite' && r.mark === 'del')) delWords += words(r.text);
    }
    if (b.table) for (const row of b.table.rows) for (const c of row) for (const r of c.runs) {
      if (r.t === 'ins') insWords += words(r.text);
      if (r.t === 'del') delWords += words(r.text);
    }
    for (const c of b.children) walk(c);
  };
  for (const b of blocks) walk(b);
  return { insWords, delWords };
}
