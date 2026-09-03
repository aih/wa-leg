// Parser for lawfilesext amendment XML into an Amendment Document (design/research/leg-wa-gov-services.md
// "Amendment document structure").
import { parseXml, child, children, childText, isNode, textOf, type XNode } from './xmldom.js';
import type { AmendmentDocument, AmendmentStatus, BillSection, Instruction, InstructionLocation, InstructionOp } from './types.js';
import { normalizeSpace } from './hash.js';
import { assignIdentities } from './identity.js';
import { parseSectionForAmendment, PARSER_VERSION } from './parse-xml.js';
import { parseTitle } from './title.js';

export interface AmendmentMeta {
  biennium: string;
  billId: string;
  /** The lawfilesext name, e.g. "6137 AMS CORA S4812.1". */
  amendmentId: string;
  baseVersion: string;
  sourceUrl?: string;
  sourceHash?: string;
  fetchedAt?: string;
  /** From the index (Legiscan `adopted`), when the XML carries no floor action. */
  adopted?: boolean;
}

export function parseFloorAction(text: string | undefined): { status: AmendmentStatus; date?: string } {
  if (!text) return { status: 'unknown' };
  const t = text.trim().toUpperCase();
  const dm = /(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  const date = dm ? `${dm[3]}-${dm[1]}-${dm[2]}` : undefined;
  let status: AmendmentStatus = 'unknown';
  if (t.startsWith('NOT ADOPTED') || t.startsWith('FAILED')) status = 'failed';
  else if (t.startsWith('ADOPTED')) status = 'adopted';
  else if (t.startsWith('WITHDRAWN')) status = 'withdrawn';
  else if (t.includes('OUT OF ORDER')) status = 'ruled-out-of-order';
  else if (t === '') status = 'pending';
  return date ? { status, date } : { status };
}

const QUOTE = /"([^"]*)"/;

export function parseInstruction(text: string, seq: number): Instruction {
  const t = normalizeSpace(text);
  const location: InstructionLocation = {};
  const lower = t.toLowerCase();
  let op: InstructionOp = 'other';

  const pageLine = /(?:on|beginning on) page (\d+), (?:(after|before|at the beginning of|at the end of|beginning on|beginning) )?line (\d+)/i.exec(t);
  if (pageLine) {
    location.page = Number(pageLine[1]);
    location.line = Number(pageLine[3]);
    const a = pageLine[2]?.toLowerCase();
    if (a === 'after' || a === 'before') location.anchor = a;
    else if (a?.startsWith('at the beginning')) location.anchor = 'beginning';
    else if (a?.startsWith('at the end')) location.anchor = 'end';
  }
  const through = /through\s+"[^"]*"\s+on\s+(?:page (\d+), )?line (\d+)/i.exec(t) ?? /through line (\d+)/i.exec(t);
  if (through) {
    if (through.length === 3) {
      if (through[1]) location.pageEnd = Number(through[1]);
      location.lineEnd = Number(through[2]);
    } else location.lineEnd = Number(through[1]);
  }
  if (/of the title/i.test(t)) location.title = true;
  const anchorAfter = /(?:after|following)\s+"([^"]*)"/i.exec(t);
  const anchorBefore = /before\s+"([^"]*)"/i.exec(t);
  if (anchorAfter) {
    location.anchorText = anchorAfter[1]!;
    if (!location.anchor) location.anchor = 'after';
  } else if (anchorBefore) {
    location.anchorText = anchorBefore[1]!;
    if (!location.anchor) location.anchor = 'before';
  }
  const secNum = /(?:strike|insert)\s+(?:all of\s+)?section\s+(\d+[a-z]?)/i.exec(t);
  if (secNum) location.sectionNum = secNum[1]!;

  const strike = /strike\s+(?:all material through\s+)?"([^"]*)"/i.exec(t);
  const insertQ = /insert\s+"([^"]*)"/i.exec(t);
  const hasStrike = /\bstrike\b/i.test(lower);
  const hasInsert = /\binsert\b/i.test(lower);

  if (/strike everything after the enacting clause/i.test(t)) op = 'strike-all-insert';
  else if (/renumber the (?:remaining )?(?:sections|subsections)/i.test(t) || /reletter/i.test(t)) op = 'renumber';
  else if (/correct (?:any )?internal references/i.test(t) || /^correct the title/i.test(t)) op = 'correct-internal-references';
  else if (location.title && hasStrike && hasInsert) op = 'title-strike-insert';
  else if (location.title && hasInsert) op = 'title-insert';
  else if (/strike all of section|strike section \d/i.test(t) && !hasInsert) op = 'strike-section';
  else if (/insert the following/i.test(t) && /section/i.test(t) && !hasStrike) op = 'insert-section';
  else if (hasStrike && hasInsert) op = 'strike-insert';
  else if (hasStrike) op = 'strike';
  else if (hasInsert) op = 'insert';

  const ins: Instruction = { id: `i${seq}`, seq, text: t, op, location };
  if (strike?.[1] !== undefined) ins.strikeText = strike[1];
  else if (hasStrike) {
    const q = QUOTE.exec(t.slice(lower.indexOf('strike')));
    if (q && !/insert/i.test(t.slice(lower.indexOf('strike'), lower.indexOf('strike') + (q.index ?? 0)))) ins.strikeText = q[1]!;
  }
  if (insertQ?.[1] !== undefined) ins.insertText = insertQ[1];
  ins.resolved = { confidence: 'unresolved', note: 'No line map for this version' };
  return ins;
}

export function parseAmendmentXml(xml: string, meta: AmendmentMeta): AmendmentDocument {
  const root = parseXml(xml);
  if (root.tag !== 'Amendment') throw new Error(`Unexpected root element ${root.tag}`);
  const warnings: string[] = [];
  const title = child(root, 'AmendTitle');
  const amendTypeCode = title ? childText(title, 'AmendType') : undefined; // AMH | AMS | AMC
  const sponsorAcronym = title ? childText(title, 'SponsorAcronym') : undefined;
  const draft = title ? childText(title, 'DraftNumber') : undefined;
  const body = child(root, 'AmendBody');
  const sectionNode = body ? child(body, 'AmendSection') : undefined;
  const heading = sectionNode ? child(sectionNode, 'SectionHeading') : undefined;
  const amdType = heading ? childText(heading, 'AmendType') : undefined; // "S AMD", "H COMM AMD", "CONF"
  const amdNumber = heading ? childText(heading, 'AmendNumber') : undefined;
  const sponsors = heading ? childText(heading, 'Sponsors') : undefined;
  const floorAction = heading ? childText(heading, 'FloorAction') : undefined;
  const fa = parseFloorAction(floorAction);
  if (fa.status === 'unknown' && meta.adopted !== undefined) fa.status = meta.adopted ? 'adopted' : 'pending';

  const items = sectionNode ? children(sectionNode, 'AmendItem') : [];
  const effect = sectionNode ? child(sectionNode, 'Effect') : undefined;

  let kind: AmendmentDocument['kind'] = 'page-line';
  const instructions: Instruction[] = [];
  let bodySections: BillSection[] | undefined;
  let seq = 0;
  let sectionIndex = 0;
  for (const item of items) {
    const ps = children(item, 'P');
    const texts = ps.map((p) => normalizeSpace(textOf(p))).filter(Boolean);
    const secs = collectSections(item);
    const first = texts[0] ?? '';
    if (/strike everything after the enacting clause/i.test(first)) {
      kind = 'striking';
      bodySections = secs.map((s) => parseSectionForAmendment(s, sectionIndex++, warnings));
      stripQuoteMarks(bodySections);
      const ins = parseInstruction(first, ++seq);
      instructions.push(ins);
      continue;
    }
    // Page-and-line: the first paragraph is the instruction; further paragraphs that do not read as
    // instructions are inserted text.
    const instructionTexts = texts.length ? texts : [normalizeSpace(textOf(item))];
    let last: Instruction | null = null;
    for (const t of instructionTexts) {
      if (last && !/^(?:on page|beginning on page|renumber|reletter|correct|strike|insert|on line)/i.test(t)) {
        last.insertText = last.insertText ? `${last.insertText}\n${t}` : t;
        continue;
      }
      last = parseInstruction(t, ++seq);
      instructions.push(last);
    }
    if (secs.length) {
      const parsedSecs = secs.map((s) => parseSectionForAmendment(s, sectionIndex++, warnings));
      stripQuoteMarks(parsedSecs);
      const target = instructions[instructions.length - 1]!;
      target.insertSections = parsedSecs;
      if (target.op === 'insert' || target.op === 'other') target.op = 'insert-section';
    }
  }
  if (kind !== 'striking' && instructions.every((i) => i.location.title || i.op === 'correct-internal-references') && instructions.some((i) => i.location.title)) {
    kind = 'title';
  }
  if (bodySections) assignIdentities(bodySections);

  const chamber = amendTypeCode === 'AMH' ? 'H' : amendTypeCode === 'AMS' ? 'S' : undefined;
  const scope: AmendmentDocument['scope'] = amendTypeCode === 'AMC' || /CONF/i.test(amdType ?? '') ? 'conference' : /COMM/i.test(amdType ?? '') ? 'committee' : 'floor';

  const doc: AmendmentDocument = {
    schemaVersion: '1.0',
    id: meta.amendmentId,
    bill: { biennium: meta.biennium, id: meta.billId },
    baseVersion: meta.baseVersion,
    kind,
    scope,
    status: fa.status,
    provenance: {
      fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
      parser: 'wa-amendment-xml',
      parserVersion: PARSER_VERSION,
      warnings,
    },
  };
  if (chamber) doc.chamber = chamber;
  if (sponsors) {
    const s = sponsors.replace(/^By\s+/i, '');
    if (/^Committee on/i.test(s)) doc.committee = s.replace(/^Committee on\s+/i, '');
    else doc.sponsor = s;
  }
  if (sponsorAcronym && scope === 'committee' && !doc.committee) doc.committee = sponsorAcronym;
  if (draft) doc.drafterCode = draft;
  if (amdNumber) doc.floorNumber = amdNumber;
  if (fa.date) doc.actionDate = fa.date;
  if (effect) doc.effect = normalizeSpace(children(effect, 'P').map((p) => textOf(p)).join('\n')).replace(/^EFFECT:\s*/i, '');
  if (meta.sourceUrl) {
    doc.sourceUrls = { xml: meta.sourceUrl, htm: meta.sourceUrl.replace('/Xml/', '/Htm/').replace(/\.xml$/, '.htm'), pdf: meta.sourceUrl.replace('/Xml/', '/Pdf/').replace(/\.xml$/, '.pdf') };
  }
  if (meta.sourceHash) doc.sourceHash = meta.sourceHash;
  if (bodySections) {
    doc.body = { sections: bodySections };
    // A striker sometimes restates the title in a "Correct the title" instruction; keep the base title otherwise.
    const titleIns = instructions.find((i) => i.location.title && i.insertText);
    if (titleIns?.insertText) doc.body.header = { title: titleIns.insertText, titleActions: parseTitle(titleIns.insertText).actions };
  }
  if (instructions.length) doc.instructions = instructions;
  return doc;
}

function collectSections(item: XNode): XNode[] {
  const out: XNode[] = [];
  for (const c of item.children) {
    if (!isNode(c)) continue;
    if (c.tag === 'BillSection') out.push(c);
    else if (c.tag === 'Part') out.push(...children(c, 'BillSection'));
  }
  return out;
}

/** Amendment bodies open with a quotation mark before the first section and close with one after the last. */
function stripQuoteMarks(sections: BillSection[]): void {
  const first = sections[0];
  if (first) {
    if (first.label.startsWith('"')) first.label = first.label.slice(1);
    const r = first.introText?.[0] ?? first.blocks[0]?.runs[0];
    if (r && r.text.startsWith('"')) r.text = r.text.slice(1);
  }
  const last = sections[sections.length - 1];
  if (last) {
    const lastBlock = lastLeaf(last.blocks);
    const r = lastBlock?.runs[lastBlock.runs.length - 1];
    if (r && r.text.endsWith('"')) r.text = r.text.slice(0, -1);
  }
}

function lastLeaf(blocks: BillSection['blocks']): BillSection['blocks'][number] | undefined {
  const b = blocks[blocks.length - 1];
  if (!b) return undefined;
  return b.children.length ? lastLeaf(b.children) : b;
}
