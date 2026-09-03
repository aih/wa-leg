import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanCaption, paraphrase, sectionSubject, type BillDocument } from '../src/index.js';
import { FIXTURES } from './fixtures.js';

const load = (file: string) => JSON.parse(readFileSync(join(FIXTURES, 'expected', file), 'utf8')) as BillDocument;
const subjectOf = (doc: BillDocument, num: string) => sectionSubject(doc.sections.find((s) => s.num === num)!);

describe('sectionSubject', () => {
  it('uses the RCW caption for amendatory sections and marks it as not paraphrased', () => {
    const doc = load('6137.json');
    expect(subjectOf(doc, '2')).toEqual({ text: 'Sports wagering—Defined.', paraphrased: false });
  });

  it('strips the effective-date note from a caption', () => {
    const doc = load('1163-S2.E.json');
    expect(subjectOf(doc, '1')).toEqual({ text: 'Dealer deliveries regulated—Hold on delivery—Fees authorized.', paraphrased: false });
    expect(cleanCaption('Tax on providing day care. (Effective October 1, 2024.)')).toBe('Tax on providing day care.');
  });

  it('paraphrases new sections by kind', () => {
    const doc = load('2402-S.json');
    expect(subjectOf(doc, '1')).toEqual({ text: 'Findings and declarations', paraphrased: true });
    expect(subjectOf(doc, '2')).toEqual({ text: 'Definitions', paraphrased: true });
    expect(subjectOf(doc, '3')?.text).toMatch(/^Prohibited: manufacture, sell, or distribute/);
    expect(subjectOf(doc, '4')).toEqual({ text: 'New chapter in Title 70A RCW', paraphrased: true });
    expect(subjectOf(doc, '5')).toEqual({ text: 'Severability', paraphrased: true });
  });

  it('names effective dates, expirations, repealers and boilerplate clauses', () => {
    const doc = load('2081.json');
    expect(subjectOf(doc, '501')).toEqual({ text: 'Exempt from tax preference performance review', paraphrased: true });
    expect(subjectOf(doc, '503')).toEqual({ text: 'Necessary for support of state government', paraphrased: true });
    expect(subjectOf(doc, '504')).toEqual({ text: 'Effective date: January 1, 2027', paraphrased: true });
    expect(subjectOf(doc, '506')).toEqual({ text: 'Expiration: January 1, 2034', paraphrased: true });
    expect(subjectOf(doc, '201')?.text).toMatch(/^Persons must pay a surcharge/);
    expect(subjectOf(load('1665.json'), '2')).toEqual({ text: 'Repeals 16 sections', paraphrased: true });
    expect(subjectOf(load('1163-S2.E.json'), '20')).toEqual({ text: 'Null and void unless funded', paraphrased: true });
    expect(subjectOf(load('1163-S2.E.json'), '6')).toEqual({ text: 'Rule-making authority: Washington state patrol', paraphrased: true });
  });

  it('paraphrase drops designators, cross-references and dates, then truncates at a word boundary', () => {
    expect(paraphrase('(1) Except as provided in subsection (4) of this section, beginning January 1, 2030, it is prohibited for a person to sell widgets.')).toBe('Prohibited: sell widgets');
    expect(paraphrase('This act may be known and cited as the sports wagering integrity act.')).toBe('Short title: Sports wagering integrity act');
    const long = paraphrase('The department of revenue must publish, on or before the first day of each fiscal year, a list of every taxpayer that has claimed the credit, together with the amount claimed.');
    expect(long.length).toBeLessThanOrEqual(66);
    expect(long.endsWith('…')).toBe(true);
  });
});
