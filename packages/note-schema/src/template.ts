// Template loader: HTML fragment + token context → ProseMirror JSON (editor.md section 4.3).
import { generateJSON } from '@tiptap/html';
import { extensionsFor, type EditorMode } from './extensions.js';
import { resolveToken, substituteTokens, type TemplateContext } from './tokens.js';
import { recompute } from './compute.js';
import { textOf, walk, type PMNode } from './doc.js';

export interface SlotInfo {
  id: string;
  required: boolean;
  hint?: string;
  type?: string;
  picklist?: string;
  readonly: boolean;
  block: boolean;
}

export interface LoadedTemplate {
  doc: PMNode;
  unknownTokens: string[];
  slots: SlotInfo[];
  /** Repeatable blocks removed from the body because the context held no rows; offered as snippets. */
  snippets: { path: string; hint?: string; html: string }[];
  warnings: string[];
}

export interface LoadOptions {
  mode?: EditorMode;
  /** Keep `data-repeat` containers whose context array is empty instead of removing them. */
  keepEmptyRepeats?: boolean;
}

const VOID_INPUT = /<input\b((?:[^>"]|"[^"]*")*)\/?>/gi;

/** Element-level transforms on the HTML string; no DOM required. */
export function preprocessTemplate(html: string, ctx: TemplateContext, opts: LoadOptions = {}): { html: string; snippets: LoadedTemplate['snippets']; warnings: string[] } {
  const warnings: string[] = [];
  const snippets: LoadedTemplate['snippets'] = [];
  let out = html.replace(/<!--[\s\S]*?-->/g, '');

  // data-condition="path": drop the section when the path is falsy.
  out = out.replace(/<(section|div)\b([^>]*)data-condition="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g, (whole, tag, pre, path, post, inner) => {
    const v = resolveToken(path, ctx as unknown as Record<string, unknown>);
    if (!v) return '';
    return `<${tag}${pre}${post}>${inner}</${tag}>`;
  });

  // data-repeat="path" containers.
  out = out.replace(/<(tbody|div|ul|ol)\b([^>]*)data-repeat="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g, (whole, tag, pre, path, post, inner) => {
    const rows = resolveToken(path, ctx as unknown as Record<string, unknown>);
    const hint = /data-hint="([^"]*)"/.exec(pre + post)?.[1];
    const optional = /data-optional="true"/.test(pre + post);
    if (Array.isArray(rows) && rows.length > 0 && tag === 'tbody') {
      // Use the first row as the pattern; one row per element with `[i]` indexes and item fields.
      const first = /<tr\b[\s\S]*?<\/tr>/.exec(inner)?.[0];
      if (!first) return whole;
      const rendered = rows
        .map((row, i) => {
          let r = first.replace(/\[0\]/g, `[${i}]`).replace(/data-index="0"/g, `data-index="${i}"`);
          if (row && typeof row === 'object') {
            const item = row as Record<string, unknown>;
            // Replace default cell text of title/salary cells with the item's values.
            if (typeof item.title === 'string') r = r.replace(/(data-slot="[^"]*\.title"[^>]*>)[^<]*/, `$1${escape(item.title)}`);
            if (item.salary !== undefined) r = r.replace(/(data-slot="[^"]*\.salary"[^>]*>)[^<]*/, `$1${escape(String(item.salary))}`);
            for (const [k, v] of Object.entries(item)) if (typeof v === 'string' || typeof v === 'number') r = r.replace(new RegExp(`\\{\\{\\s*item\\.${k}\\s*\\}\\}`, 'g'), escape(String(v)));
          }
          return r;
        })
        .join('\n');
      return `<${tag}${pre}${post}>${rendered}</${tag}>`;
    }
    if (Array.isArray(rows) && rows.length === 0 && optional && !opts.keepEmptyRepeats) {
      snippets.push({ path, hint, html: inner.trim() });
      return '';
    }
    if (rows === undefined && optional && !opts.keepEmptyRepeats) {
      snippets.push({ path, hint, html: inner.trim() });
      return '';
    }
    return `<${tag}${pre}${post}>${inner}</${tag}>`;
  });

  // <dl class="header-fields"> → field paragraphs with inline slots.
  out = out.replace(/<dl\b([^>]*)>([\s\S]*?)<\/dl>/g, (whole, attrs, inner) => {
    const pairs = [...inner.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd\b([^>]*)>([\s\S]*?)<\/dd>/g)];
    return pairs.map((m) => `<p class="field"><strong>${m[1]}</strong> <span${m[2]}>${m[3]}</span></p>`).join('\n');
  });

  // <input type="checkbox"> → inline checkbox node.
  out = out.replace(VOID_INPUT, (whole, attrs: string) => {
    if (!/type="checkbox"/.test(attrs)) return whole;
    const keep = attrs.replace(/type="checkbox"/, '').replace(/\bchecked\b/, 'data-checked="true"');
    return `<span data-checkbox="true"${keep}></span>`;
  });

  // <caption> → paragraph before the table.
  out = out.replace(/<table\b([^>]*)>\s*<caption>([\s\S]*?)<\/caption>/g, (whole, attrs, cap) => `<p class="table-caption">${cap.trim()}</p><table${attrs}>`);
  // <thead>/<tbody>/<tfoot> wrappers: mark rows, then unwrap so the row parser sees plain <tr>.
  out = out
    .replace(/<thead\b[^>]*>([\s\S]*?)<\/thead>/g, (whole, inner) => inner.replace(/<tr\b/g, '<tr data-header="true"'))
    .replace(/<tfoot\b[^>]*>([\s\S]*?)<\/tfoot>/g, (whole, inner) => inner.replace(/<tr\b/g, '<tr data-footer="true"'))
    .replace(/<\/?tbody\b[^>]*>/g, '');
  // <br> inside table headers: keep as hard breaks (Tiptap handles <br>).
  return { html: out, snippets, warnings };
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Turn a template fragment plus its token context into a ProseMirror document. */
export function loadTemplate(html: string, ctx: TemplateContext, opts: LoadOptions = {}): LoadedTemplate {
  const mode = opts.mode ?? 'limited';
  const pre = preprocessTemplate(html, ctx, opts);
  const sub = substituteTokens(pre.html, ctx as unknown as Record<string, unknown>);
  const json = generateJSON(sub.html, extensionsFor(mode)) as PMNode;
  const doc = finishTemplateDoc(json);
  const computed = recompute(doc);
  return { doc: computed.doc, unknownTokens: sub.unknownTokens, slots: inventorySlots(computed.doc), snippets: pre.snippets, warnings: pre.warnings };
}

/** Post-parse pass: lock headings and form text, keep the article's section order. */
export function finishTemplateDoc(doc: PMNode): PMNode {
  // Series cells computed from per-account fiscal years the template does not carry (fy3-fy6) become inputs in thousands.
  const slotPaths = new Set<string>();
  walk(doc, (n) => {
    if (n.attrs?.slot) slotPaths.add(String(n.attrs.slot).replace(/\[(\d+)\]/g, '.$1'));
  });
  walk(doc, (n, parents) => {
    if (n.type !== 'noteCell' || !n.attrs?.computed) return;
    const table = parents.find((p) => p.type === 'noteTable');
    if (!table || table.attrs?.role !== 'impact-series') return;
    const m = /^sum\(([a-zA-Z]+)\.\*\.fy(\d)\)\/1000$/.exec(String(n.attrs.computed));
    if (!m) return;
    const hasInput = [...slotPaths].some((p) => new RegExp(`^${m[1]}\\.[^.]+\\.fy${m[2]}$`).test(p));
    if (hasInput) return;
    const scope = String(table.attrs?.scope ?? 'impact.state');
    n.attrs = { ...n.attrs, computed: null, slot: `${scope}.fy${m[2]}`, slotType: n.attrs.slotType ?? 'money-thousands', hint: 'Enter the amount in thousands; no per-account entry exists for this year' };
  });
  walk(doc, (n, parents) => {
    if (n.type === 'heading') n.attrs = { ...n.attrs, locked: true };
    if (n.type === 'paragraph' && (n.attrs?.cssClass === 'form-instruction' || n.attrs?.cssClass === 'table-caption')) n.attrs = { ...n.attrs, locked: true };
    if (n.type === 'paragraph' && n.attrs?.readonly && n.attrs?.slot) n.attrs = { ...n.attrs, locked: true };
    // Readonly inline slots inside header fields are system-filled.
    if (n.type === 'slot' && n.attrs?.readonly) {
      const p = parents[parents.length - 1];
      if (p && p.type === 'paragraph' && p.attrs?.cssClass === 'field') p.attrs = { ...p.attrs, locked: true };
    }
  });
  return doc;
}

export function inventorySlots(doc: PMNode): SlotInfo[] {
  const out: SlotInfo[] = [];
  walk(doc, (n) => {
    const id = n.attrs?.slot as string | undefined;
    if (!id) return;
    const readonly = !!n.attrs?.readonly || !!n.attrs?.computed;
    if (n.type === 'checkbox') {
      out.push({ id, required: false, type: 'checkbox', readonly, block: false });
      return;
    }
    out.push({
      id,
      required: n.type === 'slot' ? !!n.attrs?.required && !readonly : !n.attrs?.optional && !readonly,
      hint: (n.attrs?.hint as string | undefined) ?? undefined,
      type: (n.attrs?.slotType as string | undefined) ?? undefined,
      picklist: (n.attrs?.picklist as string | undefined) ?? undefined,
      readonly,
      block: n.type !== 'slot' && n.type !== 'noteCell',
    });
    if (n.type === 'slot' || n.type === 'noteCell') return false;
    return;
  });
  return out;
}

/** True when a slot node holds user text (non-blank, and not just its hint). */
export function slotFilled(n: PMNode): boolean {
  const t = textOf(n).trim();
  if (!t) return false;
  const hint = (n.attrs?.hint as string | undefined)?.trim();
  return t !== hint;
}

/** Ids of required, unfilled slots in document order. */
export function unfilledSlots(doc: PMNode): string[] {
  const out: string[] = [];
  walk(doc, (n) => {
    const id = n.attrs?.slot as string | undefined;
    if (!id || n.type === 'checkbox' || n.attrs?.readonly || n.attrs?.computed) return;
    const required = n.type === 'slot' ? !!n.attrs?.required : !n.attrs?.optional;
    if (required && !slotFilled(n)) out.push(id);
    if (n.type === 'slot' || n.type === 'noteCell') return false;
    return;
  });
  return out;
}

/** Parse an HTML fragment (a snippet, or pasted content) into a document with the mode's schema. */
export function htmlToDoc(html: string, mode: EditorMode = 'limited'): PMNode {
  return generateJSON(html, extensionsFor(mode)) as PMNode;
}
