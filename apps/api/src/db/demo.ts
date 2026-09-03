// Demo scenario: ten notes on ten different bills, one per workflow state, driven through the HTTP API as the
// test users so every event, notification, audit row and change request is produced the normal way.
// `wa-leg demo seed --reset` wipes the notes tables first; `docs/DEMO.md` walks through the result.
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { unfilledSlots, walk, type PMNode } from '@wa-leg/note-schema';
import { internalCall } from '../lib/internal.js';
import type { Principal } from '../modules/identity/index.js';

export interface DemoOptions {
  reset?: boolean;
  log?: (message: string) => void;
}

export interface DemoResult {
  notes: { bill: string; version: string; drafter: string; state: string; noteRevisionId: string }[];
  skipped: string[];
}

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

/** Bills the scenario needs, in the order they are used. All ship with the Legiscan dataset. */
export const DEMO_BILLS = ['HB1004', 'HB1043', 'SB5814', 'HB2081', 'SB6137', 'HB1047', 'HB2402', 'HB1019', 'HB1044', 'HB1016'];

type Values = Record<string, string | boolean>;

/** Put text (or a checkbox state) into every slot named in `values`; other slots are left as they are. */
function fill(doc: PMNode, values: Values): PMNode {
  walk(doc, (n) => {
    const id = n.attrs?.slot as string | undefined;
    if (!id || !(id in values)) return;
    const v = values[id]!;
    if (n.type === 'checkbox') {
      n.attrs = { ...n.attrs, checked: !!v };
      return;
    }
    if (n.attrs?.readonly || n.attrs?.computed) return;
    if (n.type === 'slot' || n.type === 'noteCell' || n.type === 'paragraph') n.content = String(v) ? [{ type: 'text', text: String(v) }] : [];
  });
  return doc;
}

/** Fill every remaining required slot with a neutral value so the note validates and exports. */
function fillRequired(doc: PMNode): PMNode {
  const missing = new Set(unfilledSlots(doc));
  walk(doc, (n) => {
    const id = n.attrs?.slot as string | undefined;
    if (!id || !missing.has(id)) return;
    const type = String(n.attrs?.slotType ?? '');
    if (['job-class', 'account', 'account-3char', 'revenue-source', 'wac'].includes(type)) return;
    const text = ['money', 'money-thousands', 'fte', 'int', 'pct'].includes(type) ? '0' : type === 'multiline' || n.type === 'paragraph' ? 'None.' : 'N/A';
    if (n.type === 'slot' || n.type === 'noteCell' || n.type === 'paragraph') n.content = [{ type: 'text', text }];
  });
  return doc;
}

/** Wrap the first occurrence of `anchor` in a comment mark so a thread with that id attaches to the text. */
function markText(doc: PMNode, anchor: string, commentId: string): boolean {
  let done = false;
  walk(doc, (n) => {
    if (done || !n.content) return;
    for (let i = 0; i < n.content.length; i++) {
      const c = n.content[i]!;
      if (c.type !== 'text' || !c.text) continue;
      const at = c.text.indexOf(anchor);
      if (at < 0) continue;
      const before = c.text.slice(0, at);
      const after = c.text.slice(at + anchor.length);
      const marked: PMNode = { type: 'text', text: anchor, marks: [...(c.marks ?? []), { type: 'comment', attrs: { commentId, resolved: false } }] };
      const parts: PMNode[] = [];
      if (before) parts.push({ ...c, text: before });
      parts.push(marked);
      if (after) parts.push({ ...c, text: after });
      n.content.splice(i, 1, ...parts);
      done = true;
      return false;
    }
    return;
  });
  return done;
}

const NARRATIVE: Record<string, Values> = {
  HB1004: {
    'narrative.currentLaw': 'RCW 84.36.110 exempts up to $15,000 of taxable personal property owned by each head of a family from property tax.',
    'narrative.proposal': 'Raises the head-of-family personal property exemption from $15,000 to $50,000 beginning with taxes levied for collection in 2027.',
  },
  HB1043: {
    'narrative.currentLaw': 'RCW 82.70.020 allows a B&O or public utility tax credit of 50 percent of the cost of commute trip reduction incentives, capped at $60 per employee and $100,000 per employer per year. The credit expires July 1, 2027.',
    'narrative.proposal': 'Extends the commute trip reduction credit to July 1, 2033 and raises the statewide cap from $2.75 million to $3.5 million per fiscal year.',
    'narrative.receipts.assumptions': 'The credit is fully subscribed in every year of the forecast; the increase in the statewide cap is claimed in full beginning FY 2028.',
    'receipts.gf.fy1': '0',
    'receipts.gf.fy2': '-750000',
    'receipts.gf.source': 'B&O tax',
  },
  SB5814: {
    'narrative.currentLaw': 'Retail sales tax applies to the sale of tangible personal property and to the services listed in RCW 82.04.050. Most services, including advertising and information technology services, are not subject to sales tax.',
    'narrative.proposal': 'Extends the retail sales tax to advertising services, information technology services, custom software, security services, temporary staffing and live presentations, effective October 1, 2025. Section 501 adds a use tax on the same services.',
    'narrative.receipts.assumptions': 'The estimate uses 2023 Economic Census receipts for the newly taxed NAICS codes, grown at the forecast rate for services. The impact of the temporary staffing provision is indeterminate because the share of staffing provided to exempt manufacturers is not reported.',
    'narrative.receipts.dataSources': 'Economic Census 2023; Department of Revenue excise tax returns; February 2026 forecast.',
    'narrative.receipts.estimate': 'Partially indeterminate. The known portion increases state general fund receipts by $1.1 billion in the 2025-27 biennium.',
    'narrative.effectiveDate': 'Sections 101 and 201 take effect October 1, 2025. Section 301 takes effect January 1, 2026.',
    'narrative.expenditures.assumptions': 'The department needs 4.0 FTE tax policy specialists and 6.0 FTE revenue agents to register an estimated 18,000 new taxpayers and answer questions in the first year.',
    'narrative.expenditures.year1.activities': 'Rule making, taxpayer outreach, system changes to the return for the new service categories.',
    'narrative.rules': 'The department will amend WAC 458-20-15503 (digital products) and adopt a new rule on advertising services.',
    'program.summary': 'The department will register and educate newly taxable service providers, amend rules and update its return.',
    'expenditures.gf.fy1': '1850000',
    'expenditures.gf.fy2': '1420000',
    'impact.months.state': '9',
  },
  HB2081: {
    'narrative.currentLaw': 'B&O tax rates range from 0.471 percent for retailing to 1.75 percent for service and other activities with gross income above $1 million. RCW 82.04.299 imposes the workforce education investment surcharge on advanced computing businesses, capped at $9 million.',
    'narrative.proposal': 'Raises the manufacturing, wholesaling, retailing and extracting rates to 0.5 percent, raises the advanced computing surcharge cap to $75 million, and adds a temporary 0.5 percent surcharge on businesses with Washington taxable income over $250 million for tax years 2026 through 2029.',
    'narrative.receipts.assumptions': 'Taxable income by rate class comes from the FY 2025 excise tax returns grown at the forecast rate. The surcharge on large businesses assumes 400 taxpayers exceed the $250 million threshold.',
    'narrative.receipts.dataSources': 'Excise tax returns FY 2023 through FY 2025; February 2026 forecast.',
    'narrative.receipts.estimate': 'Increases state general fund receipts by $2.1 billion in the 2025-27 biennium and $4.3 billion in the 2027-29 biennium.',
    'narrative.effectiveDate': 'Sections 101 through 108 take effect January 1, 2027. Section 201 takes effect January 1, 2026.',
    'narrative.expenditures.assumptions': 'System changes to the rate tables and return, one-time; 2.0 FTE for the surcharge audit program.',
    'narrative.expenditures.year1.activities': 'Rate table changes, return redesign, taxpayer notices.',
    'narrative.rules': 'WAC 458-20-19301 and 458-20-19302 will be amended.',
    'program.summary': 'Tax administration: rate changes, surcharge registration and audit.',
    'receipts.gf.fy1': '412000000',
    'receipts.gf.fy2': '1688000000',
    'receipts.gf.source': 'B&O tax',
    'expenditures.gf.fy1': '980000',
    'expenditures.gf.fy2': '640000',
    'impact.months.state': '6',
  },
  SB6137: {
    'narrative.currentLaw': 'Sports wagering is authorized only at tribal casinos under compacts negotiated by the Gambling Commission. Gambling revenue is not subject to state B&O tax when conducted by a federally recognized tribe.',
    'narrative.proposal': 'Authorizes sports wagering over the internet by tribal operators and names the act the sports wagering integrity act. No state tax applies to the wagers.',
    'narrative.receipts.reason': 'The bill changes gambling regulation administered by the Gambling Commission. It does not change any tax administered by the department.',
    'narrative.receipts.estimate': 'No cash receipts impact.',
    'narrative.expenditures.absorb': 'None. The department has no duties under the bill.',
    'narrative.effectiveDate': 'The bill takes effect 90 days after adjournment of the session.',
    'narrative.rules': 'None.',
    'flags.noFiscalImpact': true,
  },
  HB1047: {
    'narrative.currentLaw': 'Fire protection districts pay retail sales tax on equipment purchases. RCW 82.08.9995 exempts only certain emergency vehicles purchased by fire districts serving unincorporated areas.',
    'narrative.proposal': 'Exempts sales of fire fighting equipment, apparatus and protective gear to fire protection districts and regional fire authorities from retail sales and use tax beginning October 1, 2026.',
    'narrative.receipts.assumptions': 'Fire district equipment purchases of $46 million per year come from the State Auditor’s local government financial reports, grown at 3 percent. The state rate is 6.5 percent; local rates average 2.9 percent.',
    'narrative.receipts.dataSources': 'State Auditor local government financial reporting system, FY 2023 and FY 2024.',
    'narrative.receipts.estimate': 'Decreases state general fund receipts by $2.4 million in the 2025-27 biennium and local receipts by $1.1 million.',
    'narrative.effectiveDate': 'The bill takes effect October 1, 2026.',
    'narrative.expenditures.assumptions': 'One-time system change to add an exemption code; 0.2 FTE for taxpayer questions in the first year.',
    'narrative.expenditures.year1.activities': 'Exemption code, special notice, rule amendment.',
    'narrative.rules': 'WAC 458-20-18801 will be amended.',
    'program.summary': 'Tax administration: exemption code and taxpayer guidance.',
    'receipts.gf.fy1': '-1100000',
    'receipts.gf.fy2': '-1300000',
    'receipts.gf.source': 'Retail sales tax',
    'expenditures.gf.fy1': '46000',
    'expenditures.gf.fy2': '12000',
    'impact.months.state': '9',
  },
  HB2402: {
    'narrative.currentLaw': 'Retail sales and use tax applies to sales of medical equipment other than prescription drugs and prosthetic devices. Intravenous bags and tubing are taxable when sold to hospitals.',
    'narrative.proposal': 'Beginning January 1, 2030, prohibits the manufacture, sale or distribution of intravenous medical equipment containing intentionally added phthalates. Hospitals replacing equipment ahead of the deadline buy taxable substitutes; the substitutes cost more, which increases taxable sales.',
    'narrative.receipts.assumptions': 'Substitute products cost 12 percent more than the phthalate products they replace, based on manufacturer list prices. Washington hospitals purchase $92 million of intravenous supplies per year (American Hospital Association survey grown at 4 percent). Replacement begins in FY 2028 and is complete by the January 1, 2030 deadline.',
    'narrative.receipts.dataSources': 'American Hospital Association annual survey; Department of Health hospital financial data; manufacturer price lists.',
    'narrative.receipts.estimate': 'Increases state general fund receipts by $4.3 million in FY 2026 and $10.8 million in FY 2027, reflecting early replacement purchases.',
    'narrative.effectiveDate': 'The bill takes effect 90 days after adjournment of the session; the prohibition applies beginning January 1, 2030.',
    'narrative.expenditures.assumptions': 'The department can absorb taxpayer questions within existing resources.',
    'narrative.expenditures.year1.activities': 'None.',
    'narrative.expenditures.ongoing': 'None.',
    'narrative.rules': 'None.',
    'program.summary': 'No administrative activity.',
    'receipts.gf.fy1': '4310000',
    'receipts.gf.fy2': '10800000',
    'receipts.gf.source': 'Retail sales tax',
    'impact.months.state': '12',
  },
  HB1019: {
    'narrative.currentLaw': 'Farmers are exempt from B&O tax on wholesale sales of agricultural products they grow (RCW 82.04.330). No credit exists for equipment purchases.',
    'narrative.proposal': 'Creates a B&O tax credit of 25 percent of the cost of qualifying farm equipment, capped at $25,000 per farmer per year and $10 million statewide.',
    'narrative.receipts.assumptions': 'The statewide cap is reached in each year. Credits are claimed the year after the purchase.',
    'narrative.receipts.dataSources': 'Census of Agriculture 2022; excise tax returns.',
    'narrative.receipts.estimate': 'Decreases state general fund receipts by $10 million per fiscal year beginning FY 2027.',
    'narrative.effectiveDate': 'The bill takes effect January 1, 2027.',
    'narrative.expenditures.assumptions': '1.0 FTE to administer the credit cap and applications.',
    'narrative.expenditures.year1.activities': 'Credit application system, cap tracking, rule making.',
    'narrative.rules': 'A new rule will describe the application and cap allocation.',
    'program.summary': 'Credit administration.',
    'receipts.gf.fy1': '0',
    'receipts.gf.fy2': '-10000000',
    'receipts.gf.source': 'B&O tax',
    'expenditures.gf.fy1': '210000',
    'expenditures.gf.fy2': '160000',
    'impact.months.state': '6',
    'credit.cap': '25,000',
    'credit.rate': '25',
    'credit.statewideCap': '10,000,000',
  },
  HB1044: {
    'narrative.currentLaw': 'County treasurers retain 1.3 percent of the state real estate excise tax they collect as an administration fee (RCW 82.45.180).',
    'narrative.proposal': 'Raises the county administration fee to 1.8 percent of state REET collections.',
  },
  HB1016: {
    'narrative.currentLaw': 'RCW 82.04.4498 provides a B&O tax credit for hiring unemployed veterans; the credit expired June 30, 2023.',
    'narrative.proposal': 'Reinstates the veteran hiring credit through June 30, 2031 and extends it to spouses of active duty military members.',
  },
};

async function principals(app: FastifyInstance): Promise<Record<string, Principal>> {
  const rows = (await app.db.execute(sql`SELECT user_id, display_name, email, roles, divisions FROM users`)).rows as { user_id: string; display_name: string; email: string | null; roles: string[]; divisions: string[] }[];
  const out: Record<string, Principal> = {};
  for (const r of rows) out[r.user_id] = { userId: r.user_id, displayName: r.display_name, email: r.email ?? undefined, roles: r.roles as never, divisions: r.divisions ?? [] };
  for (const id of ['dev-drafter', 'dev-reviewer', 'dev-approver', 'dev-manager', 'dev-both', 'dev-template-editor', 'dev-exec-budget']) if (!out[id]) throw new Error(`User ${id} is missing; run "wa-leg db seed" first`);
  return out;
}

export async function seedDemo(app: FastifyInstance, opts: DemoOptions = {}): Promise<DemoResult> {
  const log = opts.log ?? (() => undefined);
  const users = await principals(app);
  const biennium = app.config.CURRENT_BIENNIUM;
  const existing = (await app.db.execute(sql`SELECT count(*)::int AS n FROM notes`)).rows[0] as { n: number };
  if (Number(existing.n) > 0) {
    if (!opts.reset) throw new Error(`${existing.n} note(s) already exist; run with --reset to replace them`);
    await app.db.execute(sql`DELETE FROM notes`);
    await app.db.execute(sql`DELETE FROM workflow_instances`);
    await app.db.execute(sql`DELETE FROM notifications`);
    await app.db.execute(sql`DELETE FROM note_locks`);
    log(`removed ${existing.n} existing note(s)`);
  }

  const result: DemoResult = { notes: [], skipped: [] };
  const drain = async () => {
    app.bus.kick();
    await app.bus.drain(5000);
    await app.bus.drain(5000);
  };
  const call = <T = unknown>(as: Principal, url: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown, headers?: Record<string, string>) => internalCall<T>(app, url, { as, method, body, headers });
  const loaded = async (id: string, code: string): Promise<boolean> => {
    try {
      const b = await call<{ versions: { code: string; status?: string }[] }>(users['dev-reviewer']!, `/bills/${biennium}/${id}`);
      return b.versions.some((v) => v.code === code);
    } catch {
      return false;
    }
  };

  interface Spec {
    bill: string;
    version: string;
    template: string;
    drafter: string;
    requestedBy: string;
    requestedHoursAgo: number;
    requestId: string;
    contact: { name: string; phone: string };
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
  const create = async (spec: Spec): Promise<string | null> => {
    if (!(await loaded(spec.bill, spec.version))) {
      result.skipped.push(`${spec.bill} ${spec.version} is not loaded`);
      log(`skip ${spec.bill}: version ${spec.version} not loaded`);
      return null;
    }
    const s = await call<{ noteRevisionId: string }>(users[spec.requestedBy]!, '/notes', 'POST', {
      billKey: `WA:${biennium}:${spec.bill}`,
      versionCode: spec.version,
      templateId: spec.template,
      drafterId: spec.drafter,
      priority: spec.priority ?? 'normal',
      request: { requestId: spec.requestId, requestedAt: ago(spec.requestedHoursAgo), legContact: spec.contact },
    });
    await drain();
    return s.noteRevisionId;
  };
  const save = async (as: Principal, id: string, edit: (doc: PMNode) => PMNode): Promise<number> => {
    const head = await call<{ version: number; mode: 'limited' | 'full'; doc: PMNode }>(as, `/notes/${id}/document`);
    const doc = edit(head.doc);
    const res = await call<{ version: number }>(as, `/notes/${id}/document`, 'PUT', { doc, mode: head.mode, clientId: 'demo-seed' }, { 'if-match': `"${head.version}"` });
    await drain();
    return res.version;
  };
  const send = async (as: Principal, id: string, event: string, comment?: string) => {
    const r = await call<{ state: string; seq: number }>(as, `/notes/${id}/transitions`, 'POST', { event, comment });
    await drain();
    return r;
  };
  const record = async (bill: string, version: string, drafter: string, id: string) => {
    const w = await call<{ state: string }>(users['dev-reviewer']!, `/notes/${id}/workflow`);
    result.notes.push({ bill, version, drafter, state: w.state, noteRevisionId: id });
    log(`${bill} ${version} · ${users[drafter]!.displayName} · ${w.state}`);
  };

  const dana = users['dev-drafter']!;
  const rae = users['dev-reviewer']!;
  const avery = users['dev-approver']!;
  const morgan = users['dev-manager']!;
  const jordan = users['dev-both']!;
  const terry = users['dev-template-editor']!;
  const blake = users['dev-exec-budget']!;

  // 1. HB 1004 — To do. Rae assigned it to Dana three hours ago.
  {
    const id = await create({ bill: 'HB1004', version: 'I', template: 'property-tax-exemption-levy', drafter: dana.userId, requestedBy: rae.userId, requestedHoursAgo: 3, requestId: '1004-1-1', contact: { name: 'Sam Staff', phone: '360-786-7101' } });
    if (id) await record('HB1004', 'I', dana.userId, id);
  }

  // 2. HB 1043 — In progress on the substitute; the note on the introduced version was superseded.
  {
    const first = await create({ bill: 'HB1043', version: 'I', template: 'tax-credit-with-cap', drafter: dana.userId, requestedBy: rae.userId, requestedHoursAgo: 50, requestId: '1043-1-1', contact: { name: 'Lee Analyst', phone: '360-786-7102' } });
    if (first) {
      await save(dana, first, (doc) => fill(doc, { 'narrative.currentLaw': NARRATIVE.HB1043!['narrative.currentLaw']! }));
      await record('HB1043', 'I', dana.userId, first);
      const next = await call<{ noteRevisionId: string }>(rae, `/notes/${first}/revisions`, 'POST', { versionCode: 'S' });
      await drain();
      await save(dana, next.noteRevisionId, (doc) => fill(doc, NARRATIVE.HB1043!));
      await record('HB1043', 'S', dana.userId, next.noteRevisionId);
    }
  }

  // 3. ESSB 5814 — Changes requested: two bullet items plus a comment thread; one item already addressed.
  {
    const id = await create({ bill: 'SB5814', version: 'S.E', template: 'indeterminate-impact', drafter: dana.userId, requestedBy: rae.userId, requestedHoursAgo: 60, requestId: '5814-3-1', contact: { name: 'Pat Fiscal', phone: '360-786-7103' }, priority: 'high' });
    if (id) {
      const anchor = 'The impact of the temporary staffing provision is indeterminate';
      await save(dana, id, (doc) => {
        fill(doc, NARRATIVE.SB5814!);
        markText(doc, anchor, 'c_demo_5814_staffing');
        return doc;
      });
      await send(dana, id, 'SUBMIT_FOR_REVIEW', 'First draft. Staffing services are indeterminate; everything else is estimated.');
      await send(rae, id, 'CLAIM_REVIEW');
      await call(rae, `/notes/${id}/comments`, 'POST', { id: 'c_demo_5814_staffing', anchorText: anchor, body: 'Indeterminate needs a reason the reader can check. Say which data source is missing and give an illustrative range.' });
      await send(rae, id, 'REQUEST_CHANGES', 'Close, but two gaps before I can approve.\n- Part II.B: add the use tax on services (section 501) to the estimate; it is described but not counted.\n- Part II.C: the 6.0 revenue agents are not explained; tie the FTE count to the 18,000 new registrations.');
      const [cr] = await call<{ id: string; items: { id: string; body: string }[] }[]>(dana, `/notes/${id}/change-requests`);
      const useTax = cr!.items.find((i) => /use tax/i.test(i.body));
      if (useTax) {
        await save(dana, id, (doc) => fill(doc, { 'narrative.receipts.estimate': 'Partially indeterminate. The known portion, including the use tax on services in section 501, increases state general fund receipts by $1.2 billion in the 2025-27 biennium.' }));
        await call(dana, `/notes/${id}/change-requests/${cr!.id}/items/${useTax.id}/address`, 'POST', { resolution: 'Added the section 501 use tax to the Part II.B estimate and the known-portion sentence; the biennial total is now $1.2 billion.' });
      }
      await record('SB5814', 'S.E', dana.userId, id);
    }
  }

  // 4. HB 2081 — Ready for review, unclaimed, and overdue.
  {
    const id = await create({ bill: 'HB2081', version: 'I', template: 'bo-rate-change', drafter: dana.userId, requestedBy: rae.userId, requestedHoursAgo: 80, requestId: '2081-1-1', contact: { name: 'Chris Counsel', phone: '360-786-7104' }, priority: 'urgent' });
    if (id) {
      await save(dana, id, (doc) => fill(doc, NARRATIVE.HB2081!));
      await send(dana, id, 'SUBMIT_FOR_REVIEW', 'Ready. The surcharge taxpayer count is the soft spot; see Part II.B assumptions.');
      await record('HB2081', 'I', dana.userId, id);
    }
  }

  // 5. SB 6137 — In review: Jordan drafted, Rae claimed.
  {
    const id = await create({ bill: 'SB6137', version: 'I', template: 'no-fiscal-impact', drafter: jordan.userId, requestedBy: rae.userId, requestedHoursAgo: 20, requestId: '6137-1-1', contact: { name: 'Robin Rules', phone: '360-786-7105' } });
    if (id) {
      await save(jordan, id, (doc) => fillRequired(fill(doc, NARRATIVE.SB6137!)));
      await send(jordan, id, 'SUBMIT_FOR_REVIEW', 'No fiscal impact; the department has no role.');
      await send(rae, id, 'CLAIM_REVIEW');
      await record('SB6137', 'I', jordan.userId, id);
    }
  }

  // 6. HB 1047 — Waiting for executive review: Rae approved with a chain of Avery then Blake.
  {
    const id = await create({ bill: 'HB1047', version: 'I', template: 'sales-use-tax-exemption', drafter: terry.userId, requestedBy: avery.userId, requestedHoursAgo: 40, requestId: '1047-1-1', contact: { name: 'Dale Districts', phone: '360-786-7106' } });
    if (id) {
      await save(terry, id, (doc) => fillRequired(fill(doc, NARRATIVE.HB1047!)));
      await send(terry, id, 'SUBMIT_FOR_REVIEW');
      await send(rae, id, 'CLAIM_REVIEW');
      await call(rae, `/notes/${id}/exec-chain`, 'PUT', { chain: [{ userId: avery.userId, division: 'RFA' }, { userId: blake.userId, division: 'Budget' }] });
      await drain();
      await send(rae, id, 'APPROVE', 'Estimate reconciled to the auditor data. To executive review.');
      await record('HB1047', 'I', terry.userId, id);
    }
  }

  // 7. SHB 2402 — Approved; the note every signed-in user sees beside the bill.
  {
    const id = await create({ bill: 'HB2402', version: 'S', template: 'sales-use-tax-exemption', drafter: dana.userId, requestedBy: rae.userId, requestedHoursAgo: 120, requestId: '2402-1-1', contact: { name: 'Jane Legislative', phone: '360-786-7100' } });
    if (id) {
      await save(dana, id, (doc) => fillRequired(fill(doc, NARRATIVE.HB2402!)));
      await send(dana, id, 'SUBMIT_FOR_REVIEW', 'Ready for review.');
      await send(rae, id, 'CLAIM_REVIEW');
      await send(rae, id, 'APPROVE', 'Approved for OFM.');
      await record('HB2402', 'S', dana.userId, id);
    }
  }

  // 8. HB 1019 — Approved by Avery after one round of changes, so the History and Changes tabs have content.
  {
    const id = await create({ bill: 'HB1019', version: 'I', template: 'tax-credit-with-cap', drafter: jordan.userId, requestedBy: avery.userId, requestedHoursAgo: 96, requestId: '1019-1-1', contact: { name: 'Ash Agriculture', phone: '360-786-7107' } });
    if (id) {
      await save(jordan, id, (doc) => fillRequired(fill(doc, { ...NARRATIVE.HB1019!, 'narrative.receipts.estimate': 'Decreases state general fund receipts by up to $10 million per fiscal year.' })));
      await send(jordan, id, 'SUBMIT_FOR_REVIEW');
      await send(avery, id, 'CLAIM_REVIEW');
      await send(avery, id, 'REQUEST_CHANGES', '- "Up to" is not an estimate. State the amount and the assumption that the cap is reached.');
      const [cr] = await call<{ id: string; items: { id: string }[] }[]>(jordan, `/notes/${id}/change-requests`);
      await save(jordan, id, (doc) => fill(doc, { 'narrative.receipts.estimate': NARRATIVE.HB1019!['narrative.receipts.estimate']! }));
      await call(jordan, `/notes/${id}/change-requests/${cr!.id}/items/${cr!.items[0]!.id}/address`, 'POST', { resolution: 'Part II.B now states $10 million per fiscal year and the cap assumption.' });
      await call(jordan, `/notes/${id}/change-requests/${cr!.id}/close`, 'POST', { resolution: 'Estimate restated as a point figure with the cap assumption.' });
      await send(jordan, id, 'SUBMIT_FOR_REVIEW', 'Restated the estimate as requested.');
      await send(avery, id, 'CLAIM_REVIEW');
      await send(avery, id, 'APPROVE');
      await record('HB1019', 'I', jordan.userId, id);
    }
  }

  // 9. HB 1044 — Cancelled by the manager.
  {
    const id = await create({ bill: 'HB1044', version: 'I', template: 'fee-increase', drafter: dana.userId, requestedBy: rae.userId, requestedHoursAgo: 30, requestId: '1044-1-1', contact: { name: 'Terry Treasurer', phone: '360-786-7108' } });
    if (id) {
      await save(dana, id, (doc) => fill(doc, NARRATIVE.HB1044!));
      await send(morgan, id, 'CANCEL', 'The bill was not scheduled for a hearing; the request was withdrawn by OFM.');
      await record('HB1044', 'I', dana.userId, id);
    }
  }

  // 10. HB 1016 — To do for Jordan, assigned an hour ago by Avery.
  {
    const id = await create({ bill: 'HB1016', version: 'I', template: 'tax-credit-with-cap', drafter: jordan.userId, requestedBy: avery.userId, requestedHoursAgo: 1, requestId: '1016-1-1', contact: { name: 'Val Veterans', phone: '360-786-7109' } });
    if (id) await record('HB1016', 'I', jordan.userId, id);
  }

  return result;
}
