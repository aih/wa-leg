import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { parseBillXml, type BillDocument } from '../src/index.js';
import type { BillType } from '@wa-leg/billref';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', 'fixtures');

export interface BillFixture {
  kind: 'bill';
  file: string;
  biennium: string;
  type: BillType;
  number: number;
  versionCode: string;
  sha256: string;
  covers: string[];
}
export interface AmendmentFixture {
  kind: 'amendment';
  file: string;
  biennium: string;
  billId: string;
  amendmentId: string;
  baseVersion: string;
  sha256: string;
  covers: string[];
}
export type Fixture = BillFixture | AmendmentFixture;

export const index = JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) as Fixture[];
export const FETCHED_AT = '2026-09-01T00:00:00.000Z';
const UPDATE = process.env.UPDATE_FIXTURES === '1';

function expectedPath(file: string): string {
  return join(FIXTURES, 'expected', file.replace(/\.xml$/, '.json'));
}

export function compare(actual: unknown, file: string): void {
  const p = expectedPath(file);
  if (UPDATE || !existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(actual, null, 1) + '\n');
  }
  const expected = JSON.parse(readFileSync(p, 'utf8'));
  expect(actual).toEqual(expected);
}

export function loadBill(f: BillFixture): BillDocument {
  const xml = readFileSync(join(FIXTURES, f.file), 'utf8');
  return parseBillXml(xml, { biennium: f.biennium, type: f.type, number: f.number, versionCode: f.versionCode, fetchedAt: FETCHED_AT, sourceHash: f.sha256 });
}

