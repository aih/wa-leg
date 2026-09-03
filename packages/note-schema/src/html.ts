// HTML derivation from ProseMirror JSON (stored beside the JSON; the base for exports).
import { generateHTML } from '@tiptap/html';
import katex from 'katex';
import { extensionsFor, type EditorMode } from './extensions.js';
import { cloneDoc, walk, type PMNode } from './doc.js';

export interface HtmlOptions {
  mode?: EditorMode;
  /** Replace slot nodes with their text (export). */
  unwrapSlots?: boolean;
  /** Drop comment marks (export default). */
  stripComments?: boolean;
  /** Render math to KaTeX HTML+MathML instead of the data-latex span. */
  renderMath?: boolean;
  /** Replace bill citations with plain text (docx, xml) or keep the link (html, pdf). */
  citationsAs?: 'link' | 'text';
  /** Absolute origin for citation links. */
  linkOrigin?: string;
}

export function docToHtml(doc: PMNode, opts: HtmlOptions = {}): string {
  const d = cloneDoc(doc);
  if (opts.unwrapSlots || opts.stripComments || opts.citationsAs === 'text') {
    walk(d, (n) => {
      if (n.content) {
        n.content = n.content.flatMap((c) => {
          if (opts.unwrapSlots && c.type === 'slot') return c.content ?? [];
          if (opts.citationsAs === 'text' && c.type === 'billCitation') return [{ type: 'text', text: String(c.attrs?.citation ?? c.attrs?.label ?? '') }];
          return [c];
        });
      }
      if (opts.stripComments && n.marks) n.marks = n.marks.filter((m) => m.type !== 'comment');
    });
  }
  let html = generateHTML(d as never, extensionsFor(opts.mode ?? 'limited'));
  if (opts.renderMath) {
    const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    html = html.replace(/<(span|div)\b([^>]*data-type="(inline|block)-math"[^>]*)>(?:<\/\1>)?/g, (whole, tag, attrs: string, kind: string) => {
      const latex = /data-latex="([^"]*)"/.exec(attrs)?.[1];
      if (latex === undefined) return whole;
      try {
        return `<${tag}${attrs ? ' ' + attrs.trim() : ''}>${katex.renderToString(unescape(latex), { output: 'htmlAndMathml', throwOnError: false, displayMode: kind === 'block' })}</${tag}>`;
      } catch {
        return whole;
      }
    });
  }
  if (opts.citationsAs === 'link' && opts.linkOrigin) {
    html = html.replace(/(<a data-role="bill-cite"[^>]*href=")(\/[^"]*)"/g, `$1${opts.linkOrigin}$2"`);
  }
  return html;
}

/** Plain text of the document for indexing. */
export function docToText(doc: PMNode): string {
  const out: string[] = [];
  walk(doc, (n) => {
    if (n.type === 'text') out.push(n.text ?? '');
    else if (n.type === 'inlineMath' || n.type === 'blockMath') out.push(String(n.attrs?.latex ?? ''));
    else if (n.type === 'billCitation') out.push(String(n.attrs?.label ?? ''));
    else if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'noteCell' || n.type === 'listItem') out.push('\n');
  });
  return out.join(' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
}
