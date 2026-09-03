// ProseMirror JSON → DOCX with the `docx` library. The mapper walks the JSON so node attributes (table roles,
// cell values, slots) are available directly (research/editor.md section 6.2).
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  Math as DocxMath,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import type { PMNode } from '@wa-leg/note-schema';
import { latexToMath } from './latex-omml.js';

export interface DocxOptions {
  title: string;
  requestId?: string | null;
  billNumber?: string | null;
  identifier?: string | null;
}

const TWIPS_PER_INCH = 1440;
const CONTENT_WIDTH = 6.5 * TWIPS_PER_INCH;

interface Ctx {
  opts: DocxOptions;
}

/** Render a note document as a .docx buffer. */
export async function docToDocx(doc: PMNode, opts: DocxOptions): Promise<Buffer> {
  const ctx: Ctx = { opts };
  const children = (doc.content ?? []).flatMap((n) => block(n, ctx));
  const footerText = ['Form FN (Rev 1/00)', opts.requestId ? `Request # ${opts.requestId}` : null, opts.billNumber ? `Bill # ${opts.billNumber}` : null, 'FNS062 Department of Revenue Fiscal Note', opts.identifier ?? null].filter(Boolean).join('   ');
  const document = new Document({
    creator: 'Fiscal Note Workbench',
    title: opts.title,
    styles: {
      default: { document: { run: { font: 'Arial', size: 20 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999', space: 2 } } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true }, paragraph: { spacing: { before: 160, after: 60 }, keepNext: true } },
        { id: 'Heading4', name: 'Heading 4', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 20, bold: true, italics: true }, paragraph: { spacing: { before: 120, after: 40 }, keepNext: true } },
        { id: 'Instruction', name: 'Form instruction', basedOn: 'Normal', run: { size: 18, italics: true, color: '555555' }, paragraph: { spacing: { after: 60 } } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: level === 0 ? '•' : level === 1 ? '–' : '·', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) },
        { reference: 'numbers', levels: [0, 1, 2].map((level) => ({ level, format: level === 1 ? LevelFormat.LOWER_LETTER : level === 2 ? LevelFormat.LOWER_ROMAN : LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 8.5 * TWIPS_PER_INCH, height: 11 * TWIPS_PER_INCH }, margin: { top: TWIPS_PER_INCH, right: TWIPS_PER_INCH, bottom: TWIPS_PER_INCH, left: TWIPS_PER_INCH } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({ children: [new TextRun({ text: footerText, size: 16 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16 })] }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

function block(n: PMNode, ctx: Ctx, list: { kind: 'bullets' | 'numbers'; level: number } | null = null): (Paragraph | Table)[] {
  switch (n.type) {
    case 'noteSection':
      return (n.content ?? []).flatMap((c) => block(c, ctx, list));
    case 'heading': {
      const level = Number(n.attrs?.level ?? 2);
      const heading = level <= 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4;
      return [new Paragraph({ heading, children: inlines(n.content ?? [], ctx) })];
    }
    case 'paragraph': {
      const cls = String(n.attrs?.cssClass ?? '');
      const opts: IParagraphOptions = {
        children: inlines(n.content ?? [], ctx),
        style: cls === 'form-instruction' ? 'Instruction' : undefined,
        numbering: list ? { reference: list.kind, level: list.level } : undefined,
        spacing: { after: 100 },
      };
      return [new Paragraph(opts)];
    }
    case 'bulletList':
    case 'orderedList': {
      const kind = n.type === 'bulletList' ? 'bullets' : 'numbers';
      const level = list ? list.level + 1 : 0;
      return (n.content ?? []).flatMap((item) => (item.content ?? []).flatMap((c) => block(c, ctx, { kind, level })));
    }
    case 'listItem':
      return (n.content ?? []).flatMap((c) => block(c, ctx, list));
    case 'blockquote':
      return (n.content ?? []).flatMap((c) => block(c, ctx, list)).map((p) => p);
    case 'noteTable':
      return [noteTable(n, ctx)];
    case 'table':
      return [genericTable(n, ctx)];
    case 'blockMath':
      return [new Paragraph({ alignment: AlignmentType.CENTER, children: [new DocxMath({ children: latexToMath(String(n.attrs?.latex ?? '')) })] })];
    case 'horizontalRule':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999' } } })];
    case 'codeBlock':
      return [new Paragraph({ children: [new TextRun({ text: textOf(n), font: 'Courier New' })] })];
    default:
      if (n.content?.length) return [new Paragraph({ children: inlines(n.content, ctx) })];
      return [];
  }
}

function textOf(n: PMNode): string {
  if (n.text !== undefined) return n.text;
  return (n.content ?? []).map(textOf).join('');
}

function inlines(nodes: PMNode[], ctx: Ctx): ParagraphChild[] {
  return nodes.flatMap((n) => inline(n, ctx));
}

function inline(n: PMNode, ctx: Ctx): ParagraphChild[] {
  switch (n.type) {
    case 'text': {
      const marks = new Set((n.marks ?? []).map((m) => m.type));
      return [new TextRun({ text: n.text ?? '', bold: marks.has('bold'), italics: marks.has('italic'), underline: marks.has('underline') ? {} : undefined, strike: marks.has('strike'), superScript: marks.has('superscript'), subScript: marks.has('subscript'), highlight: marks.has('highlight') ? 'yellow' : undefined })];
    }
    case 'slot':
      return inlines(n.content ?? [], ctx);
    case 'hardBreak':
      return [new TextRun({ break: 1 })];
    case 'billCitation':
      return [new TextRun({ text: String(n.attrs?.label ?? n.attrs?.citation ?? ''), italics: true })];
    case 'checkbox':
      return [new TextRun({ text: n.attrs?.checked ? '☒ ' : '☐ ' })];
    case 'inlineMath':
      return [new DocxMath({ children: latexToMath(String(n.attrs?.latex ?? '')) })];
    case 'image':
      return [new TextRun({ text: `[image${n.attrs?.alt ? `: ${n.attrs.alt}` : ''}]`, italics: true })];
    default:
      return n.content ? inlines(n.content, ctx) : [];
  }
}

const NUMERIC = new Set(['money', 'money-thousands', 'fte', 'int', 'pct']);

function noteTable(n: PMNode, ctx: Ctx): Table {
  const rows = n.content ?? [];
  const columns = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + Number(c.attrs?.colspan ?? 1), 0)));
  // First column (labels) takes what is left after fixed numeric columns.
  const numericWidth = Math.floor((CONTENT_WIDTH * 0.62) / Math.max(1, columns - 1));
  const columnWidths = columns === 1 ? [CONTENT_WIDTH] : [CONTENT_WIDTH - numericWidth * (columns - 1), ...Array.from({ length: columns - 1 }, () => numericWidth)];
  const tableRows = rows.map((r) => {
    const header = !!r.attrs?.header;
    const total = r.attrs?.rowKind === 'total' || !!r.attrs?.footer;
    const cells = (r.content ?? []).map((c, i) => {
      const numeric = NUMERIC.has(String(c.attrs?.slotType ?? '')) || !!c.attrs?.computed || (i > 0 && /^[\s$(),.\d-]*$/.test(textOf(c)) && textOf(c).trim() !== '');
      const span = Number(c.attrs?.colspan ?? 1);
      return new TableCell({
        columnSpan: span > 1 ? span : undefined,
        width: { size: columnWidths[i] ?? numericWidth, type: WidthType.DXA },
        shading: header ? { type: ShadingType.CLEAR, fill: 'E7E6E6' } : undefined,
        borders: total ? { top: { style: BorderStyle.SINGLE, size: 8, color: '000000' } } : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: [new Paragraph({ alignment: numeric ? AlignmentType.RIGHT : AlignmentType.LEFT, spacing: { after: 0 }, children: header || total || c.attrs?.header ? [new TextRun({ text: textOf(c), bold: true })] : inlines(c.content ?? [], ctx) })],
      });
    });
    return new TableRow({ children: cells, tableHeader: header });
  });
  return new Table({ rows: tableRows, width: { size: CONTENT_WIDTH, type: WidthType.DXA }, columnWidths, borders: thinBorders() });
}

function genericTable(n: PMNode, ctx: Ctx): Table {
  const rows = (n.content ?? []).map(
    (r) =>
      new TableRow({
        children: (r.content ?? []).map(
          (c) =>
            new TableCell({
              columnSpan: Number(c.attrs?.colspan ?? 1) > 1 ? Number(c.attrs?.colspan) : undefined,
              rowSpan: Number(c.attrs?.rowspan ?? 1) > 1 ? Number(c.attrs?.rowspan) : undefined,
              margins: { top: 40, bottom: 40, left: 80, right: 80 },
              children: (c.content ?? []).flatMap((p) => block(p, ctx)) as Paragraph[],
            }),
        ),
      }),
  );
  return new Table({ rows, width: { size: CONTENT_WIDTH, type: WidthType.DXA }, borders: thinBorders() });
}

function thinBorders() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
}
