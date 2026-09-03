// Full HTML document for the HTML export and as the PDF source (research/editor.md sections 6.1 and 6.3).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { docToHtml, type EditorMode, type PMNode } from '@wa-leg/note-schema';

const require = createRequire(import.meta.url);

let katexCss: { path: string; text: string } | null = null;
function katex(): { path: string; text: string } {
  if (!katexCss) {
    const path = require.resolve('katex/dist/katex.min.css');
    katexCss = { path, text: readFileSync(path, 'utf8') };
  }
  return katexCss;
}

export interface HtmlExportOptions {
  title: string;
  mode: EditorMode;
  /** Keep comment marks (rendered as highlighted text with the thread in a footnote list). */
  comments?: Map<string, { author: string; body: string; date: Date }>;
  linkOrigin: string;
  footer: string;
  /** `file` links the KaTeX stylesheet from disk (PDF rendering); `inline` embeds it (download). */
  katex: 'file' | 'inline';
}

const PRINT_CSS = `
@page { size: letter; margin: 1in; }
html { color-scheme: light; }
body { font: 10.5pt/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
.sheet { max-width: 7.5in; margin: 0 auto; padding: 0.5in 0; }
h1 { font-size: 15pt; margin: 0 0 .4em; }
h2 { font-size: 12pt; margin: 1.2em 0 .4em; border-bottom: 1px solid #999; page-break-after: avoid; }
h3 { font-size: 11pt; margin: 1em 0 .3em; page-break-after: avoid; }
h4 { font-size: 10.5pt; font-style: italic; margin: .8em 0 .2em; }
p { margin: .3em 0; }
section[data-role="section"] { page-break-inside: auto; }
.form-instruction { font-style: italic; color: #555; font-size: 9.5pt; }
table.note-table { border-collapse: collapse; width: 100%; margin: .5em 0 1em; font-size: 9.5pt; page-break-inside: avoid; }
table.note-table th, table.note-table td { border: 1px solid #999; padding: .2em .4em; vertical-align: top; }
table.note-table thead { display: table-header-group; }
table.note-table th { background: #e7e6e6; text-align: left; }
table.note-table td.type-money, table.note-table td.type-money-thousands, table.note-table td.type-fte, table.note-table td.type-int, table.note-table td.computed { text-align: right; font-variant-numeric: tabular-nums; }
table.note-table tr[data-row="total"] td { font-weight: 700; border-top: 2px solid #000; }
.slot { border-bottom: 1px dotted #bbb; }
.checkbox { font-size: 1.1em; }
a.bill-cite { color: #1f5fa8; }
mark.comment { background: #fff0b3; }
.comments { font-size: 9pt; color: #333; border-top: 1px solid #999; margin-top: 1.5em; padding-top: .5em; }
.comments li { margin: .2em 0; }
.footer { font-size: 8pt; color: #555; margin-top: 2em; border-top: 1px solid #999; padding-top: .3em; }
@media print { .footer { display: none; } }
`;

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function docToHtmlDocument(doc: PMNode, opts: HtmlExportOptions): string {
  const body = docToHtml(doc, { mode: opts.mode, unwrapSlots: false, stripComments: !opts.comments, renderMath: true, citationsAs: 'link', linkOrigin: opts.linkOrigin });
  const k = katex();
  const style = opts.katex === 'file' ? `<link rel="stylesheet" href="file://${k.path}">` : `<style>${k.text}</style>`;
  const comments = opts.comments && opts.comments.size > 0 ? `<section class="comments" aria-label="Comments"><h2>Comments</h2><ol>${Array.from(opts.comments.entries()).map(([id, c]) => `<li id="comment-${escape(id)}"><strong>${escape(c.author)}</strong> (${c.date.toISOString().slice(0, 10)}): ${escape(c.body)}</li>`).join('')}</ol></section>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(opts.title)}</title>
${style}
<style>${PRINT_CSS}</style>
</head>
<body>
<article class="sheet note-html">
${body}
${comments}
<p class="footer">${escape(opts.footer)}</p>
</article>
</body>
</html>
`;
}
