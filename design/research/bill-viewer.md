# Bill viewer

The bill viewer is the left pane of the fiscal-note drafting tool. It renders one version of one
Washington bill from a structured Bill Document JSON, lets the drafter move through it, compare it
with another version, overlay an amendment on it, and cite a section or a selection into the note
being written in the right pane. It is modeled on the US Code reader in
[aih/uscode-redesign](https://github.com/aih/uscode-redesign) (local checkout:
`/Users/arihershowitz/Documents/workspace/aih/uscode-redesign`) and follows the principles in
[The Secret US Code Revealed](https://blog.linkedlegislation.org/2026-08-20-the-secret-us-code-revealed/)
and its sequel, [U.S. Code Site Architecture](https://blog.linkedlegislation.org/2026-09-01-us-code-site-architecture/).

Contents:

1. [The uscode-redesign reader](#1-the-uscode-redesign-reader)
2. [Principles and how they apply to a bill](#2-principles-and-how-they-apply-to-a-bill)
3. [Bill Document and Amendment Document schemas](#3-bill-document-and-amendment-document-schemas)
4. [UI design](#4-ui-design)
5. [Component API, endpoints, URLs](#5-component-api-endpoints-urls)
6. [Diff and amendment overlay](#6-diff-and-amendment-overlay)
7. [Risks and the proof-of-concept slice](#7-risks-and-the-proof-of-concept-slice)

Paths below are relative to the uscode-redesign checkout unless they start with `/`.

---

## 1. The uscode-redesign reader

### Stack

| Layer | Choice | Where |
|---|---|---|
| Reader | Astro 5, TypeScript, USWDS 3.13 tokens, SCSS. Server-rendered; the section page ships one line of inline script (`frontend/src/pages/us/usc/[...identifier].astro`, bottom) plus four small `is:inline` islands (`KeyboardNav`, `CopyColumn`, `CitePreview`, `ApparatusDisclosure`). No client framework (ADR-0011, ADR-0022). | `frontend/package.json`, `frontend/astro.config.mjs` |
| API | FastAPI + Postgres behind a `Repository` protocol; OpenSearch for keyword search. | `api/`, `storage/`, `db/models.py` |
| Diff | `diff-match-patch` on both sides (`api/diff.py` for the XML source diff; `frontend/src/lib/diffdoc.ts` for the reading-text redline). | `frontend/package.json`, `docs/adr/0016`, `docs/adr/0026` |
| Tests | vitest for `lib/`, Playwright + axe for e2e; the user guide's scenario blocks are the e2e suite (ADR-0038); per-route JS byte budgets (`docs/js-budgets.json`, ADR-0046); contrast computed from tokens (ADR-0042); line-length and indentation ladder measured into `docs/verification/measure.json` and `ladder.json`. | `frontend/tests/`, `docs/verification/` |

### Document model

`db/models.py`:

- `Section.identifier` (`/us/usc/t16/s45f`) is the cross-release identity of a section.
- `SectionVersion` stores the verbatim USLM XML fragment of a section, keyed by `content_hash`; the same text is stored once however many release points republish it (ADR-0007). `text_hash` and `notes_hash` distinguish a change to the law from a change to the notes.
- `ReleasePoint` has a `label` (`119-102not101`), a `currency_date` and a global `seq`, because labels do not sort.
- `StructureNode` is the hierarchy above the section (title → chapter → subchapter → part), unversioned, with `first_release_id`.
- `SectionVersionChange` annotates each transition with `change_kind` (`initial | text | notes | structure`) and the public laws the classification tables attribute to it (ADR-0074).
- A guid pins (provision, release point) and is never a cross-release identity (ADR-0003).

The API ships the verbatim XML (`api/schemas.py: SectionOut.xml`) and knows no element names. `frontend/src/lib/uslm.ts` is the only module allowed to know a USLM element name (CLAUDE.md architecture rule 5); it renders the fragment to HTML element for element, resolves `<ref href>` through `lib/refs.ts`, and emits `id="<@identifier>"` on every identified provision. `frontend/src/lib/types.ts` is a hand-kept mirror of `api/schemas.py`.

### Routing and deep links

- A citation URL is the identifier itself: `/us/usc/t16/s45f/c/5?release=119-102not101`, `?date=07/12/2026`, or `/us/usc/?id=<guid>`. It answers with a 307 to `/app/us/usc/…` for a browser or `/api/v1/us/usc/…` for everything else (ADR-0010). `frontend/src/lib/url.ts` builds every reader href; `/app` is spelled once.
- A sub-section identifier resolves to the whole section with the named provision marked `.target` and scrolled to centre (the one inline script on the section page). The section is the unit; a provision is shown in context (ADR-0001).
- `/app/diff/<identifier>?from=&to=&at=/c/5` is the redline; `at` is a query parameter rather than a fragment because the server acts on it (`lib/url.ts: diffHref`).
- `/app/versions/<identifier>` is the timeline.
- Cache headers: immutable only when the URL pins a release point that resolved to itself (ADR-0018, `lib/cache.ts`).

### Navigation and outline

`frontend/src/layouts/Base.astro` renders one sticky stack on every page that is a place in the Code (ADR-0043): skip link → navbar → context bar (breadcrumb ending in the current node with `aria-current`, plus the release switcher as a native `<details>`, ADR-0056) → `SectionBar` (previous / up / next, each naming its target, and the section number as a link to `#main`). The stack's height is one token, `--sticky-h`, and `scroll-margin-top` on `main` and every identified element spends it, so a fragment jump lands under the chrome rather than behind it (ADR-0044, `site.scss` lines 297–308, 400–456). Below 40em only the section bar sticks.

- `ChapterRail.astro`: the sibling sections of the containing subdivision, in a left column from 64em, sticky with a bounded scrolling height, `aria-current` on the section being read, status badges on repealed and omitted neighbours.
- `SectionContents.astro`: "In this section", the top-level provisions plus source credit and notes, from `uslm.outline()`. Top level only; not sticky.
- `Neighbors.astro` closes the page with previous/next.
- `KeyboardNav.astro` binds the map in `lib/shortcuts.ts`, a single list the help dialog, the design page and the island all read from (ADR-0055): `←`/`j` previous section, `→`/`k` next, `u` up, `c` contents, `[`/`]` previous/next subsection, `s` source, `n` notes, `t` top, `b` bottom, `/` search, `⌘K` palette, `?` help, `Esc` close. In-page jumps set `tabindex="-1"` and focus the target with `preventScroll`. Keys do nothing in text fields, `<select>` or `contenteditable`. A key that finds nothing writes one sentence into a `role="status"` region.

### Typography and reading measure

ADR-0052 and ADR-0054, implemented in `frontend/src/styles/site.scss`:

- Two self-hosted faces: Spectral for statutory text, Archivo for everything written about it. Latin-subset WOFF2, `font-display: swap`.
- Tokens: `--reading-size: 1.05rem`, `--reading-leading: 1.6`, `--reading-gap: 0.75rem`; compact density `1rem / 1.4 / 0.4rem` on `<html data-density="compact">`, remembered in `localStorage`.
- `--measure: calc(38 * var(--reading-size))`; measured median 67 characters per line at 768 and 1280 CSS px, 38 at 375 (`docs/verification/measure.json`, band 62–70).
- `text-align: start; text-wrap: pretty; hyphens: manual`. Never justified.
- The subsection ladder: every level element carries `.prov` and spends one `--indent-step` of `padding-left`; the `<num>` is pulled back by the same step with `min-width`, so designators hang and never wrap the text under themselves. `--indent-step` is `1em` below 40em and `1.5em` above. `em`, not `ch`, because the number is bold. `docs/verification/ladder.json`: 91.8% of sections stop at depth 3; the ladder reaches depth 7.
- Five kinds of text told apart by face first: operative text (Spectral, `--ink`), quoted amending text (Spectral in a `<blockquote>` with a tinted panel and an edge rule), editorial notes (Archivo, `--muted`, pale left rule), source credit (Archivo, above a rule), tables (Archivo, tabular figures, focusable scroll region).
- A print stylesheet with a running header (`PrintHeader.astro`) carrying the citation, the release point and the URL; notes forced open; chrome removed; every cross reference prints its URL in angle brackets.
- Two themes from one token set; contrast pairs listed in `frontend/src/data/color-pairs.json` and checked in both themes (ADR-0042, ADR-0053).

### Notes, amendment history, cross-references

- Notes and the source credit render as `<details>` with the summary drawn as a control (ADR-0060). They are the only reader-invented anchors, `#section-source` and `#section-notes` (`lib/uslm.ts: NOTES_ANCHOR`), prefixed so they cannot collide with an identifier. `ApparatusDisclosure.astro` opens them at ≥40em and opens whichever one the URL fragment names.
- `Timeline.astro` lists one entry per distinct stored text, each carrying the run of release points that held it, `change_kind`, and the public laws attributed to the transition. Two views, `text` (statutory changes) and `all`, switched by `?view=` rather than script (ADR-0075).
- `CompareWith.astro` on the section header offers one link, "What changed since <release>", where the release is the last one that held *different statutory text* (`lib/compare.ts: previousChangedRelease`), and a `<select>` of every older release point as a plain GET form. The provision being read rides along as `?at=`.
- `<ref href>` resolves to a citation URL (`lib/refs.ts`); the label for hover text comes from one batched `/api/v1/labels` call (100 identifiers max), and `data-preview` points at `/app/preview/<identifier>`, an Astro endpoint that returns the server-rendered fragment for `CitePreview.astro`'s popover (ADR-0024).
- `CopyColumn.astro` puts a copy control beside every identified provision with four modes, text / citation / citation + text / link (with a `text/html` flavour so a paste is a real hyperlink), the mode remembered in `localStorage` and overridable for one click with Shift / Alt / Ctrl-⌘. Citations are computed on the server (`lib/cite.ts`) and shipped as JSON (ADR-0033).
- Features that are built and switched off say so on the page (ADR-0034).

### What makes it good

- The identifier is the URL, the anchor, the copy target and the diff focus. One namespace serves navigation, citation and comparison.
- The section is the unit of storage, display, versioning and diff; a sub-section is always shown inside its section.
- The redline is of what the text says, not of the markup (ADR-0026), computed in two passes so the output is a document with depth and provenance per line, and it says out loud when nothing readable changed but the source differs (`sourceDelta`).
- "Compare with" defaults to the comparison a reader means, not the adjacent version.
- Everything the reader can do is a URL: release switching, comparison, timeline view and search are GET forms.
- Layout constants are measured and asserted (`--sticky-h`, the measure, the ladder, contrast, JS bytes), and the guide is the test suite.
- One keyboard map, one navigation chrome, one place that knows the source vocabulary.

### Carry over verbatim vs. adapt

Carry over verbatim (port the code or the rule as is):

| Item | Source |
|---|---|
| Two-pass reading-text diff: line alignment by character encoding, then pairing a deleted/inserted line into one "changed" line at `PAIR_THRESHOLD = 0.4`, then word-level spans; `Diff_Timeout = 0` | `frontend/src/lib/diffdoc.ts` |
| Redline rendering: `<p class="diff-line diff-line--{equal,insert,delete,changed}" style="--depth:n">` with `<ins>`/`<del>` spans, a left-gutter mark per line as well as colour | `diffdoc.ts: diffLinesHtml`, `site.scss` 4248–4293 |
| `--sticky-h` token driving `scroll-margin-top`; "nothing new may be pinned" | ADR-0044, ADR-0055 §3 |
| The `.prov` ladder with hanging `min-width` numbers in `em`; `text-wrap: pretty`, no justification | ADR-0054 §1–2 |
| Type tokens: two faces, `--reading-size / --reading-leading / --reading-gap / --measure / --indent-step`, two densities | `site.scss` 254–346, 495–498 |
| One shortcut list rendered as help and consumed as the key map; jumps move focus | `lib/shortcuts.ts`, `KeyboardNav.astro` |
| Compare control shape: one default link plus a `<select>`; `at=` carries the provision | `CompareWith.astro`, `lib/compare.ts` |
| Every identified node renders `id=<stable identifier>`; the target gets `.target` and is scrolled to centre | `lib/uslm.ts` 463–466, section page script |
| Copy modes and the server-computed citation | ADR-0033 |
| Built-but-off features say so | ADR-0034 |
| A design page rendering every component with no data; contrast pairs as data | ADR-0053 |

Adapt:

| uscode-redesign | Bill viewer |
|---|---|
| Verbatim USLM XML shipped to the reader and rendered by `uslm.ts` | The Bill Service parses WA HTM/XML once into Bill Document JSON; the viewer renders JSON and never sees the source markup. The parser is the one place that knows WA's markup, the same rule as architecture rule 5 moved one layer back. |
| Server-rendered Astro pages, no client framework | A client component (React or a framework-agnostic Web Component wrapping the same core) because it sits beside a live editor and must emit selection events. The reading surface stays static HTML inside it; interactivity is islands, as in the reader. |
| Release point → `?release=` | Bill version code in the path: `/bills/2025-26/HB2402/S`. Versions are few, named and ordered, so they are path segments rather than a query. |
| Section identifier `/us/usc/t16/s45f` | Section id `sec-3` within a version, plus a cross-version identity computed by the service (see §3, `Section.identity`). |
| Notes and source credit | The amendatory section's target RCW cite and session-law history, the "EFFECT" statement of an amendment, and the fiscal-note citations passed in as annotations. |
| Timeline of release points where text changed | The version list of the bill (Introduced → Substitute → Engrossed → …) and the amendment list attached to each. |
| Hover preview of a cross-referenced US Code section, server-rendered from the same corpus | An RCW citation links to `app.leg.wa.gov`; a hover preview needs an RCW proxy in the Bill Service and is out of the first slice. |
| Chapter rail (siblings in the hierarchy) | The bill outline (sections of this version) and the RCW-affected list. |
| `CopyColumn` clipboard modes | A "Cite in note" affordance that emits an event to the drafting editor; the clipboard modes are secondary. |

---

## 2. Principles and how they apply to a bill

The five principles of the first post, then the seven architectural principles of the second.

**1. Hierarchical navigation.** The structure of the law is navigable: up, down and across, with a table of contents and a breadcrumb.
*Bill:* Bill → version → section → subsection is the hierarchy. The outline lists sections with their kind and target RCW; the sticky bar names the current section with previous/next; a subsection is reachable by anchor and by `[`/`]`. Structure is carried in the JSON (`sections[].blocks[]` tree with labels), not inferred from indentation at render time.

**2. Keyword and citation search accessible anywhere.** A researcher can search the whole corpus and then sort and filter by location and status.
*Bill:* Search-within-bill (text and RCW cite) in the viewer's toolbar; a typed RCW cite jumps to the section that amends it. Cross-bill search is the Bill Service's job and out of the viewer's scope.

**3. Section-level display.** The section is the unit: amendments, classification and history attach to it.
*Bill:* The bill section (`Sec. 3.`) is the unit of citation ("Section 3 of the bill"), of comparison, of the RCW-affected list and of fiscal-note annotations. A subsection is always shown inside its section. Each section carries its `kind` and, when amendatory, the RCW section it restates, so the viewer can say what the section does before the drafter reads it.

**4. History and text comparison.** Knowing what the law is today and how it compares with any earlier point is the hardest task; the reader shows every point where the text changed and a redline between any two.
*Bill:* Versions are first-class: every version is its own document with a code, a label, a date and a source URL, and the fiscal note records which one it was written against. "Compare with" defaults to the previous version and offers every other. An amendment is either a version (striking) or a set of instructions overlaid on one (page-and-line). The amendatory text's own `((struck))` and underlined runs are a second diff, the diff against current law, and are typed as such in the JSON (`del`/`ins` runs) rather than as formatting.

**5. Copy and paste.** Text, text + citation and hyperlink, with a control at every level.
*Bill:* Select text or click a section → "Cite in note" emits `{sectionId, blockId, range, text, citation, href}`; the editor inserts the citation. Clipboard copy with the same four modes is a secondary control on each section.

From the architecture post:

**API-first; identifiers resolve at every level.** The viewer consumes `GET /bills/{biennium}/{number}/versions/{code}` and nothing else; every section and block has an id that is also a URL fragment.

**Section is the canonical unit.** Storage, versioning and diff are per section; the service's diff endpoint aligns sections first.

**Change history is preserved and shown, and the diff is deterministic.** Version-to-version redlines use a text diff algorithm; no generated summaries in the reading surface.

**No generative AI in the display.** The viewer renders what the service parsed. Any AI assistance belongs in the drafting pane, and the viewer has no knowledge of it.

**Open source, based on open source.** diff-match-patch, a permissive UI toolkit, no proprietary PDF stack in the viewer.

**Modular.** The viewer's only inputs are a Bill Document, an optional Amendment Document, an optional diff, and an `annotations` prop; its only outputs are events. It knows nothing about fiscal notes.

**Accessible and responsive.** WCAG 2.2 AA; struck and inserted text distinguished by mark and by an accessible name, not by colour alone; the two-pane layout collapses on narrow screens.

---

## 3. Bill Document and Amendment Document schemas

### Identity and stability rules

- `bill.id` is `{chamberPrefix}{number}` (`HB2402`, `SB5001`, `HJR4200`, `SI2124` for initiatives to the legislature). `biennium` is `2025-26`.
- `version.code` is the WA suffix as it appears in the lawfilesext filename, with `I` for the unsuffixed introduced bill: `I`, `S`, `S2`, `S3`, `E`, `E2`, `S.E`, `S2.E`, `PL`, `SL`. `version.seq` orders them.
- `sections[].id` is `sec-{num}` and is stable within a version. Substitutes renumber sections, so `sections[].identity` carries a cross-version key computed by the service: for an amendatory or repealing section, `rcw:{cite}`; for a new section added to a chapter, `new:{chapter}:{ordinal}`; for an effective-date, emergency or severability section, `kind:{kind}`; otherwise `text:{hash of first 200 chars}`. The diff endpoint aligns on `identity`, then falls back to similarity.
- `blocks[].id` is `{sectionId}.{label path}` with dots: `sec-3.1.a.ii`. A block with no label gets `{parentId}.p{n}`.
- Text runs are typed. `ins` is text the bill adds to current law (printed underlined); `del` is text the bill removes (printed as `((…))` with strikethrough). The double parentheses are kept inside the run text so a copied section reads as the printed bill reads.
- Every section carries `lines` (page and line span in the printed version) when the parser can recover them from the HTM or PDF. Page-and-line amendments resolve against these.
- `sourceHash` is the SHA-256 of the fetched source file; `textHash` per section is the hash of its whitespace-normalized plain text (runs concatenated, marks dropped). The diff endpoint uses `textHash` equality to skip unchanged sections.

### Bill Document (JSON Schema 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wa-leg.example/schemas/bill-document.json",
  "title": "BillDocument",
  "type": "object",
  "required": ["schemaVersion", "bill", "version", "header", "sections", "provenance"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "bill": {
      "type": "object",
      "required": ["biennium", "chamber", "type", "number", "id"],
      "properties": {
        "biennium": { "type": "string", "pattern": "^\\d{4}-\\d{2}$" },
        "chamber": { "enum": ["H", "S"] },
        "type": { "enum": ["B", "JR", "JM", "CR", "I"], "description": "Bill, joint resolution, joint memorial, concurrent resolution, initiative" },
        "number": { "type": "integer", "minimum": 1 },
        "id": { "type": "string", "pattern": "^[HS](B|JR|JM|CR|I)\\d{1,5}$" },
        "shortTitle": { "type": "string" },
        "billPageUrl": { "type": "string", "format": "uri" }
      }
    },
    "version": {
      "type": "object",
      "required": ["code", "label", "seq"],
      "properties": {
        "code": { "type": "string", "pattern": "^(I|S\\d?|E\\d?|S\\d?\\.E\\d?|PL|SL)$" },
        "label": { "type": "string", "examples": ["Engrossed Substitute House Bill"] },
        "seq": { "type": "integer", "minimum": 0 },
        "date": { "type": "string", "format": "date" },
        "sourceUrls": {
          "type": "object",
          "properties": {
            "htm": { "type": "string", "format": "uri" },
            "pdf": { "type": "string", "format": "uri" },
            "xml": { "type": "string", "format": "uri" }
          }
        },
        "sourceHash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "isCurrent": { "type": "boolean", "description": "Newest version the service holds" }
      }
    },
    "versions": {
      "type": "array",
      "description": "Every version of this bill the service holds, in seq order",
      "items": {
        "type": "object",
        "required": ["code", "label", "seq"],
        "properties": {
          "code": { "type": "string" },
          "label": { "type": "string" },
          "seq": { "type": "integer" },
          "date": { "type": "string", "format": "date" },
          "amendmentIds": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "header": {
      "type": "object",
      "required": ["title"],
      "properties": {
        "title": { "type": "string", "description": "The full AN ACT title" },
        "relatingTo": { "type": "string" },
        "sponsors": { "type": "array", "items": { "type": "string" } },
        "byRequestOf": { "type": "string" },
        "briefDescription": { "type": "string" },
        "readFirstTime": { "type": "string", "format": "date" },
        "referredTo": { "type": "string" },
        "titleActions": {
          "type": "array",
          "description": "Parsed from the title clauses after 'Relating to'",
          "items": {
            "type": "object",
            "required": ["kind"],
            "properties": {
              "kind": { "enum": ["amending", "reenacting-and-amending", "adding-section", "adding-chapter", "repealing", "decodifying", "recodifying", "creating-new-sections", "effective-date", "emergency", "expiration", "appropriation", "other"] },
              "cites": { "type": "array", "items": { "$ref": "#/$defs/cite" } },
              "text": { "type": "string" }
            }
          }
        }
      }
    },
    "sections": { "type": "array", "items": { "$ref": "#/$defs/section" } },
    "rcwAffected": {
      "type": "array",
      "description": "Derived: one row per RCW section the bill touches, in RCW order",
      "items": {
        "type": "object",
        "required": ["cite", "action", "sectionIds"],
        "properties": {
          "cite": { "type": "string" },
          "chapter": { "type": "string" },
          "action": { "enum": ["amend", "reenact-amend", "add", "repeal", "decodify", "recodify", "reference"] },
          "sectionIds": { "type": "array", "items": { "type": "string" } },
          "href": { "type": "string", "format": "uri" },
          "caption": { "type": "string" }
        }
      }
    },
    "provenance": {
      "type": "object",
      "required": ["fetchedAt", "parser", "parserVersion"],
      "properties": {
        "fetchedAt": { "type": "string", "format": "date-time" },
        "parser": { "type": "string" },
        "parserVersion": { "type": "string" },
        "warnings": { "type": "array", "items": { "type": "string" } },
        "hasLineNumbers": { "type": "boolean" }
      }
    }
  },
  "$defs": {
    "cite": {
      "type": "object",
      "required": ["kind", "text"],
      "properties": {
        "kind": { "enum": ["rcw", "rcw-chapter", "rcw-title", "session-law", "bill-section", "wac", "usc", "cfr", "other"] },
        "text": { "type": "string", "examples": ["RCW 82.04.050", "2024 c 123 s 4", "section 3 of this act"] },
        "cite": { "type": "string", "examples": ["82.04.050"] },
        "href": { "type": "string", "format": "uri" },
        "targetId": { "type": "string", "description": "For bill-section cites: the section id in this document" }
      }
    },
    "run": {
      "type": "object",
      "required": ["t", "text"],
      "properties": {
        "t": { "enum": ["text", "ins", "del", "cite"] },
        "text": { "type": "string" },
        "cite": { "$ref": "#/$defs/cite" },
        "mark": { "enum": ["ins", "del"], "description": "On a cite run: whether the cite sits inside inserted or struck text" },
        "line": { "type": "integer", "description": "Printed line number at the start of this run, when known" },
        "page": { "type": "integer" }
      }
    },
    "block": {
      "type": "object",
      "required": ["id", "level", "runs"],
      "properties": {
        "id": { "type": "string" },
        "label": { "type": "string", "examples": ["(1)", "(a)", "(i)", "(A)"] },
        "labelMark": { "enum": ["ins", "del"], "description": "The designator itself is inserted or struck" },
        "level": { "type": "integer", "minimum": 1 },
        "kind": { "enum": ["subsection", "paragraph", "subparagraph", "item", "subitem", "unnumbered", "table", "chapeau"] },
        "runs": { "type": "array", "items": { "$ref": "#/$defs/run" } },
        "children": { "type": "array", "items": { "$ref": "#/$defs/block" } },
        "lines": { "$ref": "#/$defs/lineSpan" }
      }
    },
    "lineSpan": {
      "type": "object",
      "required": ["pageStart", "lineStart", "pageEnd", "lineEnd"],
      "properties": {
        "pageStart": { "type": "integer" },
        "lineStart": { "type": "integer" },
        "pageEnd": { "type": "integer" },
        "lineEnd": { "type": "integer" }
      }
    },
    "section": {
      "type": "object",
      "required": ["id", "num", "label", "kind", "identity", "blocks", "textHash"],
      "properties": {
        "id": { "type": "string", "pattern": "^sec-\\d+[a-z]?$" },
        "num": { "type": "string" },
        "label": { "type": "string", "examples": ["Sec. 2.", "NEW SECTION. Sec. 3."] },
        "isNewSection": { "type": "boolean" },
        "kind": { "enum": ["amendatory", "new", "repealer", "effective-date", "emergency", "severability", "expiration", "intent", "appropriation", "contingent", "other"] },
        "identity": { "type": "string", "description": "Cross-version alignment key; see rules above" },
        "heading": { "type": "string" },
        "target": {
          "type": "object",
          "description": "Present for amendatory, repealer, and new sections added to a chapter",
          "required": ["action"],
          "properties": {
            "action": { "enum": ["amend", "reenact-amend", "add", "repeal", "decodify", "recodify"] },
            "cite": { "type": "string", "examples": ["82.04.050"] },
            "chapter": { "type": "string", "examples": ["82.04"] },
            "history": { "type": "string", "examples": ["2024 c 123 s 4"] },
            "href": { "type": "string", "format": "uri" },
            "repealed": {
              "type": "array",
              "description": "For a repealer: every section repealed, with caption and history",
              "items": { "type": "object", "properties": { "cite": { "type": "string" }, "caption": { "type": "string" }, "history": { "type": "string" }, "href": { "type": "string", "format": "uri" } } }
            }
          }
        },
        "introText": { "type": "array", "items": { "$ref": "#/$defs/run" }, "description": "The amending clause: 'RCW 82.04.050 and 2024 c 123 s 4 are each amended to read as follows:'" },
        "blocks": { "type": "array", "items": { "$ref": "#/$defs/block" } },
        "notes": { "type": "array", "items": { "type": "string" } },
        "lines": { "$ref": "#/$defs/lineSpan" },
        "textHash": { "type": "string" },
        "changeSummary": {
          "type": "object",
          "description": "Derived counts of the amendatory marks in this section",
          "properties": { "insWords": { "type": "integer" }, "delWords": { "type": "integer" } }
        }
      }
    }
  }
}
```

### Amendment Document (JSON Schema 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wa-leg.example/schemas/amendment-document.json",
  "title": "AmendmentDocument",
  "type": "object",
  "required": ["schemaVersion", "id", "bill", "baseVersion", "kind", "provenance"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "id": { "type": "string", "examples": ["2402-S AMH JUDI H2567.1", "2402-S.E AMS ENGR S3456.E"] },
    "bill": { "type": "object", "required": ["biennium", "id"], "properties": { "biennium": { "type": "string" }, "id": { "type": "string" } } },
    "baseVersion": { "type": "string", "description": "Version code the amendment is drawn to" },
    "kind": { "enum": ["striking", "page-line", "title"] },
    "scope": { "enum": ["floor", "committee", "conference"] },
    "chamber": { "enum": ["H", "S"] },
    "sponsor": { "type": "string" },
    "committee": { "type": "string" },
    "drafterCode": { "type": "string", "examples": ["H2567.1"] },
    "status": { "enum": ["pending", "adopted", "failed", "withdrawn", "ruled-out-of-order", "unknown"] },
    "actionDate": { "type": "string", "format": "date" },
    "effect": { "type": "string", "description": "The EFFECT statement printed with committee amendments" },
    "sourceUrls": { "type": "object", "properties": { "htm": { "type": "string", "format": "uri" }, "pdf": { "type": "string", "format": "uri" } } },
    "sourceHash": { "type": "string" },
    "body": {
      "type": "object",
      "description": "Striking amendment only: the replacement text after the enacting clause, as a full section list",
      "properties": {
        "header": { "type": "object", "properties": { "title": { "type": "string" }, "titleActions": { "type": "array" } } },
        "sections": { "type": "array", "items": { "$ref": "bill-document.json#/$defs/section" } }
      }
    },
    "instructions": {
      "type": "array",
      "description": "Page-line and title amendments: one entry per numbered instruction, in document order",
      "items": { "$ref": "#/$defs/instruction" }
    },
    "provenance": { "$ref": "bill-document.json#/properties/provenance" }
  },
  "$defs": {
    "instruction": {
      "type": "object",
      "required": ["id", "seq", "op", "location", "text"],
      "properties": {
        "id": { "type": "string" },
        "seq": { "type": "integer" },
        "text": { "type": "string", "description": "The instruction as printed" },
        "op": { "enum": ["strike-insert", "strike", "insert", "strike-section", "insert-section", "strike-all-insert", "renumber", "title-strike-insert", "title-insert", "correct-internal-references"] },
        "location": {
          "type": "object",
          "properties": {
            "page": { "type": "integer" },
            "line": { "type": "integer" },
            "lineEnd": { "type": "integer" },
            "anchor": { "enum": ["after", "before", "beginning", "end"] },
            "anchorText": { "type": "string", "description": "The quoted word after/before which the edit applies" },
            "sectionNum": { "type": "string", "description": "When the instruction names a section rather than a line" },
            "title": { "type": "boolean" }
          }
        },
        "strikeText": { "type": "string" },
        "insertText": { "type": "string" },
        "insertBlocks": { "type": "array", "items": { "$ref": "bill-document.json#/$defs/block" } },
        "insertSections": { "type": "array", "items": { "$ref": "bill-document.json#/$defs/section" } },
        "resolved": {
          "type": "object",
          "description": "Filled by the service when it can map the instruction onto the base version",
          "properties": {
            "sectionId": { "type": "string" },
            "blockId": { "type": "string" },
            "runIndex": { "type": "integer" },
            "charStart": { "type": "integer" },
            "charEnd": { "type": "integer" },
            "confidence": { "enum": ["exact", "line-only", "text-only", "unresolved"] },
            "note": { "type": "string" }
          }
        }
      }
    }
  }
}
```

### Example: a small bill

Substitute House Bill 2402, three sections. Illustrative text.

```json
{
  "schemaVersion": "1.0",
  "bill": {
    "biennium": "2025-26",
    "chamber": "H",
    "type": "B",
    "number": 2402,
    "id": "HB2402",
    "shortTitle": "Sales tax exemption for feminine hygiene products",
    "billPageUrl": "https://app.leg.wa.gov/billsummary?BillNumber=2402&Year=2025"
  },
  "version": {
    "code": "S",
    "label": "Substitute House Bill",
    "seq": 1,
    "date": "2026-01-28",
    "sourceUrls": {
      "htm": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Bills/House%20Bills/2402-S.htm",
      "pdf": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Pdf/Bills/House%20Bills/2402-S.pdf"
    },
    "sourceHash": "sha256:0f3c7a9d1b2e4c5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
    "isCurrent": true
  },
  "versions": [
    { "code": "I", "label": "House Bill", "seq": 0, "date": "2026-01-12", "amendmentIds": [] },
    { "code": "S", "label": "Substitute House Bill", "seq": 1, "date": "2026-01-28", "amendmentIds": ["2402-S AMH FIN H2567.1"] }
  ],
  "header": {
    "title": "AN ACT Relating to a sales and use tax exemption for feminine hygiene products; amending RCW 82.08.0293; adding a new section to chapter 82.12 RCW; and providing an effective date.",
    "relatingTo": "a sales and use tax exemption for feminine hygiene products",
    "sponsors": ["House Committee on Finance (originally sponsored by Representatives Doe, Roe)"],
    "readFirstTime": "2026-01-28",
    "titleActions": [
      { "kind": "amending", "cites": [{ "kind": "rcw", "text": "RCW 82.08.0293", "cite": "82.08.0293", "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.08.0293" }] },
      { "kind": "adding-section", "cites": [{ "kind": "rcw-chapter", "text": "chapter 82.12 RCW", "cite": "82.12", "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.12" }] },
      { "kind": "effective-date" }
    ]
  },
  "sections": [
    {
      "id": "sec-1",
      "num": "1",
      "label": "Sec. 1.",
      "isNewSection": false,
      "kind": "amendatory",
      "identity": "rcw:82.08.0293",
      "target": {
        "action": "amend",
        "cite": "82.08.0293",
        "chapter": "82.08",
        "history": "2024 c 27 s 3",
        "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.08.0293"
      },
      "introText": [
        { "t": "cite", "text": "RCW 82.08.0293", "cite": { "kind": "rcw", "text": "RCW 82.08.0293", "cite": "82.08.0293", "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.08.0293" } },
        { "t": "text", "text": " and 2024 c 27 s 3 are each amended to read as follows:" }
      ],
      "blocks": [
        {
          "id": "sec-1.1",
          "label": "(1)",
          "level": 1,
          "kind": "subsection",
          "runs": [
            { "t": "text", "text": "The tax levied by RCW 82.08.020 does not apply to sales of " },
            { "t": "del", "text": "((food and food ingredients))" },
            { "t": "ins", "text": "food, food ingredients, and feminine hygiene products" },
            { "t": "text", "text": "." }
          ],
          "children": [],
          "lines": { "pageStart": 1, "lineStart": 7, "pageEnd": 1, "lineEnd": 9 }
        },
        {
          "id": "sec-1.2",
          "label": "(2)",
          "labelMark": "ins",
          "level": 1,
          "kind": "subsection",
          "runs": [
            { "t": "ins", "text": "\"Feminine hygiene products\" means sanitary napkins, tampons, menstrual cups, and similar products used to collect menstrual flow." }
          ],
          "children": [],
          "lines": { "pageStart": 1, "lineStart": 10, "pageEnd": 1, "lineEnd": 12 }
        }
      ],
      "lines": { "pageStart": 1, "lineStart": 5, "pageEnd": 1, "lineEnd": 12 },
      "textHash": "sha256:3a5f…",
      "changeSummary": { "insWords": 24, "delWords": 4 }
    },
    {
      "id": "sec-2",
      "num": "2",
      "label": "NEW SECTION. Sec. 2.",
      "isNewSection": true,
      "kind": "new",
      "identity": "new:82.12:1",
      "target": { "action": "add", "chapter": "82.12", "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.12" },
      "introText": [
        { "t": "text", "text": "A new section is added to chapter 82.12 RCW to read as follows:" }
      ],
      "blocks": [
        {
          "id": "sec-2.p1",
          "level": 1,
          "kind": "unnumbered",
          "runs": [
            { "t": "ins", "text": "The provisions of this chapter do not apply to the use of feminine hygiene products as defined in " },
            { "t": "cite", "text": "RCW 82.08.0293", "mark": "ins", "cite": { "kind": "rcw", "text": "RCW 82.08.0293", "cite": "82.08.0293", "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.08.0293" } },
            { "t": "ins", "text": "." }
          ],
          "children": [],
          "lines": { "pageStart": 1, "lineStart": 14, "pageEnd": 1, "lineEnd": 16 }
        }
      ],
      "lines": { "pageStart": 1, "lineStart": 13, "pageEnd": 1, "lineEnd": 16 },
      "textHash": "sha256:9c1e…",
      "changeSummary": { "insWords": 22, "delWords": 0 }
    },
    {
      "id": "sec-3",
      "num": "3",
      "label": "NEW SECTION. Sec. 3.",
      "isNewSection": true,
      "kind": "effective-date",
      "identity": "kind:effective-date",
      "blocks": [
        {
          "id": "sec-3.p1",
          "level": 1,
          "kind": "unnumbered",
          "runs": [{ "t": "ins", "text": "This act takes effect January 1, 2027." }],
          "children": [],
          "lines": { "pageStart": 1, "lineStart": 18, "pageEnd": 1, "lineEnd": 18 }
        }
      ],
      "lines": { "pageStart": 1, "lineStart": 17, "pageEnd": 1, "lineEnd": 18 },
      "textHash": "sha256:b77d…"
    }
  ],
  "rcwAffected": [
    { "cite": "82.08.0293", "chapter": "82.08", "action": "amend", "sectionIds": ["sec-1"], "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.08.0293", "caption": "Exemptions—Sales of food and food ingredients" },
    { "cite": "82.12", "chapter": "82.12", "action": "add", "sectionIds": ["sec-2"], "href": "https://app.leg.wa.gov/RCW/default.aspx?cite=82.12", "caption": "Use tax" }
  ],
  "provenance": {
    "fetchedAt": "2026-02-01T18:04:11Z",
    "parser": "wa-bill-htm",
    "parserVersion": "0.3.0",
    "warnings": [],
    "hasLineNumbers": true
  }
}
```

A page-and-line amendment against it:

```json
{
  "schemaVersion": "1.0",
  "id": "2402-S AMH FIN H2567.1",
  "bill": { "biennium": "2025-26", "id": "HB2402" },
  "baseVersion": "S",
  "kind": "page-line",
  "scope": "committee",
  "chamber": "H",
  "committee": "Finance",
  "drafterCode": "H2567.1",
  "status": "adopted",
  "actionDate": "2026-02-03",
  "effect": "Delays the effective date to January 1, 2028.",
  "sourceUrls": { "htm": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Amendments/House/2402-S%20AMH%20FIN%20H2567.1.htm" },
  "instructions": [
    {
      "id": "i1",
      "seq": 1,
      "text": "On page 1, line 18, after \"January 1,\" strike \"2027\" and insert \"2028\"",
      "op": "strike-insert",
      "location": { "page": 1, "line": 18, "anchor": "after", "anchorText": "January 1," },
      "strikeText": "2027",
      "insertText": "2028",
      "resolved": { "sectionId": "sec-3", "blockId": "sec-3.p1", "runIndex": 0, "charStart": 32, "charEnd": 36, "confidence": "exact" }
    }
  ],
  "provenance": { "fetchedAt": "2026-02-04T09:00:00Z", "parser": "wa-amendment-htm", "parserVersion": "0.3.0", "warnings": [] }
}
```

---

## 4. UI design

### Layout

Two panes with a resizable splitter. The bill viewer is the left pane; the drafting editor (or, for the Steering Committee, the approved note) is the right. The viewer's chrome is one sticky stack inside its own scroll container, so the bill scrolls while the note stays put.

```
┌──────────────────────────────────────────────────────────┬─┬──────────────────────────────┐
│ ◧ HB 2402 · Substitute ▾   Compare with… ▾   Overlay ☐   │ │  Fiscal note (editor)        │
│ ─────────────────────────────────────────────────────────│ │                              │
│ ← Sec. 1   Sec. 2 · NEW SECTION · adds to ch. 82.12   ↑ Sec. 3 →   Cite ⧉   Copy ▾       │ │  …                           │
│ ─────────────────────────────────────────────────────────│ │                              │
│ ┌ Outline ───────┐ ┌ Reading column ───────────────────┐ │ │                              │
│ │ ▸ Title        │ │                                    │ │ │                              │
│ │ ● Sec. 1 amend │ │  NEW SECTION. Sec. 2.              │ │ │                              │
│ │   82.08.0293   │ │  A new section is added to chapter │ │ │                              │
│ │ ● Sec. 2 new   │ │  82.12 RCW to read as follows:     │ │ │                              │
│ │   ch. 82.12    │ │                                    │ │ │                              │
│ │ ● Sec. 3 eff.  │ │  The provisions of this chapter do │ │ │                              │
│ │   date         │ │  not apply to the use of feminine  │ │ │                              │
│ │ ───────────────│ │  hygiene products as defined in    │ │ │                              │
│ │ RCW affected   │ │  RCW 82.08.0293.                   │ │ │                              │
│ │  82.08.0293 A  │ │  ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾ (underlined)     │ │ │                              │
│ │  82.12 +       │ │                                    │ │ │                              │
│ │ ───────────────│ │  NEW SECTION. Sec. 3.              │ │ │                              │
│ │ 🔍 Find in bill│ │  This act takes effect January 1,  │ │ │                              │
│ └────────────────┘ │  2027.                             │ │ │                              │
│                    └────────────────────────────────────┘ │ │                              │
└──────────────────────────────────────────────────────────┴─┴──────────────────────────────┘
```

Regions, top to bottom:

1. **Toolbar** (sticky). Bill id and version switcher (`<select>` or menu listing `versions[]`, newest marked); "Compare with…" (a disclosure: one default link, "What changed since Introduced", plus a select of the other versions); "Overlay amendment" toggle with a picker when the version has amendments; a collapse button (◧) that hides the outline, and a second that collapses the whole pane to a 2.5rem strip carrying the bill id and an expand button.
2. **Section bar** (sticky, one line). Previous section, the current section's label, kind and target, up-to-top, next section, "Cite" (emits `cite` for the whole section) and "Copy" (four modes). Always rendered; the section shown is the one at the reading line, updated by an `IntersectionObserver` over section headings. Its height is counted in `--sticky-h` along with the toolbar.
3. **Outline** (left column of the viewer from 64em; a disclosure above the text below that). Sections with kind badge and target cite; `aria-current` on the section at the reading line; below it the RCW-affected list (cite, action letter, link to `app.leg.wa.gov`, and a jump to the section) and the find-in-bill box. Sticky with a bounded height that scrolls inside itself.
4. **Reading column**. The bill header (title, sponsors, brief description) as a collapsed `<details>` open on first load; then every section in order. Each section is an `<section id="sec-n" aria-labelledby>` with an `<h2>`; blocks nest as `<div class="prov" id="sec-n.1.a">` with hanging labels; runs render as text, `<ins>`, `<del>` and `<a>`.

Collapsed pane:

```
┌─┬─┬──────────────────────────────────────────────────────────────────────┐
│H│ │  Fiscal note (editor)                                                 │
│B│ │                                                                       │
│ │ │                                                                       │
│2│ │                                                                       │
│4│ │                                                                       │
│0│ │                                                                       │
│2│ │                                                                       │
│▸│ │                                                                       │
└─┴─┴──────────────────────────────────────────────────────────────────────┘
```

Compare view (replaces the reading column; the outline marks sections that changed):

```
│ ← Sec. 1 · changed   Introduced → Substitute   3 lines changed, 1 added, 0 removed   ⤫ Close │
│ ──────────────────────────────────────────────────────────────────────────────────────────── │
│ ▌ (1) The tax levied by RCW 82.08.020 does not apply to sales of ((food and food             │
│ ▌ ingredients)) food, food ingredients, ⟦and feminine hygiene products⟧.                     │
│ ▏ (2) "Feminine hygiene products" means sanitary napkins, tampons, ⟦menstrual cups,⟧ and     │
│ ▏ similar products used to collect menstrual flow.                                           │
│ + (3) ⟦This section expires January 1, 2032.⟧                                                │
```

`▌` marks a changed line, `+` an added line, `−` a removed line, in the gutter as well as by colour. `⟦…⟧` stands for the version-diff insertion mark, which is a distinct mark from the bill's own underline (see Reading design).

Amendment overlay (the reading column with a second layer):

```
│ ← Sec. 3 · effective date   Overlay: 2402-S AMH FIN H2567.1 (adopted 2026-02-03)   1 of 1 applied │
│ ───────────────────────────────────────────────────────────────────────────────────────────────── │
│   NEW SECTION. Sec. 3.                                                                            │
│   This act takes effect January 1, ⟨2027⟩ ⟦2028⟧.                                                 │
│   └ i1  p.1 l.18  after "January 1," strike "2027" and insert "2028"   exact                     │
│                                                                                                   │
│ EFFECT: Delays the effective date to January 1, 2028.                                            │
```

`⟨…⟩` is amendment-struck, `⟦…⟧` amendment-inserted; each resolved instruction is footnoted under the block it lands on, and unresolved instructions are listed at the top of the column with their printed text and a "locate" affordance that scrolls to the nearest line.

### Reading design

- **Measure.** `--measure: calc(38 * var(--reading-size))`; the reading column never exceeds it whatever the splitter does. When the pane is narrower than the measure the column is the pane width.
- **Faces.** One serif for bill text and one sans for the interface, self-hosted, with a real fallback stack. The uscode-redesign pair (Spectral, Archivo) is acceptable; the choice is a token.
- **Sizes.** `--reading-size 1.05rem`, `--reading-leading 1.6`, `--reading-gap 0.75rem`; compact density `1rem / 1.4 / 0.4rem`. Interface text `0.875–0.95rem`. Section headings (`Sec. 2.`) at `1.05rem` bold small caps, matching the printed bill's run-in heading rather than a display size.
- **Ladder.** `.prov { padding-left: var(--indent-step) }` with the label pulled back by the same step and `min-width` equal to it; `--indent-step: 1.5em` from 40em, `1em` below. The WA ladder is (1)(a)(i)(A) and rarely exceeds depth 4.
- **Amendatory marks, consistent with the printed bill.** `<del>` renders with `text-decoration: line-through` and keeps the `((…))` in the text; `<ins>` renders with `text-decoration: underline; text-decoration-thickness: 0.08em; text-underline-offset: 0.12em`. No colour is required for either; a faint wash (`--danger` at 0.12 alpha under `<del>`, `--version` at 0.12 under `<ins>`) is allowed and must be tested for contrast in both themes. Each `<del>` and `<ins>` carries a visually-hidden prefix and suffix ("struck:" / "end struck", "inserted:" / "end inserted") that a toggle in the toolbar can silence for screen-reader users who prefer the bare text.
- **A second mark set for the version diff and the amendment overlay.** The bill's own `((…))` and underline are meaning in the text and must not be reused. Version-diff insertions and deletions use a background wash plus a left-gutter bar per line, as `diffdoc.ts` renders; amendment-overlay marks use a dotted outline and a superscript instruction id. A legend sits at the top of the compare and overlay views.
- **Line numbers.** Optional gutter, off by default, showing the printed page and line at the start of each block (`block.lines`). On when an overlay is active or when the drafter turns them on; the toggle is remembered in `localStorage`.
- **Cites.** RCW cites are links to `app.leg.wa.gov` opening in a new tab, marked external; bill-section cites ("section 3 of this act") are in-page links to `#sec-3`.
- **Print.** A print stylesheet with a running header (bill id, version label and date, URL), outline and toolbar removed, marks preserved, line numbers on.
- **Themes.** Light default, dark by choice, one token set; the printed-bill marks must be legible in both.

### Interaction

- **Select text → "Cite in note".** On `selectionchange` inside the reading column, a small floating control appears at the selection's end with "Cite" and "Copy". "Cite" emits `cite` with the section id, the innermost block id, the selected text, the char range within the block's plain text, a citation string (`Section 1(2) of SHB 2402`) and the deep-link href. The control is also reachable by keyboard: `.` (period) with a selection present, and the section bar's "Cite" button for the whole section.
- **Click a section heading or label** → emits `sectionSelect`; a second click on the same heading opens its context menu (cite, copy, open RCW target, compare this section, jump to line).
- **Annotations.** The `annotations` prop is a list of `{sectionId, blockId?, range?, label, kind, href?}`. The viewer draws a marker in the left gutter of each annotated block and a count in the outline; clicking a marker emits `annotationActivate`. The viewer does not read or write annotations.
- **Keyboard map** (single list, rendered as a help dialog on `?`):

  | Key | Action |
  |---|---|
  | `j` / `k` | Next / previous section |
  | `]` / `[` | Next / previous block at the top level of the current section |
  | `u` | Top of the current section |
  | `t` / `b` | Top / bottom of the bill |
  | `o` | Toggle the outline |
  | `v` | Version switcher |
  | `d` | Compare with previous version (opens the compare view) |
  | `a` | Toggle the amendment overlay |
  | `/` | Find in bill |
  | `.` | Cite the current selection or section |
  | `c` | Copy (current mode) |
  | `l` | Toggle line numbers |
  | `?` | Help |
  | `Esc` | Close the compare view, overlay picker, find box or help |

  `j`/`k` follow the next/previous convention. Keys do nothing while focus is in a text field, including the note editor; the map is scoped to the viewer's root element and only fires when focus is inside it or on the body with the viewer as the last activated pane.
- **Scroll position** is kept per version in memory; switching version scrolls to the section with the same `identity`, or the same section number when identity does not match.
- **Deep links** (`#sec-3`, `#sec-3.1.a`) scroll the target under the sticky stack (`scroll-margin-top: var(--sticky-h)`), mark it `.target` for one paint cycle plus a persistent left rule, and move focus to it.

### Accessibility (WCAG 2.2 AA)

- Landmarks: the viewer root is `<section aria-label="Bill text">` with a `<nav aria-label="Bill outline">`, a `<nav aria-label="Section">` for the sticky bar, a `<main>` equivalent as `role="region" aria-label="Reading column"` (the host page owns `<main>`), and a `role="status"` region for one-sentence key feedback.
- Headings: bill title `<h1>` (visually the toolbar's label); each section `<h2>`; blocks are not headings.
- Focus order: toolbar → section bar → outline → reading column → floating cite control (only when present). The splitter is a `role="separator"` with `aria-valuenow`, `aria-orientation="vertical"`, keyboard-resizable with arrow keys, and collapsible with `Home`/`End`.
- Marks not by colour alone: `<del>`/`<ins>` keep their text decorations; diff lines carry a gutter glyph and `aria-label` on the line ("changed line", "added line"); the legend is text.
- Contrast: every token pair listed in a `color-pairs.json` and asserted ≥ 4.5:1 for text and ≥ 3:1 for gutter marks and focus rings, in both themes. The focus ring is a token per theme.
- Target size: every control ≥ 24×24 CSS px (2.2 SC 2.5.8); the cite control ≥ 44 px on touch.
- Reflow: at 320 CSS px the viewer is single-column with no horizontal scroll; the printed-bill marks survive 200% zoom.
- Dragging the splitter has a keyboard and a button alternative (SC 2.5.7).
- The help dialog is a `<dialog>` opened with `showModal()`; the overlay picker and the compare picker are `<details>` disclosures.
- The viewer is tested with axe at 320, 375, 768 and 1280 in both themes and in forced-colours mode; in forced colours the marks fall back to decoration only.

### Responsive behaviour

| Width | Layout |
|---|---|
| ≥ 90em | Two panes; the viewer has outline + reading column side by side. |
| 64–90em | Two panes; the outline is a disclosure above the reading column, sticky bar remains. |
| 40–64em | Panes become tabs ("Bill" / "Note") in the host; inside the viewer the toolbar collapses to icons and the section bar is the only sticky element. |
| < 40em | Single column; the toolbar becomes a bottom bar; `--indent-step: 1em`; line numbers hidden. |

The splitter position and the outline state are remembered in `localStorage` per user, wrapped in try/catch.

---

## 5. Component API, endpoints, URLs

### Components

```ts
// ---------- shared types (mirror of the JSON schemas; kept narrow) ----------

export type VersionCode = string;            // "I" | "S" | "S2" | "E" | "S.E" | "PL" | "SL" …

export interface BillRef { biennium: string; id: string }   // { "2025-26", "HB2402" }

export interface Annotation {
  id: string;
  sectionId: string;
  blockId?: string;
  range?: { start: number; end: number };    // char offsets in the block's plain text
  kind: "citation" | "comment" | "assumption" | "flag";
  label: string;                             // "Cited in Assumptions ¶2"
  href?: string;
}

export interface CiteEvent {
  bill: BillRef;
  versionCode: VersionCode;
  sectionId: string;
  sectionNum: string;
  blockId: string | null;
  label: string | null;                      // "(1)(a)"
  range: { start: number; end: number } | null;
  text: string;                              // selected plain text, or the block/section text
  citation: string;                          // "Section 1(1)(a) of SHB 2402"
  href: string;                              // "/bills/2025-26/HB2402/S#sec-1.1.a"
  amendmentId?: string;                      // set when the overlay was active
}

export interface SectionSelectEvent {
  sectionId: string;
  sectionNum: string;
  kind: BillSection["kind"];
  target?: BillSection["target"];
  via: "click" | "keyboard" | "outline" | "hash";
}

export interface ViewerState {
  versionCode: VersionCode;
  compareFrom: VersionCode | null;
  overlayAmendmentId: string | null;
  outlineOpen: boolean;
  lineNumbers: boolean;
  density: "comfortable" | "compact";
  activeSectionId: string | null;
}

// ---------- <BillViewer> ----------

export interface BillViewerProps {
  /** The version to render. Fully loaded; the viewer makes no requests of its own. */
  document: BillDocument;
  /** Optional: the from-side document and a precomputed diff for the compare view. */
  compare?: { from: BillDocument; diff: VersionDiff } | null;
  /** Optional: an amendment to overlay. Striking amendments are passed as `compare` instead. */
  overlay?: AmendmentDocument | null;
  annotations?: Annotation[];
  /** Initial state; the viewer owns it afterwards and reports changes. */
  initialState?: Partial<ViewerState>;
  /** Fragment to open on mount, e.g. "sec-3.1.a". */
  hash?: string | null;
  /** Read-only for end users: hides Cite, keeps Copy and navigation. */
  readOnly?: boolean;
  /** Where hrefs point; the viewer builds every URL through this. */
  urlBuilder: BillUrlBuilder;
  /** Rendering knobs, all optional. */
  options?: {
    showHeader?: boolean;           // default true
    showRcwAffected?: boolean;      // default true
    collapsible?: boolean;          // default true
    theme?: "light" | "dark" | "system";
  };

  onCite?: (e: CiteEvent) => void;
  onSectionSelect?: (e: SectionSelectEvent) => void;
  onAnnotationActivate?: (a: Annotation) => void;
  /** Fired when the user asks for another version, a comparison or an overlay; the host fetches and re-renders. */
  onRequestVersion?: (code: VersionCode) => void;
  onRequestCompare?: (from: VersionCode, to: VersionCode) => void;
  onRequestOverlay?: (amendmentId: string | null) => void;
  onStateChange?: (s: ViewerState) => void;
  /** Fired when the active section or fragment changes so the host can update the URL. */
  onNavigate?: (hash: string) => void;
}

// ---------- <BillOutline> ----------

export interface BillOutlineProps {
  document: BillDocument;
  activeSectionId: string | null;
  /** Section ids with changes, when a compare is active; drawn as a dot. */
  changedSectionIds?: string[];
  /** Section ids an overlay instruction lands on. */
  amendedSectionIds?: string[];
  annotationCounts?: Record<string, number>;
  showRcwAffected?: boolean;
  urlBuilder: BillUrlBuilder;
  onSelect?: (sectionId: string, via: "click" | "keyboard") => void;
  onFind?: (query: string) => void;
}

// ---------- <VersionCompare> ----------

export interface VersionCompareProps {
  from: BillDocument;
  to: BillDocument;
  diff: VersionDiff;
  /** Section to scroll to and mark. */
  focusSectionId?: string | null;
  /** "as-printed" diffs the bill text with its marks; "effect" diffs the resulting law text. */
  mode?: "as-printed" | "effect";
  urlBuilder: BillUrlBuilder;
  onCite?: (e: CiteEvent) => void;
  onClose?: () => void;
}

// ---------- <AmendmentOverlay> ----------

export interface AmendmentOverlayProps {
  base: BillDocument;
  amendment: AmendmentDocument;             // kind: "page-line" | "title"
  showLineNumbers?: boolean;                // default true while an overlay is active
  urlBuilder: BillUrlBuilder;
  onCite?: (e: CiteEvent) => void;
  onInstructionSelect?: (instructionId: string) => void;
  onClose?: () => void;
}

// ---------- diff payload (from GET …/diff) ----------

export interface VersionDiff {
  bill: BillRef;
  from: VersionCode;
  to: VersionCode;
  mode: "as-printed" | "effect";
  sections: SectionDiff[];
  summary: { changed: number; inserted: number; deleted: number; sectionsChanged: number };
}

export interface SectionDiff {
  identity: string;
  fromSectionId: string | null;             // null: section added
  toSectionId: string | null;               // null: section removed
  status: "equal" | "changed" | "added" | "removed" | "renumbered";
  lines: DiffLine[];                        // the diffdoc.ts shape
}

export interface DiffLine {
  mark: "equal" | "insert" | "delete" | "changed";
  depth: number;
  blockId: string | null;                   // owner in the `to` document (or `from` for deletions)
  spans: { mark: "equal" | "insert" | "delete"; text: string; billMark?: "ins" | "del" }[];
}

// ---------- URLs ----------

export interface BillUrlBuilder {
  version(bill: BillRef, code: VersionCode, hash?: string): string;
  compare(bill: BillRef, from: VersionCode, to: VersionCode, at?: string): string;
  amendment(bill: BillRef, code: VersionCode, amendmentId: string, hash?: string): string;
  rcw(cite: string): string;                // https://app.leg.wa.gov/RCW/default.aspx?cite=…
  source(url: string): string;              // pass-through to lawfilesext
}
```

`BillViewer` composes the other three and owns the state; each is also usable alone. A Web Component wrapper (`<wa-bill-viewer>`) takes the same props as attributes/properties and dispatches the same events as `CustomEvent`s, for hosts that are not React.

### Bill Service endpoints

All responses are JSON, `Cache-Control: public, max-age=…, immutable` when the URL names a version or amendment id (they never change once published), `no-cache` otherwise.

| Method and path | Returns |
|---|---|
| `GET /bills/{biennium}/{id}` | Bill summary: `bill`, `versions[]` (with `amendmentIds`), `currentVersion`, `rcwAffected` of the current version. |
| `GET /bills/{biennium}/{id}/versions/{code}` | The Bill Document for that version. `code=current` resolves to the newest and answers with `version.isCurrent` and a `Location`-style `resolvedCode` field, not a redirect. |
| `GET /bills/{biennium}/{id}/versions/{code}/sections/{sectionId}` | One section, same shape as `sections[]`, for the hover preview of a bill-section cite. |
| `GET /bills/{biennium}/{id}/diff?from={code}&to={code}&mode=as-printed\|effect` | `VersionDiff`. Both codes are required. A striking amendment id is accepted in `to` (`to=amend:{amendmentId}`). |
| `GET /bills/{biennium}/{id}/amendments` | List: id, kind, scope, chamber, sponsor, status, date, `baseVersion`. |
| `GET /bills/{biennium}/{id}/amendments/{amendmentId}` | The Amendment Document, with `instructions[].resolved` filled when the service could resolve them. |
| `GET /bills/{biennium}/{id}/versions/{code}/lines` | The line map: `[{page, line, sectionId, blockId, charStart}]`. Optional; the viewer uses `blocks[].lines` when present. |
| `GET /rcw/{cite}` | Optional proxy for a hover preview of an RCW section; not in the first slice. |
| `GET /bills/{biennium}/{id}/search?q=` | Optional; find-in-bill is client-side over the loaded document. |

Amendment ids contain spaces (`2402-S AMH FIN H2567.1`); they are percent-encoded in paths and the service also accepts the form with spaces replaced by `_`.

### URL scheme and anchors

| URL | Meaning |
|---|---|
| `/bills/2025-26/HB2402` | Redirects (307) to the current version. |
| `/bills/2025-26/HB2402/S` | Substitute, top. |
| `/bills/2025-26/HB2402/S#sec-3` | Section 3 of the Substitute. |
| `/bills/2025-26/HB2402/S#sec-1.1.a` | Section 1, subsection (1)(a). |
| `/bills/2025-26/HB2402/S#p1l18` | Printed page 1, line 18 (resolves through the line map). |
| `/bills/2025-26/HB2402/compare?from=I&to=S&at=sec-1` | Compare view, focused on section 1. |
| `/bills/2025-26/HB2402/S/amendments/2402-S%20AMH%20FIN%20H2567.1#sec-3` | Substitute with the amendment overlaid, at section 3. |
| `/bills/2025-26/HB2402/S?density=compact&lines=1` | Display state in the query so it can be shared; the viewer also keeps it in `localStorage`. |

A fiscal note cites `Section 3 of SHB 2402` and links `/bills/2025-26/HB2402/S#sec-3`. The version is in the link, so the citation stays true after the bill is engrossed. The host page updates the fragment from `onNavigate` with `history.replaceState`, never `pushState`, so scrolling does not fill the back stack.

---

## 6. Diff and amendment overlay

### Version-to-version compare

Three levels, all deterministic:

1. **Section alignment.** Match sections by `identity`. Unmatched sections on both sides are paired by plain-text similarity (Jaccard over word shingles; pair above 0.6) and marked `renumbered` when the numbers differ. The rest are `added` or `removed`. A section whose `textHash` matches on both sides is `equal` and is not diffed.
2. **Block alignment** inside a changed section, then **word-level spans**: the `frontend/src/lib/diffdoc.ts` algorithm ported as is. Each block yields one reading line (`{depth, kind, text, owner: blockId}`); distinct lines are encoded as single characters and aligned with `diff-match-patch` (`Diff_Timeout = 0`); a deleted line followed by an inserted line is paired into one `changed` line when the surviving share is ≥ 0.4; inside a pair, tokens (`/\s+|\S+/`) are encoded and diffed so a changed figure reads as one figure struck and one inserted.
3. **Modes.**
   - `as-printed` (default). The token carries its bill mark: `("food", "del")` and `("food", "text")` are different tokens, so a word that moved from plain to struck between versions shows as a change. Spans keep `billMark` so the compare view can render the printed underline or parentheses inside a diff wash.
   - `effect`. Each version is first reduced to the law it would produce: `del` runs dropped, `ins` runs kept as plain text, then diffed. This answers "how does the resulting statute differ between versions" and is the view a fiscal analyst usually wants for an amendatory section.

Library: `diff-match-patch` (MIT, the same package on both sides of uscode-redesign). Alternatives considered: `jsdiff` (`diffWords`) has no timeout-free guarantee and no line-mode trick; a structural XML diff is unnecessary since the input is already a block tree. The diff is computed in the Bill Service so both the viewer and the API consumers get one answer; the viewer holds a copy of the algorithm for the local case (comparing two loaded documents without a round trip), and a test asserts the two produce identical output on a fixture set.

Rendering follows `diffLinesHtml`: one `<p class="diff-line diff-line--changed" style="--depth:n">` per line, `<ins>`/`<del>` spans for the diff, a gutter bar and glyph per line, `id` on the first line of the focused section, note-kind lines muted. The summary line reads "N lines changed, N added, N removed" per section and for the whole bill, and "No changes" with the `textHash` equality stated when the reading text is identical.

### Striking amendments

A striking amendment replaces everything after the enacting clause, so it is parsed with the bill parser into `body.sections[]` and treated as a version: `GET …/diff?from=S&to=amend:{id}` aligns its sections against the base version by `identity`. The viewer shows it through `VersionCompare` with the from/to labels "Substitute" and the amendment id, and the toolbar's version switcher lists adopted striking amendments under the version they amend. Once adopted and engrossed, the resulting `S.E` version is its own document and the amendment stays available as history.

### Page-and-line amendments

An instruction names a page, a line, an anchor word and the text to strike and insert. Resolution runs in the service and produces `instructions[].resolved`:

1. **Line map.** The parser records `blocks[].lines` from the HTM (WA bill HTM files carry the printed page and line numbers in the margin; the PDF has the same numbering and is the fallback via text extraction with `pdfplumber` or `pdf.js`, keeping each line's y-position). The map is `(page, line) → (blockId, charStart)`; a block can span lines, so the map holds the offset at each line start.
2. **Locate.** From `(page, line)` take the block and the character offset of that line's start; search forward for `anchorText` within the line (and the next line, since a line break can fall inside the quoted phrase); then match `strikeText` immediately after the anchor. Confidence is `exact` when both match on the named line, `line-only` when the line exists but the anchor or strike text does not match, `text-only` when the text is found elsewhere in the section, `unresolved` otherwise.
3. **Apply.** Produce an overlaid document: the base runs are split at the resolved offsets and the affected range is wrapped in a run with `t: "del"` tagged `layer: "amendment"`, followed by a run `t: "ins"`, `layer: "amendment"`, carrying the inserted text (which may itself contain the bill's own underline and parentheses marks, parsed as nested `ins`/`del`). `strike-section` marks a whole section; `insert-section` inserts a parsed section after the named one; `renumber` and `correct-internal-references` are applied as annotations only, since the service does not attempt to rewrite cross references. Title amendments apply to `header.title`.
4. **Render.** `AmendmentOverlay` renders the overlaid document with the second mark set, a footnote under each affected block naming the instruction, and a list of unresolved instructions at the top of the column with their printed text and, when the line exists, a jump to it. Instructions are never silently dropped; the count "N of M applied" is always visible.
5. **Cite.** A cite emitted while an overlay is active carries `amendmentId`, so a note can say "Section 3 of SHB 2402 as amended by H2567.1".

An engrossed version already incorporates adopted amendments, so the overlay is for reading a pending or just-adopted amendment before the next version is published, and for reading a failed amendment the note was asked to cost.

---

## 7. Risks and the proof-of-concept slice

### Risks

1. **Parsing fidelity of WA HTM.** Strikethrough and underline in the HTM are presentational (`<s>`, `<u>`, or styled spans); nested and split marks across line breaks and page breaks, and marks on designators, will need a test corpus. The parser is the one place that knows the markup and should ship with a hash-checked fixture set and a round-trip check (JSON → plain text equals HTM plain text).
2. **Line numbers.** If the HTM does not carry printed line numbers reliably, the line map must come from the PDF, and PDF line extraction is the least stable part of the pipeline. Without a line map, page-and-line overlays degrade to `text-only` resolution.
3. **Section identity across versions.** Substitutes renumber and reorder; a section that changes its target cite (rare) or a new section that moves chapters will mis-align. The similarity fallback and the `renumbered` status limit the damage but the outline must make alignment visible.
4. **Amendment instruction grammar.** The instruction language is regular in practice but has variants ("beginning on line 12, strike all material through line 18", "reletter the remaining subsections"). The grammar should be a test-driven parser with an `unresolved` path that keeps the printed text.
5. **Two mark sets on one surface.** The bill's `((…))`/underline, the version diff, and the amendment overlay can all appear on the same words. The design keeps them distinct by decoration, wash and gutter, and only ever shows two layers at once (bill + diff, or bill + overlay), never three.
6. **Selection ranges across runs.** Character offsets are computed over a block's plain text; the viewer must map DOM selections back to that text across `<ins>`, `<del>`, `<a>` and the hidden prefix/suffix spans.
7. **Host integration.** The keyboard map must not steal keys from the editor; scoping to the focused pane and refusing all modifier combinations handles it, and the editor host owns `⌘K`-style global keys.
8. **Source availability.** `lawfilesext.leg.wa.gov` has no versioned API; the service must record `sourceHash` and `fetchedAt` and re-check, and the viewer shows `provenance.fetchedAt` and warnings.
9. **Accessibility of the marks.** Screen readers do not announce `<ins>`/`<del>` by default; the hidden prefix/suffix approach doubles the spoken length of heavily amended sections. The toggle mitigates it; it needs testing with NVDA and VoiceOver.

### Minimal viable slice

1. **Parser** for WA bill HTM → Bill Document JSON: header, sections, kind, target cite, block tree, `ins`/`del`/`cite` runs, `textHash`, `identity`. Fixture corpus of 20 bills across kinds (amendatory, new chapter, repealer, appropriations with tables) with hash-checked expected output. Line numbers if the HTM carries them; otherwise deferred.
2. **Bill Service**: `GET /bills/{biennium}/{id}`, `GET …/versions/{code}`, `GET …/diff?from&to&mode=as-printed`. In-memory or file cache; no database required for the slice.
3. **`<BillViewer>`** with toolbar (version switcher, collapse), sticky section bar, outline with RCW-affected list, reading column with the ladder and the printed-bill marks, deep links, `onCite` on selection and section, `annotations` markers, keyboard map, light/dark tokens, print stylesheet.
4. **`<VersionCompare>`** in `as-printed` mode using the ported `diffdoc` algorithm.
5. **Host page** at `/bills/{biennium}/{id}/{code}` with the two-pane splitter and a stub right pane that appends emitted citations to a list.
6. **Tests**: parser fixtures; diff fixtures asserting service and client agree; Playwright + axe at four widths in both themes; a design page rendering every component with fixture data and no network.

Deferred to the next slice: amendment overlay (page-and-line resolution and rendering), striking-amendment-as-version, `effect` diff mode, RCW hover preview, find-in-bill, Web Component wrapper, XML source ingestion if the Legislature publishes it.
