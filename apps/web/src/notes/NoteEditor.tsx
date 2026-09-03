import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { UndoRedo } from '@tiptap/extensions';
import { extensionsFor, unfilledSlots, inventorySlots, type PMNode } from '@wa-leg/note-schema';
import type { BillCitation } from '@wa-leg/bill-document/browser';
import { ACTIVE_COMMENT_META, NoteApp, UNLOCK_META, commentRanges, moveToSlot, selectRange } from './editorExtension';
import type { EditorMode } from './api';
import 'katex/dist/katex.min.css';

export interface NoteEditorProps {
  mode: EditorMode;
  /** Initial document; later documents are applied through the handle. */
  doc: PMNode;
  readOnly?: boolean;
  /** Show the Comment tool on a read-only note (reviewers comment without editing). */
  canComment?: boolean;
  activeCommentId?: string | null;
  onChange?: (doc: PMNode) => void;
  onSaveRequest?: () => void;
  onCiteRequest?: () => void;
  onCitationActivate?: (cite: BillCitation) => void;
  onCommentRequest?: (range: { from: number; to: number }, anchorText: string) => void;
  onCommentSelect?: (commentId: string) => void;
  onSlotStatus?: (s: { filled: number; required: number; unfilled: string[] }) => void;
  children?: ReactNode;
}

export interface NoteEditorHandle {
  editor: Editor | null;
  insertCitation(c: BillCitation): void;
  /** Replace the whole document (template applied, version restored, conflict resolved). */
  setDocument(doc: PMNode, opts?: { addToHistory?: boolean }): void;
  insertContent(content: PMNode | PMNode[]): void;
  focusSlot(direction: 'next' | 'prev'): void;
  focusComment(commentId: string): void;
  setComment(commentId: string, patch: { resolved?: boolean; remove?: boolean }): void;
  applyCommentMark(range: { from: number; to: number }, commentId: string): void;
  getJSON(): PMNode;
  isEmpty(): boolean;
}

const LIMITED_TOOLS: { id: string; label: string; icon: string; run: (e: Editor) => boolean; active?: (e: Editor) => boolean; can?: (e: Editor) => boolean }[] = [
  { id: 'bold', label: 'Bold', icon: 'B', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { id: 'italic', label: 'Italic', icon: 'I', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { id: 'underline', label: 'Underline', icon: 'U', run: (e) => e.chain().focus().toggleUnderline().run(), active: (e) => e.isActive('underline') },
  { id: 'sup', label: 'Superscript', icon: 'x²', run: (e) => e.chain().focus().toggleSuperscript().run(), active: (e) => e.isActive('superscript') },
  { id: 'sub', label: 'Subscript', icon: 'x₂', run: (e) => e.chain().focus().toggleSubscript().run(), active: (e) => e.isActive('subscript') },
  { id: 'ol', label: 'Numbered list', icon: '1.', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { id: 'ul', label: 'Bullet list', icon: '•', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
];

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor(props, ref) {
  const { mode, doc, readOnly = false, canComment = false, activeCommentId = null } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [, setTick] = useState(0);

  const editor = useEditor({
    extensions: [
      ...extensionsFor(mode).map((ext) =>
        ext.name === 'mathematics'
          ? (ext as unknown as { configure: (o: unknown) => typeof ext }).configure({ katexOptions: { throwOnError: false, output: 'htmlAndMathml' } })
          : ext,
      ),
      UndoRedo,
      NoteApp.configure({ onSaveRequest: () => propsRef.current.onSaveRequest?.() }),
    ],
    content: doc as never,
    editable: !readOnly,
    editorProps: {
      attributes: { class: 'note-editor-body', spellcheck: 'true', 'aria-label': 'Fiscal note document', role: 'textbox', 'aria-multiline': 'true' },
      handleClickOn(view, _pos, node, nodePos, event) {
        if (node.type.name === 'billCitation') {
          event.preventDefault();
          propsRef.current.onCitationActivate?.(node.attrs as unknown as BillCitation);
          return true;
        }
        if (node.type.name === 'checkbox' && view.editable) {
          view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, checked: !node.attrs.checked }).setMeta(UNLOCK_META, true));
          return true;
        }
        return false;
      },
      handleClick(view, pos) {
        // Clicking inside a comment mark selects its thread.
        const $pos = view.state.doc.resolve(pos);
        const marks = $pos.marks();
        const c = marks.find((m) => m.type.name === 'comment');
        if (c) propsRef.current.onCommentSelect?.(String(c.attrs.commentId));
        return false;
      },
      handleKeyDown(view, event) {
        const sel = view.state.selection;
        if (sel instanceof NodeSelection && (event.key === 'Enter' || event.key === ' ')) {
          const node = sel.node;
          if (node.type.name === 'billCitation') {
            propsRef.current.onCitationActivate?.(node.attrs as unknown as BillCitation);
            return true;
          }
          if (node.type.name === 'checkbox' && view.editable) {
            view.dispatch(view.state.tr.setNodeMarkup(sel.from, undefined, { ...node.attrs, checked: !node.attrs.checked }).setMeta(UNLOCK_META, true));
            return true;
          }
        }
        return false;
      },
    },
    onUpdate({ editor: e }) {
      const json = e.getJSON() as PMNode;
      propsRef.current.onChange?.(json);
      reportSlots(e);
    },
    onSelectionUpdate() {
      setTick((t) => t + 1);
    },
    onTransaction() {
      setTick((t) => t + 1);
    },
    onCreate({ editor: e }) {
      reportSlots(e);
    },
  });

  const reportSlots = useCallback((e: Editor) => {
    const json = e.getJSON() as PMNode;
    const required = inventorySlots(json).filter((s) => s.required).length;
    const unfilled = unfilledSlots(json);
    propsRef.current.onSlotStatus?.({ filled: Math.max(0, required - unfilled.length), required, unfilled });
  }, []);

  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __noteEditor?: Editor | null }).__noteEditor = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(ACTIVE_COMMENT_META, activeCommentId));
  }, [editor, activeCommentId]);

  useImperativeHandle(
    ref,
    (): NoteEditorHandle => ({
      editor,
      insertCitation(c) {
        if (!editor) return;
        editor
          .chain()
          .focus()
          .insertContent({ type: 'billCitation', attrs: { billKey: c.billKey, versionCode: c.versionCode, versionLabel: c.versionLabel, sectionId: c.sectionId, blockId: c.blockId ?? null, label: c.label ?? null, citation: c.citation, href: c.href, amendmentId: c.amendmentId ?? null } })
          .insertContent(' ')
          .run();
      },
      setDocument(next, opts) {
        if (!editor) return;
        const chain = editor.chain().setMeta(UNLOCK_META, true);
        if (opts?.addToHistory === false) chain.setMeta('addToHistory', false);
        chain.setContent(next as never, { emitUpdate: true }).run();
        reportSlots(editor);
      },
      insertContent(content) {
        editor?.chain().focus().setMeta(UNLOCK_META, true).insertContent(content as never).run();
      },
      focusSlot(direction) {
        if (editor) moveToSlot(editor, direction);
      },
      focusComment(commentId) {
        if (!editor) return;
        const r = commentRanges(editor.state.doc, commentId)[0];
        if (r) selectRange(editor, r.from, r.to);
        editor.view.dispatch(editor.state.tr.setMeta(ACTIVE_COMMENT_META, commentId));
      },
      setComment(commentId, patch) {
        if (!editor) return;
        const ranges = commentRanges(editor.state.doc, commentId);
        if (ranges.length === 0) return;
        const type = editor.schema.marks.comment!;
        let tr = editor.state.tr.setMeta(UNLOCK_META, true);
        for (const r of ranges) {
          tr = tr.removeMark(r.from, r.to, type);
          if (!patch.remove) tr = tr.addMark(r.from, r.to, type.create({ commentId, resolved: patch.resolved ?? false }));
        }
        editor.view.dispatch(tr);
      },
      applyCommentMark(range, commentId) {
        if (!editor) return;
        const type = editor.schema.marks.comment!;
        editor.view.dispatch(editor.state.tr.addMark(range.from, range.to, type.create({ commentId, resolved: false })).setMeta(UNLOCK_META, true));
      },
      getJSON: () => (editor ? (editor.getJSON() as PMNode) : doc),
      isEmpty: () => !editor || editor.state.doc.textContent.trim() === '',
    }),
    [editor, doc, reportSlots],
  );

  const onCommentClick = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, ' ');
    props.onCommentRequest?.({ from, to }, text);
  };

  return (
    <div className={`note-editor mode-${mode}${readOnly ? ' read-only' : ''}`}>
      {!readOnly && editor && (
        <Toolbar>
          {LIMITED_TOOLS.map((t) => (
            <ToolButton key={t.id} label={t.label} pressed={t.active?.(editor)} onClick={() => t.run(editor)}>
              {t.icon}
            </ToolButton>
          ))}
          <span className="sep" aria-hidden="true" />
          <ToolButton label="Cite the bill section shown in the viewer" onClick={() => props.onCiteRequest?.()}>
            § Cite
          </ToolButton>
          <ToolButton label="Comment on the selection" onClick={onCommentClick} disabled={editor.state.selection.empty}>
            Comment
          </ToolButton>
          <ToolButton label="Go to the next slot" onClick={() => moveToSlot(editor, 'next')}>
            Next slot
          </ToolButton>
          <span className="sep" aria-hidden="true" />
          <ToolButton label="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
            ↶
          </ToolButton>
          <ToolButton label="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
            ↷
          </ToolButton>
          {props.children}
        </Toolbar>
      )}
      {readOnly && canComment && editor && (
        <Toolbar>
          <ToolButton label="Comment on the selection" onClick={onCommentClick} disabled={editor.state.selection.empty}>
            Comment
          </ToolButton>
        </Toolbar>
      )}
      <EditorContent editor={editor} className="note-editor-scroll" />
    </div>
  );
});

/** role=toolbar with roving tabindex: arrows move focus, Home/End jump. */
function Toolbar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (idx + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
    buttons.forEach((b, i) => (b.tabIndex = i === next ? 0 : -1));
    buttons[next]?.focus();
  };
  useEffect(() => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    buttons.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
  });
  return (
    <div className="toolbar note-toolbar" role="toolbar" aria-label="Editing" ref={ref} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

function ToolButton({ label, pressed, onClick, disabled, children }: { label: string; pressed?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="icon" aria-label={label} title={label} aria-pressed={pressed === undefined ? undefined : pressed} onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
