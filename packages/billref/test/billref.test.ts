import { describe, expect, it } from 'vitest';
import cases from './cases.json';
import {
  parse,
  parseAll,
  isBareReference,
  label,
  longLabel,
  lawfilesSuffix,
  fileSuffix,
  decodeVersion,
  versionSeq,
  parseVersionFile,
  billKey,
  parseBillKey,
  urlFor,
  lawfilesUrl,
  bienniumOf,
  type BillRef,
} from '../src/index.js';

const opts = { currentBiennium: '2025-26' };

interface Case {
  n: string;
  input: string;
  expect: Record<string, unknown> | null;
  remainder?: string;
  warning?: string;
  all?: number;
  noAmendment?: boolean;
}

describe('billref fixture table (search.md 2.6)', () => {
  expect((cases as Case[]).length).toBe(63);
  for (const c of cases as Case[]) {
    it(`#${c.n} ${JSON.stringify(c.input)}`, () => {
      const r = parse(c.input, opts);
      if (c.expect === null) {
        expect(r.ref).toBeNull();
      } else {
        expect(r.ref).not.toBeNull();
        expect(r.ref).toMatchObject(c.expect);
      }
      if (c.remainder !== undefined) expect(r.remainder).toBe(c.remainder);
      if (c.warning) expect((r.ref as BillRef).warnings.join(' ')).toContain(c.warning);
      if (c.noAmendment) expect((r.ref as BillRef).amendment).toBeUndefined();
      if (c.all !== undefined) expect(parseAll(c.input, opts)).toHaveLength(c.all);
    });
  }
});

describe('helpers', () => {
  it('isBareReference', () => {
    expect(isBareReference('shb 2402', opts)).toBe(true);
    expect(isBareReference('HB 1234 phthalates', opts)).toBe(false);
    expect(isBareReference('phthalates', opts)).toBe(false);
  });

  it('labels', () => {
    expect(label({ type: 'HB', number: 1234, versionCode: 'I' })).toBe('HB 1234');
    expect(label({ type: 'HB', number: 1234, versionCode: 'S.E' })).toBe('ESHB 1234');
    expect(label({ type: 'SB', number: 5001, versionCode: 'S2.E' })).toBe('E2SSB 5001');
    expect(label({ type: 'SB', number: 5001, versionCode: 'S.E2' })).toBe('2ESSB 5001');
    expect(label({ type: 'HB', number: 1941, versionCode: 'S.PL' }, 1)).toBe('ESHB 1941 (PL)');
    expect(label({ type: 'HB', number: 1163, versionCode: 'S2.SL' })).toBe('2SHB 1163 (SL)');
    expect(longLabel('HB', 'S.E')).toBe('Engrossed Substitute House Bill');
    expect(longLabel('SB', 'S2.PL', 1)).toBe('Engrossed Second Substitute Senate Bill (Passed Legislature)');
    expect(longLabel('HB', 'I')).toBe('House Bill');
  });

  it('file suffixes and version files', () => {
    expect(lawfilesSuffix('I')).toBe('');
    expect(fileSuffix('I')).toBe('');
    expect(lawfilesSuffix('S')).toBe('-S');
    expect(lawfilesSuffix('S2.E')).toBe('-S2.E');
    expect(lawfilesSuffix('S.E2')).toBe('-S.E2');
    expect(lawfilesSuffix('PL')).toBe('.PL');
    expect(lawfilesSuffix('S.SL')).toBe('-S.SL');
    expect(parseVersionFile('2402-S.E.pdf')).toEqual({ number: 2402, code: 'S.E' });
    expect(parseVersionFile('2402.xml')).toEqual({ number: 2402, code: 'I' });
    expect(parseVersionFile('1163-S2.PL')).toEqual({ number: 1163, code: 'S2.PL' });
    expect(parseVersionFile('4600-Apple blossom festival.pdf')).toEqual({ number: 4600, code: 'I', title: 'Apple blossom festival' });
    expect(parseVersionFile('4600-S-Martin Luther King, Jr. Way.pdf')).toEqual({ number: 4600, code: 'S', title: 'Martin Luther King, Jr. Way' });
    expect(parseVersionFile('4600.PL-Medal of Honor Bridge.pdf')).toEqual({ number: 4600, code: 'PL', title: 'Medal of Honor Bridge' });
    expect(parseVersionFile('4691-.pdf')).toEqual({ number: 4691, code: 'I' });
    expect(parseVersionFile('6137 AMS CORA S4812.1.pdf')).toBeNull();
  });

  it('decode and order versions', () => {
    expect(decodeVersion('I')).toEqual({ substitute: 0, engrossed: 0, stage: '' });
    expect(decodeVersion('S2.E')).toEqual({ substitute: 2, engrossed: 1, stage: '' });
    expect(decodeVersion('S.PL')).toEqual({ substitute: 1, engrossed: 0, stage: 'PL' });
    const order = ['SL', 'S.E', 'I', 'S2', 'PL', 'S', 'E'].sort((a, b) => versionSeq(a) - versionSeq(b));
    expect(order).toEqual(['I', 'E', 'S', 'S.E', 'S2', 'PL', 'SL']);
    expect(() => decodeVersion('X')).toThrow();
  });

  it('bill keys and urls', () => {
    expect(billKey({ biennium: '2025-26', type: 'HB', number: 2402 })).toBe('WA:2025-26:HB2402');
    expect(parseBillKey('WA:2025-26:HB2402')).toEqual({ biennium: '2025-26', type: 'HB', number: 2402, id: 'HB2402' });
    expect(parseBillKey('nope')).toBeNull();
    expect(urlFor(parse('SHB 2402', opts).ref!)).toBe('/bills/2025-26/HB2402/S');
    expect(urlFor(parse('HB 2402', opts).ref!)).toBe('/bills/2025-26/HB2402');
    expect(urlFor(parse('RCW 82.04.260', opts).ref!)).toBe('https://app.leg.wa.gov/RCW/default.aspx?cite=82.04.260');
    expect(lawfilesUrl('2025-26', 'HB', 2402, 'S')).toBe('https://lawfilesext.leg.wa.gov/biennium/2025-26/Xml/Bills/House%20Bills/2402-S.xml');
    expect(lawfilesUrl('2025-26', 'SB', 5814, 'S.PL', 'Pdf')).toBe('https://lawfilesext.leg.wa.gov/biennium/2025-26/Pdf/Bills/Senate%20Passed%20Legislature/5814-S.PL.pdf');
    expect(lawfilesUrl('2025-26', 'HB', 1069, 'SL', 'Htm')).toBe('https://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Bills/Session%20Laws/House/1069.SL.htm');
    expect(bienniumOf(2026)).toBe('2025-26');
    expect(bienniumOf(2023)).toBe('2023-24');
  });
});
