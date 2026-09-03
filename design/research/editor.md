# Fiscal note editor: library evaluation and module design

Date: 2026-09-02. Versions and dates below were read from the npm registry and vendor documentation on this date. Sizes are npm "unpacked" sizes (all builds, source maps, fonts), not shipped bundle sizes; treat them as relative indicators only.

## 1. Summary and recommendation

### Editor

**Primary: Tiptap 3 (`@tiptap/core` 3.31.0, 2026-09-01, MIT) on ProseMirror (`prosemirror-view` 1.42.3, `prosemirror-model` 1.25.11, MIT).**

- ProseMirror enforces a schema. The "limited" fiscal-note editor and the "full" estimate editor are two schemas over one engine; content that violates the schema cannot be typed, pasted, or imported.
- Tables come from `prosemirror-tables` 1.8.5 through `@tiptap/extension-table` 3.31.0 (MIT): rowspan/colspan merging, cell selection, header rows and columns, column resizing.
- `@tiptap/extension-mathematics` 3.31.0 is MIT since June 2025 and provides inline and block math nodes rendered with KaTeX, serialized as `data-type="inline-math" data-latex="..."`.
- Custom nodes (estimate table, assumption list, bill citation, slot, comment mark) are declared with `parseHTML`/`renderHTML` rules, so the template HTML format (`data-slot`, `data-role`) round-trips without a separate converter. React node views render the estimate table with computed totals.
- `@tiptap/html` 3.31.0 converts JSON to HTML and HTML to JSON in Node without a DOM, which the export pipeline uses server-side.
- Yjs binding (`@tiptap/extension-collaboration`, `y-prosemirror` 1.3.7, `@hocuspocus/server` 4.6.0) is MIT if collaboration is added later.
- Paid parts of Tiptap are not needed: Comments, Snapshot Compare, document history and DOCX conversion require Tiptap Cloud (Start $59/mo, Team $179/mo; on-premises only on Enterprise). This design replaces each with an open-source implementation (section 5 and 6).

**Fallback: Lexical 0.50.0 (2026-09-02, MIT, Meta) with `@lexical/react` and `@lexical/table`.** Lexical has a node registry that can enforce a limited node set, `@lexical/table` supports colSpan/rowSpan at the node level, and `@lexical/html` handles import/export. Its gaps are the reason it is the fallback: the merge/split UI and column resizer live in the playground rather than a published package, nested tables are unsupported, there is no published math package (the playground `EquationsPlugin` must be copied), and every custom node needs hand-written `importDOM`/`exportDOM`.

Not recommended, with the deciding reason: CKEditor 5 48.5.0 and TinyMCE 8.9.0 are GPL-2+ with a mandatory license key, and the features this project needs beyond the core (track changes, comments, revision history, math, Word/PDF export, spell check) are commercial add-ons in both. BlockNote 0.54.0 is MPL-2.0 but its comments require Yjs collaboration and its DOCX exporter is in the GPL-3/commercial XL packages. Plate (`@platejs/*` 53.x, MIT) is viable but adds a Slate layer whose schema enforcement is weaker than ProseMirror's. Milkdown stores Markdown, which cannot carry `data-role` attributes or merged cells. Quill 2.0.3 has no table format. Editor.js tables have no merged cells and its math plugin was last published in 2021. Remirror is in maintenance mode (its authors point to ProseKit). Jodit edits raw HTML without a schema. Trix has no tables. Summernote is jQuery-based, last released 2024-10. Froala is commercial and excluded.

### Math input

**Render: KaTeX 0.18.5 (2026-08-31, MIT)** with `output: 'htmlAndMathml'` so each formula carries a MathML tree for screen readers and for the docx converter.

**Edit: MathLive 0.110.0 (2026-06-09, MIT)** `<math-field>` in a popover attached to the selected math node. MathLive gives a visual LaTeX editor, a virtual keyboard, keyboard shortcuts, and math-to-speech; it emits LaTeX, MathML, and MathJSON. It runs in the popover rather than inside the ProseMirror node view; ProseMirror discussions document focus and selection conflicts when a `<math-field>` is embedded as an inline atomic node, and the popover avoids them.

**Fallback: KaTeX render with a plain LaTeX textarea popover**, which is the pattern the Tiptap Mathematics docs demonstrate. MathJax 4.1.3 (Apache-2.0) is not used: it is larger and slower for the same LaTeX subset and KaTeX already emits MathML.

### License notes

Everything in the recommended stack is MIT or BSD except: pandoc (GPL-2+, run as a separate executable, not linked), LibreOffice (MPL-2.0, same), LanguageTool (LGPL-2.1, optional server), `docxtpl` (LGPL-2.1, optional), `diff-dom` (LGPL-3.0, not used). No component requires a license key or a vendor account.

## 2. Comparison table

### Editors

| Library | Version (date) | License | React | Tables: merge / resize | Math | Comments / track changes | Yjs | HTML in/out fidelity | docx path | Accessibility | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tiptap 3 | 3.31.0 (2026-09-01) | MIT (editor); Cloud features paid | `@tiptap/react` | Yes / yes (`prosemirror-tables`) | `@tiptap/extension-mathematics` MIT, KaTeX | Comments, Snapshot Compare, history: paid, cloud-hosted | `@tiptap/extension-collaboration` MIT | Per-node `parseHTML`/`renderHTML`; attrs preserved; `@tiptap/html` server-side | DOCX conversion paid; use own mapper | `role="textbox"` default; semantic HTML; toolbar a11y is the app's job; documented VoiceOver block-spacing quirk | **Primary** |
| ProseMirror (direct) | view 1.42.3 (2026-08-24) | MIT | Hand-rolled | Yes / yes | `@benrbray/prosemirror-math` 1.0.0 (2024-04) | None built in | `y-prosemirror` | Full control via schema `parseDOM`/`toDOM` | Own mapper | Same as Tiptap minus conveniences | Use through Tiptap |
| Lexical | 0.50.0 (2026-09-02) | MIT | `@lexical/react` | Node-level colSpan/rowSpan (`hasCellMerge`); merge UI and resizer only in playground; no nested tables | Playground `EquationsPlugin` (KaTeX), not published | None built in | `@lexical/yjs` | `@lexical/html`; per-node `importDOM`/`exportDOM` | Own mapper | WCAG stated as a design goal | **Fallback** |
| Plate (Slate) | `@platejs/table` 53.0.9 (2026-06-04); `slate` 0.126.2 | MIT; Plate Plus UI commercial | Yes | Yes / yes | `@platejs/math` 53.0.0 (KaTeX, inline + block) | Suggestion/comment plugins exist in registry UI | `@slate-yjs/core` 1.0.2 (2023-07) | Slate JSON; HTML via `@platejs/*` serializers | Own mapper | Slate contenteditable; app-defined | Viable; weaker schema enforcement |
| BlockNote | 0.54.0 (2026-08-13) | MPL-2.0 core; XL packages GPL-3/commercial | Yes (React-only) | Yes (`splitCells: true`) / column widths | `@blocknote/math-block` (KaTeX → MathML) | Comments in core but require Yjs collaboration | Yes | Block JSON; HTML export | `@blocknote/xl-docx-exporter` is XL (GPL-3/commercial) | Block UI; app-defined | Not recommended |
| Milkdown | 7.22.1 (2026-08-12) | MIT | `@milkdown/react` | GFM tables: no merged cells | `@milkdown/plugin-math` 7.5.9 (2024-12) | None | Yes | Markdown is the model; attributes lost | Pandoc from Markdown | ProseMirror-based | Excluded (Markdown model) |
| Editor.js | 2.31.6 (2026-04-07) | Apache-2.0 | Wrapper | `@editorjs/table` 2.4.6: no merged cells | `editorjs-math` 1.0.2 (2021-03) | None | No | Block JSON; HTML via own renderer | Own mapper | Block UI | Excluded |
| Quill 2 | 2.0.3 (2024-11-30) | BSD-3 | Wrapper | No table format; `quill-table-better` 1.2.3 third-party | `formula` embed (KaTeX) | None | No | Delta model; HTML lossy | Own mapper | Basic | Excluded |
| CKEditor 5 | 48.5.0 (2026-09-02) | GPL-2+ or commercial; `licenseKey: 'GPL'` mandatory | Wrapper | Yes / yes (free) | MathType (Wiris) premium; `@isaul32/ckeditor5-math` ISC, 2024-10 | Track changes, comments, revision history premium | Premium RTC | Good | Export to Word premium | Good toolbar a11y | Excluded (GPL + paid features) |
| TinyMCE | 8.9.0 (2026-08-31) | GPL-2+ or commercial; `license_key: 'gpl'` mandatory | Wrapper | Core table plugin free; `advtable` premium | Math plugin premium | Comments, revision history, suggested edits premium | Premium | Good | Import/Export Word premium | Good toolbar a11y | Excluded (GPL + paid features) |
| Remirror | 3.0.3 (2025-08-02) | MIT | Yes | `@remirror/extension-tables` | Community | None | Yes | ProseMirror | Own mapper | ProseMirror | Excluded (maintenance mode; authors recommend ProseKit 0.22.2) |
| Jodit | 4.14.2 (2026-09-02) | MIT | `jodit-react` 5.5.3 | Yes / yes | None | None | No | Raw HTML; no schema | Own mapper | App-defined | Excluded (no schema) |
| Trix | 2.1.19 (2026-05-09) | MIT | Wrapper | No tables | None | None | No | Limited | — | Basic | Excluded |
| Summernote | 0.9.1 (2024-10-09) | MIT | jQuery wrapper | Basic | Plugin | None | No | Raw HTML | — | Basic | Excluded |
| Froala | — | Commercial | — | — | — | — | — | — | — | — | Excluded by requirement |

### Math libraries

| Library | Version (date) | License | Role | Output | Accessibility | Editor integration |
|---|---|---|---|---|---|---|
| KaTeX | 0.18.5 (2026-08-31) | MIT | Render | HTML+CSS, MathML, or both | MathML output readable by NVDA/JAWS/VoiceOver | `@tiptap/extension-mathematics`; `@aarkue/tiptap-math-extension` 1.4.0 (decorations, `$...$`); `@benrbray/prosemirror-math` 1.0.0 |
| MathLive | 0.110.0 (2026-06-09) | MIT | Edit | LaTeX, MathML, ASCIIMath, Typst, MathJSON | ARIA labels, math-to-speech, keyboard shortcuts, virtual keyboard | Web component `<math-field>`; used in a popover (see 3.5) |
| MathJax | 4.1.3 (2026-07-03) | Apache-2.0 | Render | HTML/CSS, SVG, MathML | Accessibility extensions | Larger than KaTeX; not needed |

### Docx / PDF tooling

| Tool | Version (date) | License | Runs | Tables (span) | Math | Use |
|---|---|---|---|---|---|---|
| `docx` (npm) | 9.7.1 (2026-05-27) | MIT | Node and browser | `rowSpan`, `columnSpan`, widths, borders, shading | OMML via `Math`/`MathRun` classes; MathML → OMML with `mathml2omml` | **Primary docx writer** |
| pandoc | 3.11 (2026-08-28) | GPL-2+ (subprocess) | CLI | HTML tables in; span support in docx writer to be verified | MathML/LaTeX → OMML; known issue #10517 moves mid-paragraph equations | **Fallback docx writer** |
| `@turbodocx/html-to-docx` | 1.22.2 (2026-08-24) | MIT | Node | Tables; merged cells not documented | Not documented | Not used |
| `html-to-docx` | 1.8.0 (2023-03-26) | MIT | Node | Basic | No | Superseded by the TurboDocx fork |
| `python-docx` | 1.2.0 (2025-06-16) | MIT | Python | Spans via low-level XML | OMML via raw XML | Python equivalent of `docx` if the export worker must be Python |
| `docxtpl` | 0.20.2 (2025-11-13) | LGPL-2.1 | Python | Jinja2 in a Word template | — | Option for the fixed header page |
| LibreOffice | 26.2.x / 25.8.x still | MPL-2.0 (subprocess) | CLI | Full | Full | docx → PDF when the PDF must match Word pagination |
| Playwright | 1.62.1 (2026-07-30) | Apache-2.0 | Node | Renders the same HTML/CSS as the editor | KaTeX HTML output | **Primary PDF** |
| WeasyPrint | 69.0 (2026-06-02) | BSD-3 | Python | CSS paged media | No MathML; KaTeX HTML output needs font workarounds (issues #867, #1215) | Python fallback for PDF |

## 3. Editor module design

### 3.1 Document model

The source of truth is the ProseMirror JSON document produced by `editor.getJSON()`. HTML is derived from it by `generateHTML` (`@tiptap/html`) at save time and stored beside it. The structured estimate data (fund rows, FY amounts, FTEs) is extracted from the `estimateTable` nodes at save time and stored in relational tables.

Reasons:

- The JSON is validated against the schema on load (`schema.nodeFromJSON` throws on unknown nodes). HTML from any other source is normalized through `parseHTML` rules and silently loses whatever the schema does not allow, which is the correct behaviour for paste and template import but not for reloading a saved document.
- Node attributes (`fundCode`, `slotId`, `required`, `commentId`, `latex`) are first-class in JSON. In HTML they are `data-*` attributes and survive only if every consumer preserves them.
- Version diffs and comment anchors address JSON positions; ProseMirror position mapping keeps them valid through edits.
- The server can convert JSON → HTML → docx/PDF without a browser.

Storage row (`note_documents`):

```
note_id        uuid
version        integer         -- monotonically increasing; ETag
mode           'limited'|'full'
doc_json       jsonb           -- ProseMirror JSON
doc_html       text            -- derived
estimate_data  jsonb           -- extracted from estimateTable nodes (see 3.3)
updated_by     uuid
updated_at     timestamptz
```

Templates arrive as HTML (section 4). They are parsed by the editor's `parseHTML` rules once, at insertion, and from then on live as JSON.

Structured tables in HTML carry `data-role` on `<table>` and `data-fy`, `data-fund`, `data-field` on cells; the `estimateTable` node's parse rules read those attributes into node attrs, and its `renderHTML` writes them back. A `<table>` without a `data-role` becomes a plain `table` node (full mode) or is rejected (limited mode).

### 3.2 Schemas

Two Tiptap extension sets. One `NoteEditor` component picks the set from the `mode` prop.

**Limited (fiscal note, exported to OFM FNS)**

| Category | Allowed |
|---|---|
| Blocks | `doc`, `noteSection` (fixed headings for Parts I–V, not editable), `paragraph`, `heading` (levels 3–4 only, inside a section), `bulletList`, `orderedList`, `listItem`, `assumptionList`, `assumptionItem`, `estimateTable` (+ `estimateRow`, `estimateCell`), `fteTable`, `mathBlock`, `hardBreak` |
| Inline | `text`, `billCitation`, `mathInline`, `slot` |
| Marks | `bold`, `italic`, `underline`, `superscript`, `subscript`, `comment` |
| Not allowed | free-form `table`, images, links, colors, fonts, font sizes, alignment, code, blockquote, highlight |

Everything OFM's Fiscal Note System accepts on paste is a subset of this list; the exact FNS whitelist should be confirmed with OFM and the list adjusted.

**Full (fiscal estimate, internal)**

Everything in limited plus: `table`/`tableRow`/`tableCell`/`tableHeader` (merge, split, resize, header toggles), `image` (pasted charts, stored as attachments), `link`, `blockquote`, `codeBlock`, `horizontalRule`, `heading` levels 1–4, `textAlign`, `highlight`, `strike`, `textStyle` + `color`.

Enforcement points:

- The Tiptap schema itself (typing, commands).
- `editorProps.transformPastedHTML` strips `style`, `class`, `font`, and `span` without `data-slot` before parsing; paste from Word arrives as plain structure.
- A `filterTransaction` plugin rejects edits inside nodes with `locked: true` (section 4.4) and rejects deletion of `noteSection` nodes.

### 3.3 Custom nodes

All node names, attributes and HTML forms below are the contract between the editor, the templates, and the export pipeline.

**`noteSection`** (block, `content: 'block+'`, `isolating`, `defining`)

| Attr | HTML | Notes |
|---|---|---|
| `sectionId` | `<section data-role="section" data-section="part-2a">` | Fixed set: `header`, `part-1-revenue`, `part-1-expenditure`, `part-2a`, `part-2b`, `part-2c`, `part-2d`, `part-3a`, `part-3b`, `part-4`, `part-5` |
| `title` | `<h2>` rendered by node view, not editable | |

**`estimateTable`** (block, atom-like: React node view with its own grid; `content: 'estimateRow+'`)

| Attr | HTML | Notes |
|---|---|---|
| `role` | `<table data-role="revenue-estimate" \| "expenditure-estimate" \| "fte-estimate">` | Determines row semantics and the fields expected by the XML export |
| `fiscalYears` | `data-fy-columns="2026,2027,2028,2029,2030,2031"` | Header columns; biennium totals computed from pairs |
| `unit` | `data-unit="dollars" \| "thousands" \| "fte"` | |

**`estimateRow`** (`content: 'estimateCell+'`)

| Attr | HTML | Notes |
|---|---|---|
| `fundCode` | `<tr data-fund="001" data-fund-name="General Fund-State">` | Account code from the DOR fund list |
| `rowKind` | `data-row="fund" \| "total" \| "fte" \| "object"` | `total` rows are read-only and computed |

**`estimateCell`** (`content: 'text*'`, single-line)

| Attr | HTML | Notes |
|---|---|---|
| `fy` | `<td data-fy="2027">` | Absent on the label cell |
| `field` | `data-field="amount" \| "label" \| "biennium-total"` | |
| `value` | `data-value="-1250000"` | Canonical number; the text child is the formatted display |

Behaviour of the node view:

- Cells accept digits, minus, parentheses, decimal; the node view parses on blur, writes `value`, and re-renders the text as currency (`$(1,250,000)` for negatives, in the unit set on the table; thousands separators; no decimals for dollars).
- Biennium totals (`2025-27`, `2027-29`, `2029-31`) and the `total` row are computed by an `appendTransaction` plugin whenever any `estimateCell.value` in that table changes. Computed cells are `contentEditable=false` and have `aria-readonly="true"`.
- Row add/remove is from a fund picker (searchable list of DOR accounts) in the table's local toolbar; users cannot type a fund name.
- `estimate_data` extraction at save time:

```json
{
  "revenue": [
    {"fund": "001", "fundName": "General Fund-State",
     "fy": {"2026": 0, "2027": -1250000, "2028": -2600000, "2029": -2700000, "2030": -2800000, "2031": -2900000},
     "biennia": {"2025-27": -1250000, "2027-29": -5300000, "2029-31": -5700000}}
  ],
  "expenditure": [...],
  "fte": [...]
}
```

**`assumptionList`** / **`assumptionItem`** (block; `content: 'assumptionItem+'`, item `content: 'paragraph block*'`)

| Attr | HTML |
|---|---|
| `assumptionList.prefix` | `<ol data-role="assumptions" data-prefix="">` |
| `assumptionItem.number` | `<li data-role="assumption" data-number="3">` |

Numbers are assigned by an `appendTransaction` plugin: it walks each `assumptionList` in document order and rewrites `number` attrs so they are always 1..n. Items are referenced in prose by inline text "Assumption 3"; the plugin does not rewrite prose. Export emits the number as literal text (`3.`) so the docx and XML do not depend on list styles.

**`billCitation`** (inline, atom, `selectable`)

| Attr | HTML |
|---|---|
| `billId` | `<a data-role="bill-cite" data-bill="HB 2081" data-version="S2" data-section="sec-4" data-anchor="p-4-2" href="#bill/HB2081/S2/sec-4">Sec. 4</a>` |
| `version`, `section`, `anchor`, `label` | |

Created from the bill viewer's selection event: the viewer emits `{billId, version, section, anchor, text}`; the app calls `editor.commands.insertBillCitation(payload)` at the caret. Clicking the node (or pressing Enter on it) emits `onCitationActivate`, and the app scrolls the bill pane to the anchor. Label text defaults to `Sec. {n}` and is editable through the node's popover, not inline.

**`mathInline`** / **`mathBlock`** (from `@tiptap/extension-mathematics`, with the app's `onClick` opening the MathLive popover)

| Attr | HTML |
|---|---|
| `latex` | `<span data-type="inline-math" data-latex="\frac{a}{b}">` (extension default); the export step also writes the MathML from `katex.renderToString(latex, {output: 'mathml'})` inside the span for docx conversion and screen readers |

Editing: the popover contains one `<math-field>` (MathLive) bound to `latex`, a "LaTeX source" toggle (plain textarea), Insert/Cancel. Enter commits; Escape cancels and returns focus to the editor. In limited mode, math is allowed but the toolbar labels it "Formula" and defaults to inline.

**`slot`** (inline, `content: 'inline*'` so the filled text lives inside the node; not atom)

| Attr | HTML |
|---|---|
| `slotId` | `<span data-slot="revenue-summary" data-required="true" data-hint="One sentence stating the net revenue impact">` |
| `required`, `hint`, `filled` | `filled` is derived: true when the node has non-whitespace text that differs from the hint |

Unfilled slots render with a dashed outline, the hint as placeholder text, and `aria-label="Required: {hint}"`. A `slot` becomes plain text (node unwrapped) when the analyst presses Ctrl+Shift+U on it or at export time; the export pipeline refuses to export while a `required` slot is unfilled and returns the list of slot ids.

**`comment`** (mark, `inclusive: false`, `excludes: ''` so it can overlap other marks)

| Attr | HTML |
|---|---|
| `commentId` | `<mark data-comment="c_01J...">` |
| `resolved` | `data-resolved="true"` |

Mark only; thread text lives in the comments store (section 5.1).

### 3.4 Toolbars

Both toolbars use `role="toolbar"` with roving `tabindex`, `aria-pressed` on toggles, and `aria-label` on every button.

Limited mode:

```
[Bold] [Italic] [Underline] [Sup] [Sub] | [Numbered list] [Bullet list] [Assumption list] | [Insert: Fund row ▾] [Formula] [Cite bill section] | [Template ▾] [Next slot] | [Comment] | [Undo] [Redo] | [Spell check: browser]
```

Full mode adds:

```
| [Heading ▾] [Align ▾] [Highlight] [Color] | [Table ▾: insert, add row/col, merge, split, header, resize] [Image] [Link] [Quote] [Rule]
```

Section-local toolbars (rendered inside the node view) appear for `estimateTable` (add fund row, remove row, unit, FY columns) and `table` in full mode (row/column operations, merge/split).

### 3.5 Math editing detail

- `MathLive` is loaded lazily (`import('mathlive')`) when the first formula popover opens; the fonts are served from the app, not a CDN.
- The popover is a `role="dialog"` anchored to the node with `aria-labelledby`; focus moves into `<math-field>` on open and back to the editor on close.
- `<math-field>` options: `smartFence`, `virtualKeyboardMode: 'manual'`, `mathVirtualKeyboardPolicy: 'auto'`, and a restricted macro set matching what KaTeX renders. The popover validates by calling `katex.renderToString(latex, {throwOnError: true})` before committing.
- The rendered node uses `katex.renderToString(latex, {output: 'htmlAndMathml'})`; the MathML sibling is visually hidden by KaTeX's stylesheet and read by screen readers.

### 3.6 Spell check

The editor sets `spellcheck="true"` on the contenteditable, so the browser's dictionary underlines misspellings in Edge and Chrome on DOR workstations. A self-contained checker is optional and deferred: `typo-js` 1.3.2 (BSD-3, Hunspell dictionaries) or `hunspell-asm` 4.0.2 (MIT, WebAssembly) can drive a ProseMirror decoration plugin, and LanguageTool (LGPL-2.1, self-hosted) can provide grammar suggestions through its HTTP API. Both keep text on DOR infrastructure.

## 4. Template library

### 4.1 Storage format

Each template is a directory produced by the templates work in `design/templates/`:

```
templates/
  manifest.json
  fiscal-note/
    sales-tax-exemption.html
    b-and-o-rate-change.html
  snippets/
    revenue-estimate-table.html
    assumption-block-ntc.html
```

`manifest.json` entry:

```json
{
  "id": "fn-sales-tax-exemption",
  "name": "Fiscal note: retail sales tax exemption",
  "kind": "document",
  "mode": "limited",
  "version": 3,
  "tags": {"taxType": ["sales-use"], "impactType": ["revenue-decrease"], "section": []},
  "description": "Full Part I–V note for a new retail sales and use tax exemption.",
  "file": "fiscal-note/sales-tax-exemption.html",
  "slots": [
    {"id": "exemption-description", "required": true, "hint": "Describe the exempted transactions"},
    {"id": "revenue-summary", "required": true, "hint": "One sentence net revenue impact"},
    {"id": "data-source", "required": false, "hint": "Name the data source and year"}
  ],
  "tokens": ["bill.number", "bill.title", "bill.version", "analyst.name", "analyst.phone", "date.today", "agency.code"],
  "roles": ["revenue-estimate", "expenditure-estimate", "assumptions"]
}
```

`kind` is `document` (replaces the whole note body) or `snippet` (inserted at the caret as one or more blocks). `mode` restricts a template to the schema it validates against; a snippet with a free-form `<table>` is `mode: "full"`.

HTML fragment conventions the editor consumes:

- `<section data-role="section" data-section="part-2b">` → `noteSection`
- `<table data-role="revenue-estimate" data-fy-columns="..." data-unit="dollars">` with `<tr data-fund="001">` and `<td data-fy="2027" data-field="amount">` → `estimateTable`
- `<ol data-role="assumptions"><li data-role="assumption">` → `assumptionList`
- `<span data-slot="id" data-required="true" data-hint="...">default text</span>` → `slot`
- `<span data-type="inline-math" data-latex="...">` → `mathInline`
- `{{token.path}}` anywhere in text → substituted before parsing
- `<div data-locked="true">…</div>` → child blocks get `locked: true`

Tags not in the mode's schema are dropped at parse time; the template validator in CI parses each file with both schemas and fails on lost content.

### 4.2 Template panel

A panel opened from the toolbar `Template ▾` button or Ctrl+Shift+T, rendered beside the editor (not a modal, so the analyst can keep reading the bill):

- Search box filtering on `name`, `description`, and tag values; results grouped by `kind`.
- Filter chips for `taxType` and `impactType`; the chips default to the tax type already recorded on the bill record when one exists.
- Preview pane rendering the template HTML read-only with slots highlighted and tokens already substituted from the current note's context.
- Two actions: **Apply as document** (enabled only for `kind: document` and only when the note body is empty or the analyst confirms replacement) and **Insert at cursor** (for snippets; for documents it inserts the selected section only, chosen from a section list in the preview).
- Recently used templates listed first; the list is stored in `localStorage` per user.

### 4.3 Applying and inserting

`applyTemplate(templateId)`:

1. `GET /templates/{id}` returns the manifest entry and the HTML.
2. Token substitution: every `{{path}}` is replaced from the `TemplateContext` (section 8) with HTML-escaping. Unknown tokens are left as literal text and reported in a toast.
3. `generateJSON(html, extensions)` parses to ProseMirror JSON with the current mode's extensions.
4. For `document`: `editor.commands.setContent(json)` and a single history entry; the note's `templateId` and `templateVersion` are recorded on the document row.
5. For `snippet`: `editor.commands.insertContentAt(selection, json)`; if the caret is inside a `noteSection`, the snippet stays inside it; if the snippet contains `noteSection` nodes and the caret is at top level, they are inserted as siblings.
6. Focus moves to the first unfilled required slot.

Applying a document template to a note that already has estimate data is refused unless the new template contains an `estimateTable` with the same `role`; the existing table data is then merged into the new table by fund code.

### 4.4 Slot navigation and locking

- `Tab` inside a `slot` node, or `Ctrl+]` anywhere, moves the selection to the next unfilled slot in document order; `Shift+Tab` / `Ctrl+[` goes back. Inside an `estimateTable`, `Tab` moves between cells instead, and `Ctrl+]` still jumps to the next slot.
- The slot counter in the status bar reads "3 of 7 required slots filled" and is an `aria-live="polite"` region.
- Nodes with `locked: true` (from `data-locked`) cannot be edited: a `filterTransaction` plugin rejects any step whose range intersects a locked node unless the transaction has the `unlock` meta. Locked boilerplate has a subtle background and a lock icon in the gutter; a "Unlock this text" action in the context menu sets `locked: false` and is audited.
- Slots inside locked regions remain editable (the filter checks the innermost node).

### 4.5 API

```
GET  /templates?mode=limited&kind=document&taxType=sales-use&q=exemption
     → 200 [{manifest entry}, ...]
GET  /templates/{id}
     → 200 {manifest entry, html: "<section ...>", etag}
GET  /templates/{id}/preview?noteId=...
     → 200 text/html with tokens substituted (used by the preview pane)
```

Templates are read-only through this API in the POC; authoring is a file change in the repository. The service reads `manifest.json` at startup and re-reads on a file watcher event.

## 5. Review features

### 5.1 Comments

- Anchoring: the `comment` mark with `commentId`. Overlapping comments each carry their own mark instance; ProseMirror position mapping keeps marks attached through edits. Deleting the whole marked range leaves an orphan thread, which the panel lists under "Detached".
- Storage: separate from the document.

```
note_comments
  id           text pk        -- ULID, same as commentId
  note_id      uuid
  anchor_text  text           -- snapshot of the marked text at creation, for the orphan case
  status       'open'|'resolved'
  created_by, created_at, resolved_by, resolved_at

note_comment_messages
  id, comment_id, author_id, body text, created_at
```

- Panel: `<CommentsPanel>` lists threads in document order (computed from mark positions each render), filters open/resolved, and scrolls the editor to the mark on click; clicking a mark selects the thread. A thread is created from the toolbar `Comment` button on a non-empty selection. Resolving keeps the mark with `resolved: true` (hidden styling) so the thread stays navigable; deleting a thread removes the mark.
- Export: comment marks are stripped from docx, PDF and XML by default; the docx export accepts `?comments=true` to emit them as Word comments (the `docx` library supports comments through `CommentRangeStart`/`CommentRangeEnd`).

### 5.2 Change tracking

Paid track-changes (Tiptap Snapshot Compare, CKEditor Track Changes) is replaced by version diffing:

- Every autosave that changes content increments `version`; every explicit "Save version" or workflow transition (submit for review, approve) writes a named snapshot to `note_versions (note_id, version, label, doc_json, doc_html, estimate_data, created_by, created_at)`. Autosave rows between named snapshots are kept for 30 days, then thinned to one per hour.
- Diff is computed on the derived HTML with the same library the bill viewer uses for bill version comparison (`diff` 9.0.0, BSD-3, `diffWordsWithSpace` on block-aligned text; the block alignment step pairs blocks by `sectionId`, then by position). The result renders as a redline (insertions underlined green, deletions struck red) in a read-only editor instance and as a side-by-side view. Estimate tables are diffed cell by cell from `estimate_data`, showing old → new values, rather than as text.
- `prosemirror-changeset` 2.4.2 (MIT) is an alternative that produces in-editor decorations, but it needs the transaction steps between versions, which this design does not retain. It can be added later if step logs are kept.
- Reviewer suggestions are comments; the analyst applies them by editing. There is no accept/reject of tracked edits in the POC.

### 5.3 Version history UI

A right-pane drawer listing versions newest first with label, author, time, and a one-line summary (blocks changed, table cells changed). Actions: **View** (read-only editor at that version), **Compare with current**, **Compare with previous**, **Restore** (creates a new version whose content is the old version's; nothing is deleted). Restore and unlock actions are written to the audit log with the actor, note id, and versions involved.

## 6. Export pipeline

All exports run server-side from the stored JSON. The request records an audit event and returns the file; long conversions (PDF) return `202` with a job id and the client polls.

```
POST /notes/{id}/export?format=docx|pdf|xml|html[&version=N][&comments=true]
  → 200 application/vnd.openxmlformats-officedocument.wordprocessingml.document
  → 200 application/pdf
  → 200 application/xml
  → 200 text/html
  → 202 {jobId}  then GET /export-jobs/{jobId}
  → 422 {"unfilledSlots": ["revenue-summary"]}   when required slots are empty
```

### 6.1 JSON → HTML

`generateHTML(doc_json, extensions)` on the server, then a post-processing pass: inline the KaTeX MathML into each math span, unwrap `slot` nodes to text, strip `comment` marks unless requested, and replace `billCitation` with plain text `Sec. 4` (docx/XML) or a hyperlink to the bill's public URL (HTML/PDF).

### 6.2 HTML/JSON → docx

Primary: a Node worker using `docx` 9.7.1. The mapper walks the ProseMirror JSON (not the HTML) so that node attributes are available directly.

| Node | docx construct |
|---|---|
| `noteSection` | `Paragraph` with style `Heading2` carrying the fixed OFM title, followed by children |
| `paragraph`, `heading` | `Paragraph` with named styles `Normal`, `Heading3`, `Heading4` |
| Marks | `TextRun` with `bold`, `italics`, `underline`, `superScript`, `subScript` |
| `bulletList`/`orderedList` | `Paragraph` with `numbering.reference` from a numbering definition |
| `assumptionList` | Paragraphs with literal `n.` prefix text and a hanging indent (no Word numbering, so the numbers cannot renumber in Word) |
| `estimateTable` | `Table` with fixed column widths in DXA, `TableCell` per FY, header row repeated (`tableHeader: true`), right-aligned amounts, currency text from `value`, total rows bold with a top border |
| `table` (full mode) | `Table` with `rowSpan`/`columnSpan` from the ProseMirror cell attrs; column widths from `colwidth` |
| `mathInline`/`mathBlock` | `Math` object built from OMML; OMML is produced from the KaTeX MathML with `mathml2omml`, falling back to a `TextRun` with the LaTeX source in a monospace style when conversion fails |
| `billCitation` | `TextRun` with the label |
| `image` (full mode) | `ImageRun` from the attachment bytes |

Page setup: Letter, 1-inch margins, footer with page number and note identifier, matching the OFM form. Styles are declared in code (`styles.paragraphStyles`) rather than loaded from a template file, so the worker has no binary dependency.

Fallback: pandoc 3.11 invoked as `pandoc -f html -t docx --reference-doc=ofm-reference.docx`. It handles the narrative sections and MathML → OMML with no mapper code; table column widths and merged cells must be verified against pandoc's HTML reader, and pandoc issue #10517 (mid-paragraph equations moved to paragraph end) affects inline math. Use it to get a first docx out during week 1 if the mapper is not ready.

If the backend is FastAPI and a Node worker is not wanted, `python-docx` 1.2.0 can replace `docx`; spans and OMML require writing the underlying XML elements by hand.

### 6.3 HTML → PDF

Primary: Playwright 1.62.1 (Chromium) in the export worker rendering the derived HTML with the editor's print stylesheet (`@page { size: letter; margin: 1in }`, `thead { display: table-header-group }`, page-break rules on `noteSection`). KaTeX HTML output renders identically to the editor. Fonts are bundled with the worker.

Fallback (Python): WeasyPrint 69.0. It has no MathML support and known font issues with KaTeX HTML output; KaTeX must be rendered server-side to HTML with `output: 'html'` and the KaTeX fonts declared with `@font-face`. LibreOffice headless (`soffice --headless --convert-to pdf note.docx`) is the option when the PDF must be the Word rendering.

### 6.4 Structured fields → OFM XML

The FNS accepts uploads from agency systems, but the schema is not published on ofm.wa.gov; OFM's Fiscal Note Instructions describe fields, not the XML. The mapping below is a placeholder to be replaced once OFM supplies the XSD.

```xml
<FiscalNote schemaVersion="placeholder">
  <Header>
    <BillNumber>{header.billNumber}</BillNumber>
    <BillTitle>{header.title}</BillTitle>
    <AgencyCode>140</AgencyCode>
    <PreparedBy name="" phone="" date=""/>
  </Header>
  <PartI>
    <Revenue unit="dollars">
      <Fund code="001" name="General Fund-State">
        <FY year="2026">0</FY> <FY year="2027">-1250000</FY> ...
        <Biennium id="2025-27">-1250000</Biennium> ...
      </Fund>
    </Revenue>
    <Expenditure unit="dollars">...</Expenditure>
    <FTE>...</FTE>
  </PartI>
  <PartII>
    <Section id="part-2a"><![CDATA[<p>…limited HTML…</p>]]></Section>
    <Section id="part-2b">...</Section>
  </PartII>
  <PartIII>...</PartIII>
  <PartIV>...</PartIV>
  <PartV>...</PartV>
</FiscalNote>
```

Sources: Part I from `estimate_data`; Parts II–V from the HTML of each `noteSection`, with math replaced by its LaTeX or MathML depending on what FNS accepts (unknown). The exporter validates against the XSD once available and returns `422` with validation messages.

## 7. Autosave and concurrency

- Client: `onUpdate` → debounce 1.5 s, maximum wait 10 s, flush on blur, on `visibilitychange: hidden`, and before navigation (`navigator.sendBeacon` with the JSON if a save is pending). Only content-changing transactions trigger a save (`transaction.docChanged`).
- Request: `PUT /notes/{id}/document` with `If-Match: "{version}"` and body `{docJson, mode, clientId}`. Response `200 {version, etag, savedAt}`; the client adopts the new version.
- Conflict: `412 Precondition Failed` with the server's current `{version, docJson, updatedBy}`. The client shows a non-blocking banner: "Saved by {name} at {time}. Reload their version or keep yours as a new version." "Keep mine" re-sends with `?force=true`, which stores the client's document as version n+1 and the server's as a retained snapshot labelled "superseded"; nothing is lost.
- Editing lock: opening a note in edit mode acquires a soft lock (`POST /notes/{id}/lock`, TTL 2 min, renewed by heartbeat). Others open read-only with the holder's name and a "Request edit" button. This covers the common case (one analyst per note) without collaboration infrastructure.
- Local resilience: the latest unsaved JSON is written to IndexedDB keyed by note id and version; on reload the editor offers to restore it if it is newer than the server version.
- Yjs collaboration is deferred. The Yjs binding, Hocuspocus server, and awareness cursors are all MIT and can be added without changing the document model (a Yjs document round-trips to the same ProseMirror JSON). It is deferred because the DOR workflow is one drafter and sequential reviewers, the lock and version model above already prevents lost updates, and collaboration adds a stateful server, a second persistence path, and comment-anchor migration to Yjs relative positions. Revisit if reviewers need to edit simultaneously with drafters.

## 8. Component and HTTP contracts

```ts
// ---- Document types ----
export type EditorMode = 'limited' | 'full';

export interface NoteDocument {
  noteId: string;
  version: number;              // ETag value
  mode: EditorMode;
  doc: JSONContent;             // ProseMirror JSON (Tiptap JSONContent)
  templateId?: string;
  templateVersion?: number;
  updatedAt: string;
  updatedBy: string;
}

export interface EstimateData {
  revenue: EstimateRow[];
  expenditure: EstimateRow[];
  fte: EstimateRow[];
}
export interface EstimateRow {
  fund: string; fundName: string;
  fy: Record<string, number>;
  biennia: Record<string, number>;
}

// ---- Citation event from the bill viewer ----
export interface BillCitationPayload {
  billId: string;      // "HB 2081"
  version: string;     // "S2"
  section: string;     // "sec-4"
  anchor: string;      // element id in the bill viewer
  text?: string;       // selected text, used for the default label
}

// ---- Template types ----
export interface TemplateSummary {
  id: string; name: string; kind: 'document' | 'snippet'; mode: EditorMode;
  version: number; description: string;
  tags: { taxType: string[]; impactType: string[]; section: string[] };
  slots: { id: string; required: boolean; hint: string }[];
  tokens: string[]; roles: string[];
}
export interface Template extends TemplateSummary { html: string; etag: string }
export interface TemplateContext {
  bill: { number: string; title: string; version: string; sponsor?: string };
  analyst: { name: string; phone: string; email: string };
  agency: { code: string; name: string };
  date: { today: string; session: string };
  note: { id: string; dueDate?: string };
}

// ---- Editor component ----
export interface NoteEditorProps {
  mode: EditorMode;
  document: NoteDocument;
  templateContext: TemplateContext;
  readOnly?: boolean;
  activeCommentId?: string | null;
  onChange: (doc: JSONContent, meta: { estimateData: EstimateData; unfilledSlots: string[] }) => void;
  onSaveRequest: () => void;                     // Ctrl+S
  onCiteRequest: () => void;                     // analyst asks the bill pane to provide a selection
  onCitationActivate: (cite: BillCitationPayload) => void;
  onCommentCreate: (range: { from: number; to: number }, anchorText: string) => Promise<string>; // returns commentId
  onCommentSelect: (commentId: string) => void;
  onTemplateRequest: () => void;                 // open TemplatePanel
  onLockChange?: (nodePos: number, locked: boolean) => void;
}

export interface NoteEditorHandle {
  insertCitation(payload: BillCitationPayload): void;
  applyTemplate(t: Template, how: 'document' | 'snippet'): void;
  focusSlot(direction: 'next' | 'prev'): void;
  focusComment(commentId: string): void;
  setComment(commentId: string, patch: { resolved?: boolean; remove?: boolean }): void;
  getJSON(): JSONContent;
  getHTML(): string;
  getEstimateData(): EstimateData;
}

// ---- Template panel ----
export interface TemplatePanelProps {
  mode: EditorMode;
  context: TemplateContext;
  documentIsEmpty: boolean;
  onApply: (t: Template, how: 'document' | 'snippet') => void;
  onClose: () => void;
}

// ---- Comments panel ----
export interface CommentThread {
  id: string; status: 'open' | 'resolved'; anchorText: string;
  detached: boolean;      // mark no longer present in the document
  position?: number;      // current mark position for ordering
  messages: { id: string; authorId: string; authorName: string; body: string; createdAt: string }[];
}
export interface CommentsPanelProps {
  threads: CommentThread[];
  activeId?: string | null;
  filter: 'open' | 'resolved' | 'all';
  onSelect: (id: string) => void;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}
```

HTTP contract with the Notes service:

```
GET    /notes/{id}/document                 → 200 NoteDocument  (ETag: "version")
PUT    /notes/{id}/document                 If-Match: "version"  body {doc, mode, clientId}
                                            → 200 {version, savedAt} | 412 {version, doc, updatedBy, updatedAt}
PUT    /notes/{id}/document?force=true      → 200 {version}  (previous head retained as a snapshot)
GET    /notes/{id}/versions                 → 200 [{version, label, createdBy, createdAt, summary}]
GET    /notes/{id}/versions/{v}             → 200 NoteDocument
POST   /notes/{id}/versions                 body {label}  → 201 {version}   (named snapshot of head)
POST   /notes/{id}/versions/{v}/restore     → 201 {version}
GET    /notes/{id}/diff?from={v1}&to={v2}   → 200 {html: redlineHtml, tables: [{fund, fy, old, new}]}
POST   /notes/{id}/lock                     → 200 {holder, expiresAt} | 409 {holder}
DELETE /notes/{id}/lock
GET    /notes/{id}/comments                 → 200 CommentThread[]
POST   /notes/{id}/comments                 body {anchorText, body}  → 201 {id}
POST   /notes/{id}/comments/{cid}/messages  body {body}  → 201
PATCH  /notes/{id}/comments/{cid}           body {status}  → 200
DELETE /notes/{id}/comments/{cid}
POST   /notes/{id}/export?format=docx|pdf|xml|html&version=&comments=  → 200 file | 202 {jobId} | 422
GET    /export-jobs/{jobId}                 → 200 {status, url}
GET    /templates?mode=&kind=&taxType=&impactType=&q=   → 200 TemplateSummary[]
GET    /templates/{id}                      → 200 Template
GET    /templates/{id}/preview?noteId=      → 200 text/html
```

Every PUT, restore, unlock, export and comment change writes an audit row `(actor, note_id, action, from_version, to_version, at, detail)`.

## 9. Accessibility notes, risks, and the POC slice

### Accessibility (WCAG 2.2 AA)

- Editor root: `role="textbox" aria-multiline="true" aria-label="Fiscal note body"` (Tiptap sets the role by default). Toolbars: `role="toolbar"`, roving `tabindex`, `aria-pressed`, visible focus ring at 3:1 contrast, 24×24 px minimum targets (2.5.8).
- Tiptap's documented VoiceOver issue (words across blocks run together) is handled with the recommended CSS `::after { content: "\200B" }` on block nodes.
- Estimate table: real `<table>` with `<th scope="col">` FY headers and `<th scope="row">` fund labels; computed cells `aria-readonly`; the total row announced as "Total, computed". Arrow keys move between cells; Enter edits.
- Slots: outline plus icon plus text hint, so the unfilled state is not conveyed by color alone (1.4.1); `aria-label` includes "Required".
- Math: KaTeX MathML output is exposed to screen readers; MathLive provides speech and keyboard editing. The popover is a labelled dialog with a focus trap and Escape to close (2.1.2, 2.4.3).
- Comments: highlighted ranges have `aria-describedby` pointing at a visually hidden "Comment: {first line}" text; the panel is a landmark region with a live region for new replies.
- Keyboard-only paths exist for every toolbar action, template application, slot navigation, and citation insertion (the bill viewer's "Cite selection" button must be reachable by keyboard).
- Automated checks: axe-core in Playwright tests over the limited and full editors, the template panel, and the comments panel; manual NVDA and VoiceOver passes on the estimate table and math popover before the POC review.

### Risks

| Risk | Effect | Mitigation |
|---|---|---|
| OFM FNS XML schema unknown | XML export may need rework | Placeholder mapping isolates the schema in one module; request the XSD from OFM early |
| FNS paste whitelist narrower than the limited schema | Exported HTML rejected by FNS | Confirm the whitelist with OFM; the limited schema is a configuration list, not code |
| MathLive bundle (~700 KB minified reported in issue #2270) | Slower first formula open | Lazy import; KaTeX-only fallback |
| Merged cells and column widths through pandoc | Table layout differs in docx | Primary path is the `docx` mapper, which sets widths and spans explicitly |
| Comment anchors orphaned by large edits | Threads lose context | Anchor text snapshot; "Detached" list; re-anchor action |
| Tiptap 3 API changes between minors | Maintenance cost | Pin exact versions; extensions are thin wrappers over ProseMirror APIs |
| Browser spell check absent in a locked-down environment | Requirement unmet | Optional `typo-js` decoration plugin with DOR-hosted dictionaries |
| WeasyPrint math rendering | Broken formulas in PDF | Playwright is the primary PDF path |

### Minimal POC slice

1. `NoteEditor` in limited mode with `noteSection`, paragraphs, lists, `assumptionList`, `estimateTable` (revenue role, auto-sum, currency), `slot`, `billCitation`, `mathInline` with KaTeX and the MathLive popover, and the `comment` mark.
2. Template panel reading `manifest.json` from `design/templates/` through `GET /templates`, with apply-as-document, insert-snippet, token substitution, and Tab slot navigation.
3. Autosave with `If-Match` versioning, the conflict banner, and the version list with restore.
4. Comments panel backed by `note_comments`.
5. Export: docx through the `docx` mapper, PDF through Playwright, XML through the placeholder mapping, HTML as-is.
6. Diff view between two versions using the bill viewer's diff library.

Deferred: full mode (free-form tables, images), Yjs collaboration, in-app spell checker, Word comment export, docx import.

## Sources

- Tiptap: https://tiptap.dev/blog/release-notes/were-open-sourcing-more-of-tiptap ; https://tiptap.dev/pricing ; https://tiptap.dev/docs/editor/extensions/nodes/table ; https://tiptap.dev/docs/editor/extensions/nodes/mathematics ; https://tiptap.dev/docs/collaboration/documents/snapshot-compare ; https://tiptap.dev/docs/comments/getting-started/overview ; https://tiptap.dev/docs/conversion/getting-started/overview ; https://tiptap.dev/docs/guides/accessibility
- ProseMirror: https://prosemirror.net/docs/changelog/ ; https://github.com/ProseMirror/prosemirror-tables ; https://github.com/benrbray/prosemirror-math ; https://discuss.prosemirror.net/t/focus-issue-on-mathlive-integration-with-prosemirror/9021
- Lexical: https://github.com/facebook/lexical ; https://lexical.dev/docs/packages/lexical-table ; https://lexical.dev/docs/api/modules/lexical_table ; https://github.com/facebook/lexical/issues/4087
- Plate: https://platejs.org/docs/equation
- BlockNote: https://github.com/TypeCellOS/BlockNote ; https://www.blocknotejs.org/docs/features/blocks/tables ; https://www.blocknotejs.org/docs/features/collaboration/comments ; https://www.blocknotejs.org/docs/features/blocks/math
- CKEditor 5: https://ckeditor.com/docs/ckeditor5/latest/getting-started/licensing/license-and-legal.html ; https://ckeditor.com/docs/ckeditor5/latest/getting-started/licensing/license-key-and-activation.html ; https://ckeditor.com/docs/ckeditor5/latest/features/collaboration/track-changes/track-changes.html ; https://ckeditor.com/docs/ckeditor5/latest/features/math-equations.html
- TinyMCE: https://www.tiny.cloud/docs/tinymce/latest/license-key/
- Quill: https://quilljs.com/docs/formats ; Editor.js: https://github.com/codex-team/editor.js/issues/2423 ; Trix: https://github.com/basecamp/trix/issues/872 ; Remirror: https://github.com/remirror/remirror ; Jodit: https://xdsoft.net/jodit/docs/modules/plugins_table.html
- Math: https://github.com/arnog/mathlive ; https://github.com/arnog/mathlive/issues/2270 ; https://github.com/aarkue/tiptap-math-extension
- Export: https://github.com/dolanmiu/docx ; https://docx.js.org/api/classes/Math.html ; https://github.com/TurboDocx/html-to-docx ; https://pandoc.org/releases.html ; https://github.com/jgm/pandoc/issues/10517 ; https://pypi.org/project/weasyprint/ ; https://github.com/Kozea/WeasyPrint/issues/867 ; https://pypi.org/project/python-docx/ ; https://pypi.org/project/docxtpl/
- OFM FNS: https://ofm.wa.gov/tech-support/fiscal-note-system/ ; https://ofm.wa.gov/wp-content/uploads/sites/default/files/public/budget/instructions/other/AgencyFNI.pdf
- Package versions, dates, licenses and sizes: npm registry (`registry.npmjs.org`), 2026-09-02.
