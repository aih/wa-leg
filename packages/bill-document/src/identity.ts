import { createHash } from 'node:crypto';
import type { BillSection, SectionKind } from './types.js';
import { sectionText } from './hash.js';

/**
 * Cross-version alignment key (ARCHITECTURE.md "Bills"): `rcw:{cite}` for amendatory and repeal sections,
 * `new:{chapter}:{ordinal}` for sections added to a chapter, `kind:{kind}` for effective-date, emergency,
 * expiration and severability sections, otherwise a hash of the first 200 characters of text.
 */
export function sectionIdentity(
  s: Pick<BillSection, 'kind' | 'target' | 'introText' | 'blocks'>,
  ordinalInChapter: number,
): string {
  const t = s.target;
  if (t && (t.action === 'amend' || t.action === 'reenact-amend') && t.cite) return `rcw:${t.cite}`;
  if (t && t.action === 'amend' && t.uncodified) return `uncod:${t.uncodified.replace(/\s+/g, '')}`;
  if (t && t.action === 'repeal') {
    const cites = t.repealed?.map((r) => r.cite).filter(Boolean) ?? [];
    if (cites.length === 1) return `rcw:${cites[0]}`;
    if (cites.length > 1) return `repeal:${cites[0]}+${cites.length - 1}:${createHash('sha256').update(cites.join(',')).digest('hex').slice(0, 8)}`;
    if (t.cite) return `rcw:${t.cite}`;
  }
  if (t && t.action === 'add' && t.chapter) return `new:${t.chapter}:${ordinalInChapter}`;
  if (t && t.action === 'add' && t.title) return `newchap:${t.title}:${ordinalInChapter}`;
  const kindKeyed: SectionKind[] = ['effective-date', 'emergency', 'expiration', 'severability'];
  if (kindKeyed.includes(s.kind)) return `kind:${s.kind}`;
  const text = sectionText(s).slice(0, 200);
  return 'text:' + createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Assign identities to a whole section list, making duplicates unique with an ordinal suffix. */
export function assignIdentities(sections: BillSection[]): void {
  const chapterCounts = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const s of sections) {
    let ordinal = 0;
    const t = s.target;
    if (t?.action === 'add') {
      const key = t.chapter ?? t.title ?? '';
      ordinal = (chapterCounts.get(key) ?? 0) + 1;
      chapterCounts.set(key, ordinal);
    }
    let id = sectionIdentity(s, ordinal);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}#${n + 1}`;
    s.identity = id;
  }
}
