// App-side ProseMirror behaviour for the note editor: computed cells, locked boilerplate, slot navigation,
// slot decorations, citation remove controls, and the active comment highlight. The schema itself comes from
// `@wa-leg/note-schema`.
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNodeModel } from '@tiptap/pm/model';
import { citeKey, recompute, sameTarget, slotFilled, type CitationTarget, type PMNode } from '@wa-leg/note-schema';

export const RECOMPUTE_META = 'note:recompute';
export const UNLOCK_META = 'note:unlock';
export const ACTIVE_COMMENT_META = 'note:activeComment';

export const activeCommentKey = new PluginKey<string | null>('note-active-comment');
const slotDecoKey = new PluginKey<DecorationSet>('note-slot-decorations');
const citationControlKey = new PluginKey<DecorationSet>('note-citation-controls');

export interface SlotTarget {
  /** Position where the cursor goes. */
  pos: number;
  /** Position of the node itself, for scrolling and inspection. */
  nodePos: number;
  id: string;
  filled: boolean;
  kind: 'slot' | 'cell' | 'block';
}

/** Every editable slot in document order: inline slots, input cells, and block slots. */
export function slotTargets(doc: PMNodeModel): SlotTarget[] {
  const out: SlotTarget[] = [];
  doc.descendants((node, pos) => {
    const id = node.attrs.slot as string | null | undefined;
    if (node.type.name === 'slot') {
      if (id && !node.attrs.readonly && !node.attrs.computed) out.push({ pos: pos + 1 + node.content.size, nodePos: pos, id, filled: slotFilled(node.toJSON() as PMNode), kind: 'slot' });
      return false;
    }
    if (node.type.name === 'noteCell') {
      if (id && !node.attrs.readonly && !node.attrs.computed) out.push({ pos: pos + 1 + node.content.size, nodePos: pos, id, filled: slotFilled(node.toJSON() as PMNode), kind: 'cell' });
      return false;
    }
    if (id && (node.type.name === 'paragraph' || node.type.name === 'bulletList' || node.type.name === 'orderedList') && !node.attrs.readonly) {
      // A block slot: the cursor goes to the end of its first text position.
      const inside = node.type.name === 'paragraph' ? pos + 1 + node.content.size : pos + 1;
      out.push({ pos: inside, nodePos: pos, id, filled: slotFilled(node.toJSON() as PMNode), kind: 'block' });
      return node.type.name !== 'paragraph';
    }
    return true;
  });
  return out;
}

/** Cell positions in document order (for Tab inside a table). */
function cellTargets(doc: PMNodeModel): { pos: number; nodePos: number; editable: boolean }[] {
  const out: { pos: number; nodePos: number; editable: boolean }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'noteCell') {
      out.push({ pos: pos + 1 + node.content.size, nodePos: pos, editable: !node.attrs.computed && !node.attrs.readonly && !node.attrs.header && !node.attrs.locked });
      return false;
    }
    return true;
  });
  return out;
}

function ancestor(state: EditorState, pos: number, name: string): { node: PMNodeModel; pos: number } | null {
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type.name === name) return { node: n, pos: $pos.before(d) };
  }
  return null;
}

export function moveToSlot(editor: Editor, direction: 'next' | 'prev', onlyUnfilled = false): boolean {
  const { state } = editor;
  const targets = slotTargets(state.doc).filter((t) => !onlyUnfilled || !t.filled);
  if (targets.length === 0) return false;
  const head = state.selection.head;
  // Leave the slot the cursor is in, in either direction.
  const current = ancestor(state, head, 'slot') ?? ancestor(state, head, 'noteCell');
  const inCurrent = (t: SlotTarget) => !!current && t.nodePos === current.pos;
  let target: SlotTarget | undefined;
  if (direction === 'next') target = targets.find((t) => t.nodePos > head - 1 && !inCurrent(t) && (current ? t.nodePos > current.pos : true)) ?? targets[0];
  else {
    const before = targets.filter((t) => (current ? t.nodePos < current.pos : t.nodePos < head - 1) && !inCurrent(t));
    target = before[before.length - 1] ?? targets[targets.length - 1];
  }
  if (!target) return false;
  editor.chain().focus().setTextSelection(target.pos).scrollIntoView().run();
  return true;
}

function moveToCell(editor: Editor, direction: 'next' | 'prev'): boolean {
  const { state } = editor;
  const cell = ancestor(state, state.selection.head, 'noteCell');
  if (!cell) return false;
  const cells = cellTargets(state.doc);
  const idx = cells.findIndex((c) => c.nodePos === cell.pos);
  if (idx < 0) return false;
  const table = ancestor(state, state.selection.head, 'noteTable');
  const step = direction === 'next' ? 1 : -1;
  for (let i = idx + step; i >= 0 && i < cells.length; i += step) {
    const c = cells[i]!;
    if (table && (c.nodePos < table.pos || c.nodePos > table.pos + table.node.nodeSize)) break;
    if (c.editable) {
      editor.chain().focus().setTextSelection(c.pos).scrollIntoView().run();
      return true;
    }
  }
  // Past the table's last editable cell: continue with the next slot.
  return moveToSlot(editor, direction);
}

/** Recompute computed cells after every change, writing formatted text and canonical values back. */
function recomputePlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('note-recompute'),
    appendTransaction(transactions, _old, newState) {
      if (transactions.some((t) => t.getMeta(RECOMPUTE_META))) return null;
      if (!transactions.some((t) => t.docChanged || t.selectionSet)) return null;
      const json = newState.doc.toJSON() as PMNode;
      const result = recompute(json);
      // Pair the old and new cells/checkboxes in document order: recompute never adds or removes nodes.
      const oldNodes: { node: PMNodeModel; pos: number }[] = [];
      newState.doc.descendants((node, pos) => {
        if (node.type.name === 'noteCell' || node.type.name === 'checkbox') oldNodes.push({ node, pos });
        return node.type.name !== 'noteCell';
      });
      const newNodes: PMNode[] = [];
      const walk = (n: PMNode) => {
        if (n.type === 'noteCell' || n.type === 'checkbox') {
          newNodes.push(n);
          if (n.type === 'noteCell') return;
        }
        for (const c of n.content ?? []) walk(c);
      };
      walk(result.doc);
      if (oldNodes.length !== newNodes.length) return null;
      // Leave the cell being typed in alone; it is formatted when the cursor leaves it.
      const active = ancestor(newState, newState.selection.head, 'noteCell');
      const tr = newState.tr;
      let touched = false;
      for (let i = oldNodes.length - 1; i >= 0; i--) {
        const { node, pos } = oldNodes[i]!;
        const next = newNodes[i]!;
        if (node.type.name === 'checkbox') {
          const checked = !!next.attrs?.checked;
          if (!!node.attrs.checked !== checked) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
            touched = true;
          }
          continue;
        }
        if (active && active.pos === pos && !node.attrs.computed) continue;
        const newText = (next.content ?? []).map((c) => c.text ?? '').join('');
        const oldText = node.textContent;
        const newValue = (next.attrs?.value as number | null | undefined) ?? null;
        const oldValue = (node.attrs.value as number | null | undefined) ?? null;
        if (newText !== oldText) {
          const from = pos + 1;
          const to = pos + 1 + node.content.size;
          if (newText) tr.replaceWith(from, to, newState.schema.text(newText));
          else tr.delete(from, to);
          touched = true;
        }
        if (newValue !== oldValue) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, value: newValue });
          touched = true;
        }
      }
      if (!touched) return null;
      tr.setMeta(RECOMPUTE_META, true);
      tr.setMeta('addToHistory', false);
      return tr;
    },
  });
}

/** Refuse edits inside locked boilerplate and computed cells unless the transaction says otherwise. */
function lockPlugin(): Plugin {
  const isProtected = (state: EditorState, pos: number): boolean => {
    const $pos = state.doc.resolve(Math.min(Math.max(pos, 0), state.doc.content.size));
    for (let d = $pos.depth; d > 0; d--) {
      const n = $pos.node(d);
      if (n.type.name === 'slot') return false; // slots inside locked text stay editable
      if (n.type.name === 'noteCell') {
        if (n.attrs.computed || n.attrs.readonly) return true;
        return false;
      }
      if (n.attrs.locked) return true;
    }
    return false;
  };
  return new Plugin({
    key: new PluginKey('note-lock'),
    filterTransaction(tr: Transaction, state: EditorState) {
      if (!tr.docChanged) return true;
      if (tr.getMeta(UNLOCK_META) || tr.getMeta(RECOMPUTE_META)) return true;
      for (const step of tr.steps) {
        const s = step as unknown as { from?: number; to?: number; pos?: number };
        const from = s.from ?? s.pos;
        const to = s.to ?? s.pos;
        if (from === undefined || to === undefined) continue;
        if (isProtected(state, from) || (to !== from && isProtected(state, Math.max(from, to - 1)))) return false;
        let blocked = false;
        if (to > from) {
          state.doc.nodesBetween(from, to, (node) => {
            if (blocked) return false;
            if (node.attrs?.locked && node.type.name !== 'slot') {
              // A locked block wholly inside the range is being deleted or replaced.
              blocked = true;
              return false;
            }
            return true;
          });
        }
        if (blocked) return false;
      }
      return true;
    },
  });
}

/** Decorations: unfilled slots (with their hint), empty input cells, and the active comment. */
function decorationPlugin(): Plugin<DecorationSet> {
  const build = (doc: PMNodeModel): DecorationSet => {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      const id = node.attrs.slot as string | null | undefined;
      if (node.type.name === 'slot') {
        if (id && !node.attrs.readonly && !node.attrs.computed) {
          const filled = slotFilled(node.toJSON() as PMNode);
          if (!filled) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'slot-empty', 'data-hint': String(node.attrs.hint ?? id), 'aria-label': `${node.attrs.required ? 'Required' : 'Optional'}: ${node.attrs.hint ?? id}` }));
        }
        return false;
      }
      if (node.type.name === 'noteCell') {
        if (id && !node.attrs.readonly && !node.attrs.computed && node.content.size === 0) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'slot-empty cell-empty' }));
        // Computed cells are not editable: the caret skips them and screen readers announce them as read-only text.
        if (node.attrs.computed) decos.push(Decoration.node(pos, pos + node.nodeSize, { contenteditable: 'false', title: 'Computed' }));
        return false;
      }
      if (id && (node.type.name === 'paragraph' || node.type.name === 'bulletList' || node.type.name === 'orderedList') && !node.attrs.readonly) {
        if (!slotFilled(node.toJSON() as PMNode)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'slot-empty block-slot-empty', 'data-hint': String(node.attrs.hint ?? id) }));
        return node.type.name !== 'paragraph';
      }
      if (node.attrs.locked) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'locked' }));
      return true;
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin<DecorationSet>({
    key: slotDecoKey,
    state: {
      init: (_c, state) => build(state.doc),
      apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
    },
    props: {
      decorations(state) {
        return slotDecoKey.getState(state) ?? null;
      },
    },
  });
}

/** The display label of a citation node: the full citation string, or the short label. */
export function citationLabel(node: PMNodeModel): string {
  return String(node.attrs.citation ?? node.attrs.label ?? 'citation');
}

/** Position of the first citation whose target matches, or null. */
export function findCitation(doc: PMNodeModel, target: CitationTarget): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'billCitation' && sameTarget(node.attrs as CitationTarget, target)) found = pos;
    return node.type.name !== 'billCitation';
  });
  return found;
}

function removeControl(view: EditorView, getPos: () => number | undefined, label: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cite-remove';
  btn.textContent = '×';
  btn.setAttribute('aria-label', `Remove citation ${label}`);
  btn.title = `Remove citation ${label}`;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const at = getPos();
    if (at === undefined) return;
    const node = view.state.doc.nodeAt(at - 1);
    if (!node || node.type.name !== 'billCitation') return;
    view.dispatch(view.state.tr.delete(at - 1, at).scrollIntoView());
    view.focus();
  });
  return btn;
}

/** A remove control after every citation while the editor is editable. Decorations stay out of the document. */
function citationControlPlugin(editor: Editor): Plugin<DecorationSet> {
  let cache: { doc: PMNodeModel; set: DecorationSet } | null = null;
  const build = (doc: PMNodeModel): DecorationSet => {
    if (cache && cache.doc === doc) return cache.set;
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== 'billCitation') return true;
      const label = citationLabel(node);
      decos.push(Decoration.widget(pos + node.nodeSize, (view, getPos) => removeControl(view, getPos, label), { side: -1, key: `cite-remove:${citeKey(node.attrs as CitationTarget)}:${label}`, stopEvent: () => true, ignoreSelection: true }));
      return false;
    });
    cache = { doc, set: DecorationSet.create(doc, decos) };
    return cache.set;
  };
  return new Plugin<DecorationSet>({
    key: citationControlKey,
    props: {
      decorations(state) {
        return editor.isEditable ? build(state.doc) : null;
      },
    },
  });
}

function activeCommentPlugin(): Plugin<string | null> {
  return new Plugin<string | null>({
    key: activeCommentKey,
    state: {
      init: () => null,
      apply: (tr, old) => (tr.getMeta(ACTIVE_COMMENT_META) !== undefined ? (tr.getMeta(ACTIVE_COMMENT_META) as string | null) : old),
    },
    props: {
      decorations(state) {
        const active = activeCommentKey.getState(state);
        if (!active) return null;
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isText) return true;
          if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.commentId === active)) decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'comment-active' }));
          return false;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

export interface NoteAppOptions {
  onSaveRequest?: () => void;
}

export const NoteApp = Extension.create<NoteAppOptions>({
  name: 'noteApp',
  addOptions() {
    return { onSaveRequest: undefined };
  },
  addProseMirrorPlugins() {
    return [lockPlugin(), recomputePlugin(), decorationPlugin(), citationControlPlugin(this.editor), activeCommentPlugin()];
  },
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => (ancestor(editor.state, editor.state.selection.head, 'noteCell') ? moveToCell(editor, 'next') : moveToSlot(editor, 'next')),
      'Shift-Tab': ({ editor }) => (ancestor(editor.state, editor.state.selection.head, 'noteCell') ? moveToCell(editor, 'prev') : moveToSlot(editor, 'prev')),
      'Mod-]': ({ editor }) => moveToSlot(editor, 'next', true),
      'Mod-[': ({ editor }) => moveToSlot(editor, 'prev', true),
      'Mod-s': () => {
        this.options.onSaveRequest?.();
        return true;
      },
      'Mod-Shift-u': ({ editor }) => {
        // Unwrap the slot at the cursor into plain text.
        const s = ancestor(editor.state, editor.state.selection.head, 'slot');
        if (!s) return false;
        const tr = editor.state.tr;
        tr.replaceWith(s.pos, s.pos + s.node.nodeSize, s.node.content);
        tr.setMeta(UNLOCK_META, true);
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});

/** Range(s) of a comment mark. */
export function commentRanges(doc: PMNodeModel, commentId: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.commentId === commentId)) {
      const last = out[out.length - 1];
      if (last && last.to === pos) last.to = pos + node.nodeSize;
      else out.push({ from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  return out;
}

export function selectRange(editor: Editor, from: number, to: number): void {
  const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)).scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.focus();
}
