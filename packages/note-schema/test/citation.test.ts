import { describe, expect, it } from 'vitest';
import { generateHTML } from '@tiptap/html';
import { citeKey, limitedExtensions, sameTarget } from '../src/index.js';

const base = { billKey: 'WA:2025-26:HB2402', versionCode: 'S', sectionId: 'sec-2', blockId: null, amendmentId: null };

describe('sameTarget', () => {
  it('matches when bill, version, section, block and amendment agree', () => {
    expect(sameTarget(base, { ...base })).toBe(true);
    expect(sameTarget(base, { ...base, blockId: undefined, amendmentId: undefined })).toBe(true);
  });

  it('ignores label, citation and href', () => {
    expect(sameTarget({ ...base, label: 'Sec. 2', citation: 'Section 2 of SHB 2402', href: '/a' } as never, { ...base, label: null, citation: 'x', href: '/b' } as never)).toBe(true);
  });

  it('differs on any of the five attributes', () => {
    expect(sameTarget(base, { ...base, billKey: 'WA:2025-26:HB1004' })).toBe(false);
    expect(sameTarget(base, { ...base, versionCode: 'I' })).toBe(false);
    expect(sameTarget(base, { ...base, sectionId: 'sec-1' })).toBe(false);
    expect(sameTarget(base, { ...base, blockId: 'sec-2-p1' })).toBe(false);
    expect(sameTarget(base, { ...base, amendmentId: 'AMD-1' })).toBe(false);
  });

  it('builds a key from the five attributes in order', () => {
    expect(citeKey(base)).toBe('WA:2025-26:HB2402|S|sec-2||');
    expect(citeKey({ ...base, blockId: 'sec-2-p1', amendmentId: 'AMD-1' })).toBe('WA:2025-26:HB2402|S|sec-2|sec-2-p1|AMD-1');
  });
});

describe('BillCitation HTML', () => {
  it('renders data-cite-key', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'billCitation', attrs: { ...base, label: 'Sec. 2', citation: 'Section 2 of SHB 2402', href: '/bills/2025-26/HB2402/S#sec-2' } }] }] };
    const html = generateHTML(doc, limitedExtensions());
    expect(html).toContain('data-cite-key="WA:2025-26:HB2402|S|sec-2||"');
    expect(html).toContain('data-role="bill-cite"');
  });
});
