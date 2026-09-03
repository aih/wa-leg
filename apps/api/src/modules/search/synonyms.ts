/** Legal and agency synonyms (search.md section 3.3). Solr format for OpenSearch; expanded in code for Postgres. */
export const SYNONYMS: string[] = [
  'b and o, business and occupation, business and occupations, b o',
  'rcw, revised code of washington',
  'wac, washington administrative code',
  'dor, department of revenue',
  'ofm, office of financial management',
  'lsc, legislative service center',
  'fte, full time equivalent',
  'reet, real estate excise tax',
  'puc, public utility tax',
  'esd, employment security department',
  'dshs, department of social and health services',
  'l and i, labor and industries',
  'cte, career and technical education',
  'fiscal note, fn',
];

/** Expand a lower-cased query with alternative forms for backends without synonym graphs. */
export function expandSynonyms(q: string): string[] {
  const lower = q.toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  const out = new Set<string>([lower]);
  for (const line of SYNONYMS) {
    const forms = line.split(',').map((s) => s.trim());
    for (const f of forms) {
      if (lower.includes(f)) for (const g of forms) if (g !== f) out.add(lower.replace(f, g));
    }
  }
  return [...out];
}
