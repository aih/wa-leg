// Text entry and deletion in the note editor: what the lock plugin lets through and what it refuses.
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Node as PMNodeModel } from '@tiptap/pm/model';
import { extensionsFor, loadTemplate, type PMNode } from '@wa-leg/note-schema';
import { lockPlugin, slotTargets } from './editorExtension';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = getSchema(extensionsFor('limited'));

const text = (s: string) => ({ type: 'text', text: s });
const slot = (attrs: Record<string, unknown>, s: string) => ({ type: 'slot', attrs, content: [text(s)] });
const cell = (attrs: Record<string, unknown>, s: string) => ({ type: 'noteCell', attrs, content: s ? [text(s)] : [] });

/** A note shaped like the templates: locked header fields, locked boilerplate, block slots, a table. */
const FIXTURE: PMNode = {
  type: 'doc',
  content: [
    {
      type: 'noteSection',
      attrs: { part: 'header' },
      content: [
        // Header field: locked paragraph, system-filled slot (Bill Number, Title, Agency).
        { type: 'paragraph', attrs: { cssClass: 'field', locked: true }, content: [text('Title: '), slot({ slot: 'bill.title', readonly: true, source: 'request' }, 'Phthalates')] },
        // Locked paragraph holding a slot the analyst fills.
        { type: 'paragraph', attrs: { cssClass: 'field', locked: true }, content: [text('Prepared by '), slot({ slot: 'preparer.name' }, 'Dana')] },
      ],
    },
    {
      type: 'noteSection',
      attrs: { part: 'I' },
      content: [
        { type: 'heading', attrs: { level: 2, locked: true }, content: [text('Part I: Estimates')] },
        { type: 'paragraph', attrs: { cssClass: 'form-instruction', locked: true }, content: [text('Check applicable boxes.')] },
        { type: 'paragraph', attrs: { slot: 'narrative.currentLaw' }, content: [text('Current law text')] },
        {
          type: 'noteTable',
          attrs: { role: 'impact-series' },
          content: [
            {
              type: 'noteRow',
              content: [
                cell({ header: true }, 'GF-State'),
                cell({ slot: 'receipts.gf.fy1', slotType: 'money' }, '1200'),
                cell({ computed: 'sum(receipts.*.fy1)', slotType: 'money' }, '1200'),
                cell({ slot: 'receipts.note', readonly: true }, 'From the request'),
              ],
            },
          ],
        },
      ],
    },
  ],
} as PMNode;

function stateOf(doc: PMNode = FIXTURE): EditorState {
  return EditorState.create({ doc: PMNodeModel.fromJSON(schema, doc), plugins: [lockPlugin()] });
}

/** Position of the first node with this slot id, and the range of its text. */
function at(state: EditorState, slotId: string): { pos: number; from: number; to: number } {
  let found: { pos: number; from: number; to: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.slot === slotId) {
      const inner = node.type.name === 'paragraph' || node.type.name === 'slot' || node.type.name === 'noteCell';
      found = { pos, from: pos + (inner ? 1 : 0), to: pos + (inner ? 1 : 0) + node.content.size };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`no slot ${slotId}`);
  return found;
}

/** Position of the first text of a locked paragraph whose text starts with `prefix`. */
function lockedText(state: EditorState, prefix: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.locked && node.isBlock && node.textContent.startsWith(prefix)) {
      found = { from: pos + 1, to: pos + 1 + node.content.size };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`no locked block ${prefix}`);
  return found;
}

/** True when the editor accepts the transaction (the lock plugin does not filter it out). */
function accepts(state: EditorState, build: (s: EditorState) => EditorState['tr']): boolean {
  const next = state.applyTransaction(build(state)).state;
  return next.doc !== state.doc;
}

const typeAt = (pos: number) => (s: EditorState) => s.tr.insertText('X', pos);
const backspaceAt = (pos: number) => (s: EditorState) => s.tr.delete(pos - 1, pos);
const clear = (from: number, to: number) => (s: EditorState) => s.tr.delete(from, to);
const replace = (from: number, to: number) => (s: EditorState) => s.tr.insertText('New', from, to);

describe('lock plugin: text entry', () => {
  it('accepts typing in an editable slot inside a locked paragraph', () => {
    const s = stateOf();
    expect(accepts(s, typeAt(at(s, 'preparer.name').to))).toBe(true);
  });

  it('accepts typing in a block slot and in an input cell', () => {
    const s = stateOf();
    expect(accepts(s, typeAt(at(s, 'narrative.currentLaw').to))).toBe(true);
    expect(accepts(s, typeAt(at(s, 'receipts.gf.fy1').to))).toBe(true);
  });

  it('refuses typing in a readonly slot, a readonly cell and a computed cell', () => {
    const s = stateOf();
    expect(accepts(s, typeAt(at(s, 'bill.title').to))).toBe(false);
    expect(accepts(s, typeAt(at(s, 'receipts.note').to))).toBe(false);
    const computed = at(s, 'receipts.gf.fy1');
    // The computed cell sits after the input cell in the same row.
    let computedPos = 0;
    s.doc.descendants((node, pos) => {
      if (node.type.name === 'noteCell' && node.attrs.computed) computedPos = pos + 1 + node.content.size;
      return node.type.name !== 'noteCell';
    });
    expect(computedPos).toBeGreaterThan(computed.to);
    expect(accepts(s, typeAt(computedPos))).toBe(false);
  });

  it('refuses typing in locked boilerplate and headings', () => {
    const s = stateOf();
    expect(accepts(s, typeAt(lockedText(s, 'Check applicable').to))).toBe(false);
    expect(accepts(s, typeAt(lockedText(s, 'Part I').to))).toBe(false);
  });
});

describe('lock plugin: deletion', () => {
  it('accepts backspace and a whole-value delete in an editable slot inside a locked paragraph', () => {
    const s = stateOf();
    const target = at(s, 'preparer.name');
    expect(accepts(s, backspaceAt(target.to))).toBe(true);
    expect(accepts(s, clear(target.from, target.to))).toBe(true);
    expect(accepts(s, replace(target.from, target.to))).toBe(true);
  });

  it('accepts deletion in a block slot and in an input cell', () => {
    const s = stateOf();
    const block = at(s, 'narrative.currentLaw');
    expect(accepts(s, backspaceAt(block.to))).toBe(true);
    expect(accepts(s, clear(block.from, block.to))).toBe(true);
    const input = at(s, 'receipts.gf.fy1');
    expect(accepts(s, backspaceAt(input.to))).toBe(true);
    expect(accepts(s, clear(input.from, input.to))).toBe(true);
  });

  it('refuses deletion in a readonly slot and a readonly cell', () => {
    const s = stateOf();
    const title = at(s, 'bill.title');
    expect(accepts(s, backspaceAt(title.to))).toBe(false);
    expect(accepts(s, clear(title.from, title.to))).toBe(false);
    const note = at(s, 'receipts.note');
    expect(accepts(s, backspaceAt(note.to))).toBe(false);
  });

  it('refuses deletion of locked boilerplate', () => {
    const s = stateOf();
    const instr = lockedText(s, 'Check applicable');
    expect(accepts(s, backspaceAt(instr.to))).toBe(false);
    expect(accepts(s, clear(instr.from, instr.to))).toBe(false);
  });

  it('refuses a selection that swallows a whole locked block', () => {
    const s = stateOf();
    const block = at(s, 'narrative.currentLaw');
    const instr = lockedText(s, 'Check applicable');
    // From inside the boilerplate's own paragraph through the block slot: the locked paragraph is inside the range.
    expect(accepts(s, clear(instr.from - 2, block.to))).toBe(false);
  });

  it('leaves the document unchanged when it refuses', () => {
    const s = stateOf();
    const title = at(s, 'bill.title');
    const after = s.applyTransaction(s.tr.delete(title.from, title.to)).state;
    expect(after.doc.textContent).toContain('Phthalates');
  });
});

describe('slot navigation', () => {
  it('offers editable slots only', () => {
    const s = stateOf();
    const ids = slotTargets(s.doc).map((t) => t.id);
    expect(ids).toContain('preparer.name');
    expect(ids).toContain('narrative.currentLaw');
    expect(ids).toContain('receipts.gf.fy1');
    expect(ids).not.toContain('bill.title');
    expect(ids).not.toContain('receipts.note');
  });
});

describe('the shipped template', () => {
  const templateDir = join(import.meta.dirname, '..', '..', '..', '..', 'design', 'templates');
  const ctx = {
    bill: { number: '2402 S HB', title: 'Phthalates/medical equipment', key: 'WA:2025-26:HB2402' },
    agency: { code: '140', name: 'Department of Revenue' },
    request: { date: '02/05/2026' },
  } as never;

  it('refuses edits to the Bill Number, Title and Agency fields and allows them in Part II', () => {
    const html = readFileSync(join(templateDir, '01-no-fiscal-impact.html'), 'utf8');
    const s = stateOf(loadTemplate(html, ctx).doc);
    for (const id of ['bill.number', 'bill.title', 'agency.display']) {
      const field = at(s, id);
      expect(accepts(s, typeAt(field.to))).toBe(false);
      expect(accepts(s, backspaceAt(field.to))).toBe(false);
      expect(accepts(s, clear(field.from, field.to))).toBe(false);
    }
    const narrative = at(s, 'narrative.currentLaw');
    expect(accepts(s, typeAt(narrative.to))).toBe(true);
    expect(accepts(s, backspaceAt(narrative.to))).toBe(true);
  });

  it('lets the analyst type and delete in every navigable slot', () => {
    const html = readFileSync(join(templateDir, '04-sales-use-tax-exemption.html'), 'utf8');
    const s = stateOf(loadTemplate(html, ctx).doc);
    const targets = slotTargets(s.doc);
    expect(targets.length).toBeGreaterThan(10);
    for (const t of targets) {
      // A list block slot points at the list; the caret goes to the nearest text position inside it.
      const pos = TextSelection.near(s.doc.resolve(t.pos)).head;
      expect(accepts(s, typeAt(pos)), `type in ${t.id}`).toBe(true);
      if (t.filled) expect(accepts(s, backspaceAt(pos)), `delete in ${t.id}`).toBe(true);
    }
  });
});
