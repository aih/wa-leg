// TemplateContext assembly for a new note: bill version, principal, reference data.
import type { FastifyInstance } from 'fastify';
import { label as shortLabel, type BillType } from '@wa-leg/billref';
import type { TemplateContext } from '@wa-leg/note-schema';
import { internalCall } from '../../lib/internal.js';
import type { Principal } from '../identity/index.js';

export interface BillFacts {
  billKey: string;
  biennium: string;
  id: string;
  type: string;
  number: number;
  title: string;
  versions: { code: string; shortLabel: string; label: string }[];
  hearings: { hearingAt: string; cancelled: boolean }[];
}

/** "2402 S HB" as FNS prints it: number, then the version prefix letters spaced, then the type. */
export function fnsBillNumber(type: string, number: number, versionCode: string): string {
  const short = shortLabel({ type: type as BillType, number, versionCode });
  const prefix = short.replace(/\s.*$/, '').replace(new RegExp(`${type}$`), '');
  const spaced = prefix.replace(/(\d?[ES])/g, '$1 ').trim();
  const stage = /\((PL|SL)\)/.exec(short)?.[1];
  return [String(number), spaced, type, stage].filter(Boolean).join(' ');
}

const FACTS_TTL_MS = 60_000;
const factsCache = new WeakMap<FastifyInstance, Map<string, { at: number; facts: BillFacts | null }>>();

/** Bill facts, cached per process for a minute; bill events invalidate the entry (see createNotes). */
export async function fetchBillFacts(app: FastifyInstance, billKey: string, principal?: Principal): Promise<BillFacts | null> {
  let cache = factsCache.get(app);
  if (!cache) {
    cache = new Map();
    factsCache.set(app, cache);
  }
  const hit = cache.get(billKey);
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts;
  const [, biennium, id] = billKey.split(':');
  let facts: BillFacts | null = null;
  try {
    facts = await internalCall<BillFacts>(app, `/bills/${biennium}/${id}`, principal ? { as: principal } : {});
  } catch {
    facts = null;
  }
  cache.set(billKey, { at: Date.now(), facts });
  return facts;
}

export function invalidateBillFacts(app: FastifyInstance, billKey?: string): void {
  const cache = factsCache.get(app);
  if (!cache) return;
  if (billKey) cache.delete(billKey);
  else cache.clear();
}

export interface NoteContextInput {
  billKey: string;
  versionCode: string;
  noteRevisionId?: string;
}

export async function buildTemplateContext(app: FastifyInstance, input: NoteContextInput, principal: Principal | null): Promise<TemplateContext> {
  const base = await app.reference.baseContext(principal);
  const facts = await fetchBillFacts(app, input.billKey, principal ?? undefined);
  const type = facts?.type ?? input.billKey.split(':')[2]?.replace(/\d+$/, '') ?? 'HB';
  const number = facts?.number ?? Number(input.billKey.split(':')[2]?.replace(/^[A-Z]+/, '') ?? 0);
  const version = facts?.versions.find((v) => v.code === input.versionCode)?.shortLabel ?? shortLabel({ type: type as BillType, number, versionCode: input.versionCode });
  const requestDate = new Date();
  const mdY = `${String(requestDate.getMonth() + 1).padStart(2, '0')}/${String(requestDate.getDate()).padStart(2, '0')}/${requestDate.getFullYear()}`;
  return {
    ...base,
    bill: {
      number: fnsBillNumber(type, number, input.versionCode),
      numberOnly: String(number),
      version: version.replace(/\s.*$/, ''),
      title: facts?.title ?? '',
      key: input.billKey,
      versionCode: input.versionCode,
      effectiveDate: '',
      effectiveSection: '',
      prefExemptSection: '',
    },
    request: { date: mdY, id: undefined, tenYearRequested: false },
    legContact: { name: '', phone: '' },
    note: { id: input.noteRevisionId },
    prior: {},
    revision: { scope: '' },
  };
}
