# DOR fiscal note templates

Twelve HTML fragments for the fiscal note drafting editor, one JSON manifest, and this schema description. Each fragment is the document body of a Department of Revenue fiscal note (OFM form FNS062) for one analysis type. Section order, headings, table layouts, form instruction text, and narrative phrasing are taken from published 2025-26 DOR notes; the research behind them is in `../research/fiscal-notes.md`.

## Files

| File | Template id | Analysis type |
|---|---|---|
| 01-no-fiscal-impact.html | no-fiscal-impact | No receipts, no expenditures |
| 02-indeterminate-impact.html | indeterminate-impact | Non-zero but indeterminate receipts |
| 03-bo-rate-change.html | bo-rate-change | B&O rate or classification change, with Ten-Year Analysis |
| 04-sales-use-tax-exemption.html | sales-use-tax-exemption | New sales/use tax preference with local impact |
| 05-property-tax-exemption-levy.html | property-tax-exemption-levy | Property tax exemption or levy change, shift vs. loss, CY detail |
| 06-reet-exemption.html | reet-exemption | Real estate excise tax change across three accounts |
| 07-local-sales-tax-authority.html | local-sales-tax-authority | Local sales tax credited against the state rate |
| 08-tax-credit-with-cap.html | tax-credit-with-cap | Credit with a per-business cap and application process |
| 09-admin-cost-only.html | admin-cost-only | Expenditures only, no revenue |
| 10-tax-preference-repeal.html | tax-preference-repeal | Repeal or narrowing of a preference, with Ten-Year Analysis |
| 11-fee-increase.html | fee-increase | Fee imposition or increase, with Ten-Year Analysis |
| 12-revised-substitute-note.html | revised-substitute-note | Revision of a prior note or note on a substitute/engrossed/passed version |
| manifest.json | | Index of templates with tags, parts, tables, slots, and tokens |

## Document structure

Every template is one `<article class="fiscal-note" data-template="…" data-form="FNS062" data-agency-code="140">` containing, in order:

| Element | `data-part` | Content |
|---|---|---|
| `<header>` | header | Bill Number, Title, Agency (read-only, from the request) |
| `<section>` | I | Part I: Estimates. No Fiscal Impact checkbox; cash receipts table or NONE/indeterminate sentence; expenditures table or NONE; capital NONE; the two fixed instruction sentences; four impact checkboxes; signature block |
| `<section>` | II.A | Brief Description: optional `Note:`; optional COMPARISON heading; CURRENT LAW; PROPOSAL; optional tax preference sentence; EFFECTIVE DATE |
| `<section>` | II.B | Cash receipts: ASSUMPTIONS list; DATA SOURCES list; REVENUE ESTIMATES; optional PROPERTY TAX SHIFTS; TOTAL REVENUE IMPACT (state and local six-year series); optional calendar-year detail |
| `<section>` | II.C | Expenditures: ASSUMPTIONS; FIRST YEAR COSTS; SECOND YEAR COSTS; optional extra years; ONGOING COSTS |
| `<section>` | III | III.A expenditures by object; III.B FTE by job classification; III.C by program (NONE) |
| `<section>` | IV | Capital budget impact (NONE) |
| `<section>` | V | New rule making |
| `<section>` | 10YR | Ten-Year Analysis (form FNS066), present only on templates for tax or fee increases; `data-condition="request.tenYearRequested"` |

Headings: `h1` form title, `h2` Part titles, `h3` lettered subsections (II. A, III. B), `h4` the uppercase run-in headings DOR uses inside the narrative (CURRENT LAW:, ASSUMPTIONS:, FIRST YEAR COSTS:).

Form text that FNS prints on every note is marked `<p class="form-instruction" data-locked="true">`. The editor renders it but does not allow edits.

## Tokens

`{{path}}` tokens are replaced with values from the note's data model when the template is instantiated. They also appear inside slots as default text so that the analyst sees which value goes where.

| Token | Source | Example |
|---|---|---|
| `bill.number` | request | `1993 HB`, `2081 E S HB PL` |
| `bill.numberOnly`, `bill.version` | request | `2020`, `SHB` |
| `bill.title` | request | `Child care providers/B&O tax` |
| `bill.effectiveDate`, `bill.effectiveSection`, `bill.prefExemptSection` | bill analysis | `January 1, 2026`, `17`, `2` |
| `agency.code`, `agency.name` | constant | `140`, `Department of Revenue` |
| `request.date`, `legContact.name`, `legContact.phone` | FNS request | |
| `preparer.*`, `approver.*`, `ofm.*` | workflow | name, phone, date, datetime |
| `session.year` | session | `2025` |
| `fy.1` … `fy.6` | session | `FY 2026` … `FY 2031`; `fy.N.year` gives `2026`; `fy.N.yy` gives `26`; `fy.7`–`fy.10` used by the ten-year table |
| `bien.1` … `bien.3` | session | `2025-27`, `2027-29`, `2029-31` |
| `cy.1` … `cy.6` | session | `CY 2026` … (property tax detail) |
| `impl.date`, `impl.leadMonths` | analyst | implementation date when later than the effective date |
| `impact.months.state`, `impact.months.local` | computed from effective/implementation date and lag rule | `five`, `four` |
| `impact.state.fyN`, `impact.local.fyN` | computed / entered, thousands | |
| `impact.state.fyN.millions` | formatted | `$4.3 million` |
| `ref.forecast.vintage` | reference | `November 2024` |
| `ref.localRate`, `ref.aprilShare`, `ref.octoberShare` | reference | `3.0`, `52.62`, `47.38` |
| `ref.salary.<CLASS>` | reference table per session | `59,844` |
| `ref.cpi.*`, `ref.tes.year`, `ref.priorYear`, `ref.priorFY` | reference | |
| `prior.*` | the note this one was created from (template 12) | `prior.requestId` = `2227-1` |
| Everything else (`receipts.*`, `credit.*`, `fee.*`, `pref.*`, `rules[n].*`, `narrative.*`) | analyst input | |

The manifest lists every token each template uses.

## Slots

`data-slot="path"` marks an editable region bound to `path` in the data model. Attributes:

| Attribute | Meaning |
|---|---|
| `data-type` | `text` (single line), `multiline` (paragraphs and dash lists only), `list` (a `<ul>` whose `<li>` items are the values), `money` (whole dollars, negatives in parentheses), `money-thousands`, `fte` (one decimal; `data-precision="2"` for the first-year sentence), `int`, `pct`, `account`, `revenue-source`, `job-class`, `wac`, `account-3char` |
| `data-picklist` | name of a phrase list the editor offers for this slot (see Picklists) |
| `data-lookup` | reference table for validation and autocomplete: `ofm-fund-reference`, `saam-75.80`, `dor-job-classes`, `wac-458` |
| `data-optional="true"` | omitted from output when empty |
| `data-readonly="true"` / `data-source="request|workflow|ofm"` | filled by the system, not the analyst |
| `data-hint` | guidance shown in the editor, not printed |
| `data-flag` | a slot whose presence sets a boolean (the indeterminate receipts sentence sets `flags.indeterminateReceipts`) |

`data-computed="expr"` marks a cell or span the editor fills from other values and does not allow editing. Expressions used: `sum(a,b)`, `sum(receipts.*.fy1)` (wildcard over rows), `avg(a,b)` (FTE biennium columns), `millions(x)`, `thousands(x)`, `direction(x)`, `concat(...)`, `nonempty(x)`, `not(x)`, and a bare path to echo a value.

`data-repeat="path"` marks a container whose children repeat per array element (`fteClass`, `tenYear`, `narrative.expenditures.extraYears`).

`data-source="prior.…"` (template 12) marks content copied from the prior note version; the editor should show it as carried forward and offer a diff against the prior text.

## Tables

| `data-role` | Where | Rows | Columns | Validation |
|---|---|---|---|---|
| `header-fields` | header | fixed | | |
| `cash-receipts` | Part I | one per account/source (`data-key`: `gf`, `pag`, `weia`, `elta`, `pwaa`, `new`) | fy1, fy2, bien1, bien2, bien3 | bien columns computed from the six-year series; Total row computed |
| `expenditures-by-account` | Part I | FTE Staff Years row, then accounts | same | Total computed; FTE row computed from `fte-by-class` |
| `impact-flags` | Part I | four checkboxes | | `over50k`, `capital`, `ruleMaking` computed |
| `signature-block` | Part I | four signers | name, phone, date | filled by workflow |
| `impact-series` | II.B | six fiscal years (`data-scope`: `impact.state`, `impact.local`, `cyImpact.*`, `cyShift.*`) | one value in thousands | state series computed as sum of receipts rows / 1000 |
| `total-revenue-impact` | II.B | container for the two series | | |
| `property-tax-cy-detail` | II.B | four series on a calendar-year basis | | |
| `expenditures-by-object` | III.A | A, B, C, E, G, J | same five columns | every column total equals `expenditures-by-account`; `data-validate="totals-equal(expenditures-by-account)"` |
| `fte-by-class` | III.B | one per job classification (`fteClass[i]`) with Salary | same five columns | Total FTEs equals the Part I FTE row |
| `ten-year-flags` | 10YR | three checkboxes | | exactly one of table / No Cash Receipts / Indeterminate required |
| `ten-year-analysis` | 10YR | one per tax or fee title and account code | fy1 … fy10, total | first six years equal the increase portion of the fiscal note series; Total and Biennial Totals computed |

Account keys map to: `gf` GF-STATE-State 001-1; `pag` Performance Audits of Government Account-State; `weia` Workforce Education Investment Account-State (24J in ten-year tables); `elta` Education Legacy Trust Account-State; `pwaa` Public Works Assistance Account-State; `new` a new account (`NEW`, `N01`, …). Revenue source lines used: `01 - Taxes  01 - Retail Sales Tax`, `05 - Bus and Occup Tax`, `50 - Property Tax`, `55 - Inheritance Tax`, `57 - Real Estate Excise`.

The data model stores six fiscal-year values per row (`fy1`–`fy6`). Part I shows fy1, fy2, and the three biennium sums; the narrative series shows all six; the ten-year table extends to fy10.

## Shared boilerplate blocks

These blocks are identical across templates and can be maintained as partials:

- **Header** (`data-part="header"`): form title and the three request fields.
- **Part I frame**: the No Fiscal Impact checkbox, the "most likely fiscal impact" sentence, the four checkbox lines, and the signature block. Only the receipts and expenditures bodies vary (table, `NONE`, or the indeterminate sentence).
- **Part II instruction paragraphs**: the italic text under II.A, II.B, II.C (locked).
- **Assumptions list** (`narrative.receipts.assumptions`): a `<ul data-type="list">` seeded from the `receipt-assumptions` picklist.
- **Data sources list** (`narrative.receipts.dataSources`): first item is always a DOR dataset, second the ERFC forecast vintage.
- **Revenue estimate sentence**: "This bill decreases state revenues by an estimated $X in the N months of impacted collections in fiscal year YYYY, and by $Y in fiscal year YYYY+1, the first full year of impacted collections." with the local variant appended when `impact.local` is non-zero.
- **Total revenue impact**: two `impact-series` tables (state computed, local entered), or `None.` / `Indeterminate` text.
- **Cost year block**: "The department will incur total costs of $X in fiscal year YYYY. These costs include:" / "Labor Costs – Time and effort equate to N FTEs." / activities list / "Object Costs - $X." / objects list. Repeated for FIRST, SECOND, and optional THIRD/FOURTH year.
- **Ongoing costs sentence**: from the `ongoing-cost-sentences` picklist.
- **Part III tables**: `expenditures-by-object` and `fte-by-class` with the standard DOR job classification rows.
- **Part IV**: NONE.
- **Part V sentence**: "Should this legislation become law, the department will use the expedited process to amend WAC 458-xx-xxx, titled: "…." This rulemaking would affect …."
- **Ten-Year Analysis frame**: header, locked sentence, three checkboxes, table, narrative (computed as a copy of II.A and II.B), signature line.

## Picklists

Phrase lists referenced by `data-picklist`. Values below are the ones observed in the 2025-26 notes.

- `effective-date-sentences`: "The bill takes effect 90 days after the final adjournment of the session."; "This bill takes effect on {{bill.effectiveDate}}."; "This bill takes effect beginning with property taxes due for calendar year {{fy.1.year}}."; the 90-day sentence plus "However, due to the time it will take to program this bill's changes, the Department of Revenue (department) cannot implement the bill until {{impl.date}}."
- `tax-preference-statements`: "The new tax preference performance provisions do not apply to this bill (see section N of the bill)."; "This exemption expires {{pref.expirationDate}}."; "The tax preference performance statement in section N categorizes the preference as one intended to … (RCW 82.32.808(2)(x))."
- `no-revenue-sentences`: "This legislation has no revenue impact."; "This legislation results in no revenue impact on taxes administered by the department."; "This bill results in no revenue impact on taxes administered by the department."; "This legislation has no revenue impact on taxes or licenses administered by the Department of Revenue (department)."
- `receipt-assumptions`: sales tax lag (one month state, two months local); statewide average local rate 3.0%; ERFC forecast growth; Performance Audits of Government Account 0.16% share; tribal compact share may decrease / may increase / does not change; effective-date proration sentence; state levy below the $3.60 limit; April/October collection split; compliance rates; "The data needed to calculate such impact is unavailable."
- `data-sources`: "Department of Revenue, Excise tax data"; "Economic and Revenue Forecast Council, {{ref.forecast.vintage}} forecast"; "S&P Global Market Intelligence, {{ref.forecast.vintage}} forecast"; "County assessor data"; "Department of Revenue, State Property Tax Model"; "Bureau of Labor Statistics, CPI for all urban consumers"; "Department of Revenue, {{ref.tes.year}} Tax Exemption Study".
- `expenditure-activities` and `expenditure-objects`: the activity and object-cost sentences listed in section 3 of the research report.
- `ongoing-cost-sentences`: "Ongoing costs for the {{bien.2}} biennium equal $X and include similar activities described in the second-year costs. Time and effort equate to N FTE per year."; "There are no ongoing costs."; "The department will not incur ongoing costs."; "The department will not incur any costs for the {{bien.2}} biennium."
- `no-cost-sentences`: "The department will not incur any costs with the implementation of this legislation."; the absorb-within-current-funding sentence.
- `property-tax-shift-sentences`, `property-tax-revenue-sentences`: "This legislation results in no revenue impact to the state property tax levy."; "A new exemption results in a shift and no loss to the state levy."; "This legislation results in no state or local property tax levy shifts."
- `version-note-sentences`, `comparison-headings`: "Note: This fiscal note reflects language in SHB 2020, 2025 Legislative Session."; "Note: This fiscal note reflects language in ESHB 2081 as passed in the 2025 Legislative Session."; "Note: This fiscal note reflects a revision to the expenditures and replaces fiscal note number 2227-1."; "COMPARISON OF SUBSTITUTE BILL WITH ORIGINAL BILL:"; "COMPARISON OF THE ENGROSSED BILL WITH THE ORIGINAL BILL:".

## Editor constraints (fiscal notes)

The fiscal note editor is the "limited editor" of requirement B.RFA.10. Inside `data-type="multiline"` slots it allows paragraphs, dash lists (`<ul>`), and inline emphasis; it does not allow tables, fonts, colors, images, or heading changes. Locked instruction text, computed cells, and read-only request fields are not editable. Section order is fixed; optional sections can be hidden but not reordered. Fiscal estimates reuse the same fragments in the rich text editor (B.RFA.09) with those restrictions lifted.

## Output

The same fragment feeds three exporters: PDF (matching the FNS layout), Word, and the FNS transmission payload. Only the slot values and table cells are transmitted; locked text is regenerated by FNS. The FNS payload schema is not public; the slot paths in `manifest.json` are the mapping surface.
