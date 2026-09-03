// Demo scenario: five notes on five bills, one per status, driven through the HTTP API as the test users so every
// transition, comment, change request and audit row is produced the normal way. `wa-leg demo seed --reset` wipes
// the notes tables first; `docs/DEMO.md` walks through the result.
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

/** The four test users (apps/dev-oidc/users.json). */
export const DEMO_USERS = ['dev-drafter', 'dev-reviewer', 'dev-committee', 'dev-both'] as const;

/** The scenario, in the order it is built. All bills ship with the Legiscan dataset. */
export const DEMO_NOTES = [
  { bill: 'HB1004', version: 'I', label: 'HB 1004', template: 'property-tax-exemption-levy', drafter: 'dev-drafter', state: 'draft' },
  { bill: 'HB2081', version: 'I', label: 'HB 2081', template: 'bo-rate-change', drafter: 'dev-drafter', state: 'in_review' },
  { bill: 'SB5814', version: 'S.E', label: 'ESSB 5814', template: 'indeterminate-impact', drafter: 'dev-drafter', state: 'changes_requested' },
  { bill: 'HB1019', version: 'I', label: 'HB 1019', template: 'tax-credit-with-cap', drafter: 'dev-both', state: 'approved' },
  { bill: 'HB2402', version: 'S', label: 'SHB 2402', template: 'sales-use-tax-exemption', drafter: 'dev-drafter', state: 'published' },
] as const;

export const DEMO_BILLS = DEMO_NOTES.map((n) => n.bill);

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
};

async function principals(app: FastifyInstance): Promise<Record<string, Principal>> {
  const rows = (await app.db.execute(sql`SELECT user_id, display_name, email, roles, divisions FROM users`)).rows as { user_id: string; display_name: string; email: string | null; roles: string[]; divisions: string[] }[];
  const out: Record<string, Principal> = {};
  for (const r of rows) out[r.user_id] = { userId: r.user_id, displayName: r.display_name, email: r.email ?? undefined, roles: r.roles as never, divisions: r.divisions ?? [] };
  for (const id of DEMO_USERS) if (!out[id]) throw new Error(`User ${id} is missing; run "wa-leg db seed" first`);
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
    log(`removed ${existing.n} existing note(s)`);
  }

  const result: DemoResult = { notes: [], skipped: [] };
  const drain = async () => {
    app.bus.kick();
    await app.bus.drain(5000);
    await app.bus.drain(5000);
  };
  const call = <T = unknown>(as: Principal, url: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET', body?: unknown, headers?: Record<string, string>) => internalCall<T>(app, url, { as, method, body, headers });
  const loaded = async (id: string, code: string): Promise<boolean> => {
    try {
      const b = await call<{ versions: { code: string; status?: string }[] }>(users['dev-reviewer']!, `/bills/${biennium}/${id}`);
      return b.versions.some((v) => v.code === code);
    } catch {
      return false;
    }
  };

  const create = async (spec: (typeof DEMO_NOTES)[number], createdBy: Principal): Promise<string | null> => {
    if (!(await loaded(spec.bill, spec.version))) {
      result.skipped.push(`${spec.bill} ${spec.version} is not loaded`);
      log(`skip ${spec.bill}: version ${spec.version} not loaded`);
      return null;
    }
    const s = await call<{ noteRevisionId: string }>(createdBy, '/notes', 'POST', { billKey: `WA:${biennium}:${spec.bill}`, versionCode: spec.version, templateId: spec.template, drafterId: spec.drafter });
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
  const send = async (as: Principal, id: string, event: string, message?: string) => {
    const r = await call<{ state: string; seq: number }>(as, `/notes/${id}/workflow`, 'POST', { event, message });
    await drain();
    return r;
  };
  const comment = async (as: Principal, id: string, commentId: string, anchorText: string, body: string) => call(as, `/notes/${id}/comments`, 'POST', { id: commentId, anchorText, body });
  const record = async (spec: (typeof DEMO_NOTES)[number], id: string) => {
    const w = await call<{ state: string }>(users['dev-reviewer']!, `/notes/${id}/workflow`);
    if (w.state !== spec.state) throw new Error(`${spec.bill}: expected ${spec.state}, got ${w.state}`);
    result.notes.push({ bill: spec.bill, version: spec.version, drafter: spec.drafter, state: w.state, noteRevisionId: id });
    log(`${spec.label} · ${users[spec.drafter]!.displayName} · ${w.state}`);
  };

  const dana = users['dev-drafter']!;
  const rae = users['dev-reviewer']!;
  const jordan = users['dev-both']!;
  const [hb1004, hb2081, sb5814, hb1019, hb2402] = DEMO_NOTES;

  // 1. HB 1004 — Draft. Rae created it for Dana; Dana has started the narrative.
  {
    const id = await create(hb1004, rae);
    if (id) {
      await save(dana, id, (doc) => fill(doc, NARRATIVE.HB1004!));
      await record(hb1004, id);
    }
  }

  // 2. HB 2081 — In review. Dana submitted with a message; no reviewer has acted yet.
  {
    const id = await create(hb2081, rae);
    if (id) {
      await save(dana, id, (doc) => fillRequired(fill(doc, NARRATIVE.HB2081!)));
      await send(dana, id, 'SUBMIT', 'Ready. The surcharge taxpayer count is the soft spot; see Part II.B assumptions.');
      await record(hb2081, id);
    }
  }

  // 3. ESSB 5814 — Changes requested by Rae, with two open comment threads for Dana to resolve.
  {
    const id = await create(sb5814, rae);
    if (id) {
      const staffing = 'The impact of the temporary staffing provision is indeterminate';
      const agents = 'The department needs 4.0 FTE tax policy specialists and 6.0 FTE revenue agents';
      await save(dana, id, (doc) => {
        fill(doc, NARRATIVE.SB5814!);
        markText(doc, staffing, 'c_demo_5814_staffing');
        markText(doc, agents, 'c_demo_5814_agents');
        return doc;
      });
      await send(dana, id, 'SUBMIT', 'First draft. Staffing services are indeterminate; everything else is estimated.');
      await comment(rae, id, 'c_demo_5814_staffing', staffing, 'Indeterminate needs a reason the reader can check. Say which data source is missing and give an illustrative range.');
      await comment(rae, id, 'c_demo_5814_agents', agents, 'Tie the 6.0 revenue agents to the 18,000 new registrations.');
      await send(rae, id, 'REQUEST_CHANGES', 'Close, but two gaps before I can approve. Part II.B: add the use tax on services (section 501) to the estimate; it is described but not counted. Part II.C: explain the revenue agent count. See the two comments.');
      await record(sb5814, id);
    }
  }

  // 4. HB 1019 — Approved after one round of changes, so History has a request and a reply.
  {
    const id = await create(hb1019, rae);
    if (id) {
      await save(jordan, id, (doc) => fillRequired(fill(doc, { ...NARRATIVE.HB1019!, 'narrative.receipts.estimate': 'Decreases state general fund receipts by up to $10 million per fiscal year.' })));
      await send(jordan, id, 'SUBMIT');
      await send(rae, id, 'REQUEST_CHANGES', '"Up to" is not an estimate. State the amount and the assumption that the cap is reached.');
      await save(jordan, id, (doc) => fill(doc, { 'narrative.receipts.estimate': NARRATIVE.HB1019!['narrative.receipts.estimate']! }));
      await send(jordan, id, 'SUBMIT', 'Part II.B now states $10 million per fiscal year and the cap assumption.');
      await send(rae, id, 'APPROVE', 'Estimate restated as a point figure. Approved.');
      await record(hb1019, id);
    }
  }

  // 5. SHB 2402 — Published; the note every signed-in user sees beside the bill and on the Published page.
  {
    const id = await create(hb2402, rae);
    if (id) {
      await save(dana, id, (doc) => fillRequired(fill(doc, NARRATIVE.HB2402!)));
      await send(dana, id, 'SUBMIT', 'Ready for review.');
      await send(rae, id, 'APPROVE', 'Approved for the Committee.');
      await send(rae, id, 'PUBLISH');
      await record(hb2402, id);
    }
  }

  return result;
}
