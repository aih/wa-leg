// Tiptap 3 extensions for the fiscal note editor (design/research/editor.md section 3, templates/README.md).
// Two schemas over one engine: `limited` for fiscal notes sent to OFM, `full` for internal estimates.
import { Extension, Mark, Node, mergeAttributes, type Extensions } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import Superscript from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import HardBreak from '@tiptap/extension-hard-break';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Link from '@tiptap/extension-link';
import Blockquote from '@tiptap/extension-blockquote';
import CodeBlock from '@tiptap/extension-code-block';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Strike from '@tiptap/extension-strike';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';

export type EditorMode = 'limited' | 'full';

/** The subset of a DOM element the parse rules read; keeps this module free of DOM lib types. */
interface El {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement?: { tagName: string; getAttribute?(name: string): string | null } | null;
  closest?(selector: string): unknown;
}

/** Fixed note parts, in document order (templates/README.md "Document structure"). */
export const NOTE_PARTS = ['header', 'I', 'II.A', 'II.B', 'II.C', 'III', 'IV', 'V', '10YR'] as const;
export type NotePart = (typeof NOTE_PARTS)[number];
export const PART_TITLES: Record<NotePart, string> = {
  header: 'Header',
  I: 'Part I: Estimates',
  'II.A': 'Part II.A: Brief Description',
  'II.B': 'Part II.B: Cash Receipts Impact',
  'II.C': 'Part II.C: Expenditures',
  III: 'Part III: Expenditure Detail',
  IV: 'Part IV: Capital Budget Impact',
  V: 'Part V: New Rule Making Required',
  '10YR': 'Ten-Year Analysis',
};

const dataAttr = (name: string, attr = name) => ({
  default: null as string | null,
  parseHTML: (el: El) => el.getAttribute(`data-${attr}`),
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] == null || attrs[name] === false ? {} : { [`data-${attr}`]: String(attrs[name]) }),
});
const boolAttr = (name: string, attr = name) => ({
  default: false,
  parseHTML: (el: El) => el.getAttribute(`data-${attr}`) === 'true' || el.hasAttribute(`data-${attr}`) && el.getAttribute(`data-${attr}`) !== 'false',
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [`data-${attr}`]: 'true' } : {}),
});

/** `noteSection`: one Part of the note. Isolating and defining so edits never cross part boundaries. */
export const NoteSection = Node.create({
  name: 'noteSection',
  group: 'block',
  content: 'block+',
  isolating: true,
  defining: true,
  addAttributes() {
    return { part: dataAttr('part'), condition: dataAttr('condition'), title: dataAttr('title') };
  },
  parseHTML() {
    return [{ tag: 'section[data-part]' }, { tag: 'header[data-part]' }, { tag: 'section[data-role="section"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['section', mergeAttributes({ 'data-role': 'section' }, HTMLAttributes), 0];
  },
});

/** Block-level slot and lock attributes shared by paragraphs, headings and lists. */
export const BlockSlotAttributes = Extension.create({
  name: 'blockSlotAttributes',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'noteTable', 'noteRow', 'blockquote'],
        attributes: {
          locked: boolAttr('locked'),
        },
      },
      {
        types: ['paragraph', 'bulletList', 'orderedList'],
        attributes: {
          slot: dataAttr('slot'),
          slotType: dataAttr('slotType', 'type'),
          picklist: dataAttr('picklist'),
          hint: dataAttr('hint'),
          optional: boolAttr('optional'),
          readonly: boolAttr('readonly'),
          source: dataAttr('source'),
          flag: dataAttr('flag'),
          cssClass: {
            default: null as string | null,
            parseHTML: (el: El) => el.getAttribute('class'),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.cssClass ? { class: String(attrs.cssClass) } : {}),
          },
        },
      },
    ];
  },
});

/** Inline slot: an editable region bound to a data-model path. */
export const Slot = Node.create({
  name: 'slot',
  group: 'inline',
  inline: true,
  content: 'inline*',
  addAttributes() {
    return {
      slot: dataAttr('slot'),
      slotType: dataAttr('slotType', 'type'),
      required: {
        default: true,
        parseHTML: (el: El) => el.getAttribute('data-required') !== 'false' && el.getAttribute('data-optional') !== 'true',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-required': attrs.required ? 'true' : 'false' }),
      },
      hint: dataAttr('hint'),
      picklist: dataAttr('picklist'),
      lookup: dataAttr('lookup'),
      readonly: boolAttr('readonly'),
      source: dataAttr('source'),
      flag: dataAttr('flag'),
      precision: dataAttr('precision'),
      computed: dataAttr('computed'),
    };
  },
  parseHTML() {
    const notCheckbox = (el: El) => (el.hasAttribute('data-checkbox') ? false : null);
    return [
      { tag: 'span[data-slot]', getAttrs: notCheckbox },
      { tag: 'small[data-slot]' },
      { tag: 'dd[data-slot]' },
      { tag: 'span[data-computed]', getAttrs: notCheckbox },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'slot' }, HTMLAttributes), 0];
  },
});

/** Inline checkbox bound to a slot or a computed expression. */
export const Checkbox = Node.create({
  name: 'checkbox',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { slot: dataAttr('slot'), computed: dataAttr('computed'), checked: boolAttr('checked') };
  },
  parseHTML() {
    return [{ tag: 'span[data-checkbox]', priority: 60 }, { tag: 'input[type="checkbox"]', getAttrs: (el) => ({ slot: (el as El).getAttribute('data-slot'), computed: (el as El).getAttribute('data-computed'), checked: (el as El).hasAttribute('checked') }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-checkbox': 'true', class: 'checkbox', role: 'checkbox', 'aria-checked': node.attrs.checked ? 'true' : 'false', tabindex: '0' }, HTMLAttributes), node.attrs.checked ? '☒' : '☐'];
  },
});

/** Citation into a bill version, inserted from the bill viewer's CiteEvent. */
export const BillCitation = Node.create({
  name: 'billCitation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      billKey: dataAttr('billKey', 'bill'),
      versionCode: dataAttr('versionCode', 'version'),
      versionLabel: dataAttr('versionLabel', 'version-label'),
      sectionId: dataAttr('sectionId', 'section'),
      blockId: dataAttr('blockId', 'anchor'),
      label: dataAttr('label'),
      citation: dataAttr('citation'),
      amendmentId: dataAttr('amendmentId', 'amendment'),
      href: { default: null as string | null, parseHTML: (el: El) => el.getAttribute('href'), renderHTML: (attrs: Record<string, unknown>) => (attrs.href ? { href: String(attrs.href) } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'a[data-role="bill-cite"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes({ 'data-role': 'bill-cite', class: 'bill-cite' }, HTMLAttributes), node.attrs.label ?? node.attrs.citation ?? 'cite'];
  },
});

/** Structured note table (Part I, II.B series, III.A, III.B, ten-year). Rows and cells carry the template's data model. */
export const NoteTable = Node.create({
  name: 'noteTable',
  group: 'block',
  content: 'noteRow+',
  isolating: true,
  tableRole: 'table',
  addAttributes() {
    return { role: dataAttr('role'), unit: dataAttr('unit'), basis: dataAttr('basis'), scope: dataAttr('scope'), validate: dataAttr('validate'), cssClass: { default: null as string | null, parseHTML: (el: El) => el.getAttribute('class'), renderHTML: (attrs: Record<string, unknown>) => (attrs.cssClass ? { class: String(attrs.cssClass) } : {}) } };
  },
  parseHTML() {
    return [{ tag: 'table[data-role]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['table', mergeAttributes({ class: 'note-table' }, HTMLAttributes), ['tbody', 0]];
  },
});

export const NoteRow = Node.create({
  name: 'noteRow',
  content: 'noteCell+',
  tableRole: 'row',
  addAttributes() {
    return { rowKind: dataAttr('rowKind', 'row'), key: dataAttr('key'), account: dataAttr('account'), object: dataAttr('object'), index: dataAttr('index'), header: boolAttr('header'), footer: boolAttr('footer'), repeat: dataAttr('repeat') };
  },
  parseHTML() {
    return [
      { tag: 'tr', getAttrs: (el) => ({ header: !!(el as El).closest?.('thead') || (el as El).parentElement?.tagName === 'THEAD', footer: (el as El).parentElement?.tagName === 'TFOOT', repeat: (el as El).parentElement?.getAttribute?.('data-repeat') ?? null }) },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['tr', HTMLAttributes, 0];
  },
});

export const NoteCell = Node.create({
  name: 'noteCell',
  content: 'inline*',
  tableRole: 'cell',
  isolating: true,
  addAttributes() {
    return {
      header: { default: false, parseHTML: (el: El) => el.tagName === 'TH', renderHTML: () => ({}) },
      col: dataAttr('col'),
      slot: dataAttr('slot'),
      slotType: dataAttr('slotType', 'type'),
      computed: dataAttr('computed'),
      value: {
        default: null as number | null,
        parseHTML: (el: El) => {
          const v = el.getAttribute('data-value');
          return v === null || v === '' ? null : Number(v);
        },
        renderHTML: (attrs: Record<string, unknown>) => (attrs.value == null ? {} : { 'data-value': String(attrs.value) }),
      },
      lookup: dataAttr('lookup'),
      picklist: dataAttr('picklist'),
      readonly: boolAttr('readonly'),
      source: dataAttr('source'),
      precision: dataAttr('precision'),
      colspan: { default: 1, parseHTML: (el: El) => Number(el.getAttribute('colspan') ?? 1), renderHTML: (attrs: Record<string, unknown>) => (Number(attrs.colspan) > 1 ? { colspan: String(attrs.colspan) } : {}) },
      scope: { default: null as string | null, parseHTML: (el: El) => el.getAttribute('scope'), renderHTML: (attrs: Record<string, unknown>) => (attrs.scope ? { scope: String(attrs.scope) } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'td' }, { tag: 'th' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const tag = node.attrs.header ? 'th' : 'td';
    const cls = [node.attrs.computed ? 'computed' : null, node.attrs.slotType ? `type-${node.attrs.slotType}` : null].filter(Boolean).join(' ');
    return [tag, mergeAttributes(cls ? { class: cls } : {}, HTMLAttributes), 0];
  },
});

/** Review comment anchor. Thread text lives in the comments store. */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return { commentId: dataAttr('commentId', 'comment'), resolved: boolAttr('resolved') };
  },
  parseHTML() {
    return [{ tag: 'mark[data-comment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes({ class: 'comment' }, HTMLAttributes), 0];
  },
});

/** Paragraph that keeps the template's class (form-instruction, none, indeterminate, checkbox, field, table-caption). */
const NoteParagraph = Paragraph.extend({
  parseHTML() {
    return [{ tag: 'p' }, { tag: 'div', getAttrs: (el) => ((el as El).hasAttribute('data-repeat') ? false : null), priority: 40 }];
  },
});

const NoteHeading = Heading.configure({ levels: [1, 2, 3, 4] });

export function limitedExtensions(): Extensions {
  return [
    Document,
    NoteSection,
    NoteParagraph,
    Text,
    NoteHeading,
    Bold,
    Italic,
    Underline,
    Superscript,
    Subscript,
    HardBreak,
    BulletList,
    OrderedList,
    ListItem,
    NoteTable,
    NoteRow,
    NoteCell,
    Slot,
    Checkbox,
    BillCitation,
    Mathematics,
    CommentMark,
    BlockSlotAttributes,
  ];
}

export function fullExtensions(): Extensions {
  return [
    ...limitedExtensions(),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Link.configure({ openOnClick: false }),
    Blockquote,
    CodeBlock,
    HorizontalRule,
    Image,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight,
    Strike,
    TextStyle,
    Color,
  ];
}

export function extensionsFor(mode: EditorMode): Extensions {
  return mode === 'full' ? fullExtensions() : limitedExtensions();
}
