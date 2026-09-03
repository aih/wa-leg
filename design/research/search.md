# Search module

Scope: text search over bills, bill text, amendments, fiscal notes, RCW sections, and templates, plus a bill-reference parser that turns any written form of a bill citation into a canonical id and a bill-viewer URL. Backend: OpenSearch. Data source for the POC: the Legiscan JSON dataset for the 2025-2026 Regular Session (3,413 bills, 6,429 texts, 4,127 amendments, 5,761 fiscal-note supplements, 11,123 bill-report supplements).

Requirement traceability: B.COM.09 (robust search), B.COM.05 (link every version to the bill), B.COM.37 (research historical notes), B.COM.43 (bill history across the biennium), TR-105 (portable services), TR-305 (RBAC), TR-601 (versioned REST), TR-1104-1108 (latency).

## 1. Summary

The module has three parts.

1. `@wa-leg/billref`: a pure TypeScript package that parses bill references, RCW cites, session-law cites, amendment ids, fiscal-note package ids, and initiative numbers. It has no I/O. The search box, the URL router (`/bills/:ref`), the ingester, and the API all use it.
2. The OpenSearch indices: `bills`, `bill_sections`, `amendments`, `fiscal_notes`, `rcw_sections`, `templates`, joined under a read alias `search_all`. Every document carries `doc_type`, `bill_key`, `biennium`, `visibility`, `allowed_roles`, and `allowed_user_ids`, so one query with one permission filter runs across all of them.
3. The query pipeline in the API: parse the query; if it is a complete reference, resolve it against the index and return a direct hit with related documents; otherwise run a boosted `multi_match` with filters, facets, and highlights. Permission filters are added server-side from the caller's session and are never accepted from the client.

The ingester reads Legiscan bill JSON, derives version codes from the `state_link` filenames, fetches the HTM text from lawfilesext.leg.wa.gov, uses the bill viewer's Bill Document JSON parser to split text into sections, and bulk-indexes. Re-indexing is driven by Legiscan `change_hash` (bill), `text_hash` (version), and `supplement_hash` (fiscal note).

A Postgres full-text implementation of the same `SearchBackend` interface is the fallback when OpenSearch is unavailable.

## 2. Bill reference grammar

### 2.1 Facts from the data

| Fact | Value |
|---|---|
| Bill types and observed number ranges (2025-26) | HB 1000-3992, HJM 4000-4017, HJR 4200-4213, HCR 4400-4409, HR 4600-4715, SB 5000-7991, SJM 8000-8016, SJR 8200-8212, SCR 8400-8410, SR 8600-8705 |
| Legiscan text types | Introduced (3,440), Comm Sub (1,254), Engrossed (335), Enrolled (710), Chaptered (690) |
| lawfilesext filename suffixes | `` (introduced), `-S`, `-S2`, `-S3` (substitutes), `.E`, `.E2` (engrossed), `-S.E`, `-S2.E`, `-S.E2`, `-S3.E`, `.PL`, `-S.PL`, `-S2.PL`, `-S3.PL` (passed legislature), `.SL`, `-S.SL`, `-S2.SL`, `-S3.SL` (session law) |
| Resolution and memorial filenames | Number, optional version suffix, then `-` and a short title: `4600-Apple blossom festival.pdf`, `4600-S-Martin Luther King, Jr. Way.pdf`, `4600.PL-Medal of Honor Bridge.pdf`, `4691-.pdf` (empty title) |
| Enrolled and chaptered filenames | Drop the engrossed marker: ESHB 1941 enrolled is `1941-S.PL` |
| Text directories | `Pdf/Bills/House Bills`, `Senate Bills`, `House Resolutions`, `Senate Joint Memorials`, ... `House Passed Legislature`, `Session Laws/House` |
| HTM text | Same path with `Pdf` → `Htm` and `.pdf` → `.htm`; verified for bills, passed-legislature, session-law, and amendment files |
| Amendment description | `Cortes 6137 AMS CORA S4812.1`, `Transportation 5127-S AMH TR H2208.1`, `Griffey 5127-S AMH GRIF MYES 031`, ` 5127-S AMH ENGR H2208.E`, ` 5998-S.E AMC CONF H3823.1`; the `-S`/`.E` after the number is the version amended; `AMH`/`AMS`/`AMC` is House, Senate, or conference committee |
| Amendment HTM header | `SB 6137 - S AMD 579 By Senator Cortes WITHDRAWN 02/11/2026` (floor amendment number, sponsor, disposition) |
| Fiscal note description | `2402 HB (Final)`, `2402 HB (Revised)`, `6137 SB (Partial)`, `6137 SB  AMH SGOV H3681.1 (Partial)`, `1234 2SHB (Final)`, and free-form variants in 331 of 5,761: `5633 PSSB S-3966.1/26 (Partial)` (proposed substitute by draft number), `5520 SSB .PL (Partial)`, `2438 SHB 2438_PSHB_H-3363.2 (Partial)`, `5520 B (Partial)`; link `fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=75952` |
| Session law | History action `Chapter 246, 2026 Laws.` or `Chapter 11, 2025 Laws PV.` |
| Companion bills | `sasts[].type = "Crossfiled"` with `sast_bill_number` |

### 2.2 Canonical id

```
BillKey      = "WA:" biennium ":" type number            e.g. WA:2025-26:HB1234
VersionKey   = BillKey ":" version_code                  e.g. WA:2025-26:HB1234:S.E
AmendmentKey = BillKey ":AMD:" chamber ":" drafter_no    e.g. WA:2025-26:SB6137:AMD:S:S4812.1
```

```ts
interface BillRef {
  kind: 'bill';
  biennium: string;          // "2025-26"; odd start year, two-digit end
  bienniumExplicit: boolean; // false when defaulted to the current biennium
  chamber: 'H' | 'S';
  type: 'HB'|'SB'|'HJR'|'SJR'|'HJM'|'SJM'|'HCR'|'SCR'|'HR'|'SR';
  number: number;            // 1..9999
  versionCode: string;       // see 2.3
  versionExplicit: boolean;
  amendment?: AmendmentRef;
  confidence: 'exact' | 'inferred';  // inferred when the type came from the number range
  warnings: string[];
}
```

### 2.3 Version code scheme

The version code is the lawfilesext filename suffix without its leading hyphen. It is the string that, combined with the number, names the file.

| Code | Meaning | Filename | Label |
|---|---|---|---|
| `` | introduced | `1234.pdf` | HB 1234 |
| `S` | first substitute | `1234-S.pdf` | SHB 1234 |
| `S2` | second substitute | `1234-S2.pdf` | 2SHB 1234 |
| `S3` | third substitute | `1234-S3.pdf` | 3SHB 1234 |
| `E` | engrossed | `1234.E.pdf` | EHB 1234 |
| `E2` | second engrossed | `1234.E2.pdf` | 2EHB 1234 |
| `S.E` | engrossed substitute | `1234-S.E.pdf` | ESHB 1234 |
| `S2.E` | engrossed second substitute | `1234-S2.E.pdf` | E2SHB 1234 |
| `S.E2` | second engrossed substitute | `1234-S.E2.pdf` | 2ESHB 1234 |
| `S3.E` | engrossed third substitute | `1234-S3.E.pdf` | E3SHB 1234 |
| `PL` | passed legislature (enrolled) | `1234.PL.pdf` | HB 1234 (PL) |
| `S.PL` | enrolled, substitute lineage | `1234-S.PL.pdf` | SHB 1234 (PL) or ESHB 1234 (PL) |
| `SL` | session law (chaptered) | `1234.SL.pdf` | HB 1234 (SL), ch. 246, Laws of 2026 |
| `S2.SL` | session law, second substitute | `1234-S2.SL.pdf` | 2SHB 1234 (SL) |

Structure: `[S<n>][.<E<n>|PL|SL>]`. The substitute level and the engrossed level are independent counters. `PL` and `SL` replace the engrossed marker in the filename; the label for a `PL` or `SL` version takes its engrossed level from the highest engrossed version that precedes it in the bill's version list (ESHB 1941 enrolled is file `1941-S.PL` and label "ESHB 1941 (PL)"). The label for a Senate type substitutes `SB`, `SJR`, and so on. Legiscan text type is not needed once the suffix is known; the mapping is: Introduced → `` , Comm Sub → `S<n>`, Engrossed → `[S<n>.]E<n>`, Enrolled → `[S<n>.]PL`, Chaptered → `[S<n>.]SL`.

Label prefix rules: `E` count first, then `S` count. `E2SHB` is engrossed second substitute (`S2.E`); `2ESHB` is second engrossed substitute (`S.E2`); `E3SSB` is `S3.E`; `3ESSB` is `S.E3`.

### 2.4 Grammar

Input is uppercased and whitespace-collapsed before matching. EBNF, with regex leaves:

```
reference      = session_law | rcw | fn_package | initiative | amendment_only | bill ;

bill           = [ biennium , ws ] , [ eng ] , [ sub ] , [ type ] , sep , number , [ lawfiles_suffix ]
                 , [ ws , biennium_tail ] , [ ws , amendment ] ;
eng            = [ "2" | "3" ] , "E" ;                       (* ENGROSSED, SECOND ENGROSSED *)
sub            = [ "2" | "3" ] , "S" ;                       (* SUBSTITUTE, SECOND SUBSTITUTE *)
type           = "HB" | "SB" | "HJR" | "SJR" | "HJM" | "SJM" | "HCR" | "SCR" | "HR" | "SR" ;
sep            = { ws | "-" } ;
number         = digit , { digit } ;                          (* 1-4 digits; 5+ digits is not a bill *)
lawfiles_suffix= [ "-S" , [ "2" | "3" ] ] , [ "." , ( "E" , [ "2" | "3" ] | "PL" | "SL" ) ] ;
biennium       = year , [ "-" , ( year | digit digit ) ] ;
biennium_tail  = [ "(" ] , biennium , [ ws , ("REGULAR" | "SPECIAL") , ws , "SESSION" ] , [ ")" ] ;
year           = "19" digit digit | "20" digit digit ;

amendment      = [ "AS AMENDED BY" , ws ] , ( ( "AMENDMENT" | "AMD" ) , [ ws , "NO." ] | "AM" am_chamber , [ ws , code ] ) , ws , amendment_id
               | [ "AS AMENDED BY" , ws ] , drafter_no ;
am_chamber     = "H" | "S" | "C" ;                            (* House, Senate, conference committee *)
amendment_id   = drafter_no | [ initials , ws ] , amd_no ;
drafter_no     = ( "H" | "S" ) , [ "-" ] , digit digit digit digit , "." , ( digits | "E" ) ;   (* S4812.1, H2208.E *)
amd_no         = digit , { digit } ;                          (* floor amendment number: 579, 031 *)
initials       = letter , letter , letter , [ letter ] , [ letter ] ;   (* LEWI, MYES *)
code           = { letter | "&" } ;                           (* CORA, SGOV, TR *)
amendment_only = [ number , [ lawfiles_suffix ] , ws ] , "AM" am_chamber , ws , code , ws , amendment_id
               | drafter_no ;

session_law    = ( "CH" | "CHAPTER" ) , [ "." ] , ws , digits , [ "," ] , ws , ( "LAWS OF" , ws , year | year , ws , "LAWS" ) , [ ws , "PV" ]
               | year , ws , "C" , ws , digits ;               (* 2025 c 5 *)
rcw            = [ "RCW" , ws ] , title , "." , chapter , [ "." , section ]
               | "CHAPTER" , ws , title , "." , chapter , ws , "RCW"
               | "TITLE" , ws , title , ws , "RCW" ;
title          = digit , [ digit ] , [ letter ] ;             (* 82, 70A *)
chapter        = digit , digit , [ digit ] , [ letter ] ;     (* 04, 350 *)
section        = digit , digit , digit , [ digit ] , [ letter ] ;
fn_package     = ( "PACKAGEID" , [ "=" ] | "PACKAGE" | "FN" , [ "#" ] | "FISCAL NOTE" , [ "PACKAGE" ] , [ "#" ] ) , ws , digits ;
initiative     = "I" , [ "-" ] , ws , digits ;                (* INITIATIVE [MEASURE] [NO.] 2117 → I-2117 *)
```

Word forms are rewritten to abbreviations before the grammar runs:

| Written form | Rewritten to |
|---|---|
| `H.B.`, `S.H.B.`, `E.S.H.B.` (any run of single letters or digits separated by periods) | `HB`, `SHB`, `ESHB` |
| `HOUSE BILL`, `SENATE BILL`, `HOUSE JOINT RESOLUTION`, `SENATE JOINT MEMORIAL`, `HOUSE CONCURRENT RESOLUTION`, `HOUSE RESOLUTION`, `SENATE RESOLUTION` | `HB`, `SB`, `HJR`, `SJM`, `HCR`, `HR`, `SR` |
| `SUBSTITUTE`, `FIRST SUBSTITUTE` / `SECOND SUBSTITUTE`, `2ND SUBSTITUTE` / `THIRD SUBSTITUTE` | `S` / `2S` / `3S` |
| `ENGROSSED` / `SECOND ENGROSSED` / `THIRD ENGROSSED` | `E` / `2E` / `3E` |
| `NO.`, `NUMBER` before a number | removed |
| `INITIATIVE [MEASURE] [NO.]` | `I-` |
| `&` inside a committee code (`W&M`) | kept |

### 2.5 Normalization rules

1. Biennium: a four-digit year `y` maps to the biennium starting at `y` if `y` is odd, else `y-1`; formatted `YYYY-YY`. `2025`, `2026`, `2025-26`, `2025-2026`, `25-26` all give `2025-26`. Absent → the configured current biennium, `bienniumExplicit = false`.
2. Type: from the written prefix when present. When absent, from the number: 1000-3999 HB, 4000-4199 HJM, 4200-4399 HJR, 4400-4599 HCR, 4600-4999 HR, 5000-7999 SB, 8000-8199 SJM, 8200-8399 SJR, 8400-8599 SCR, 8600-8999 SR; `confidence = 'inferred'`. Numbers below 1000 or outside every range give `type = HB` for < 5000, `SB` otherwise, with a warning.
3. Chamber: `H` for HB, HJR, HJM, HCR, HR; `S` for the rest.
4. A written type whose number falls in the other chamber's range (`SB 1234`) is kept as written with a warning. The resolver reports not-found and the UI offers the inferred alternative.
5. Version: from label prefixes (`2SHB`) or from the lawfiles suffix (`1234-S2`); when both are present the lawfiles suffix wins. Absent → `""` with `versionExplicit = false`; the resolver substitutes the bill's latest version.
6. Amendment: the drafter number is normalized to uppercase without hyphen (`S4812.1`); floor numbers to an integer (`031` → 31). Chamber from `AMH`/`AMS`/`AMC` or from the drafter number's first letter; `C` is a conference committee report.
7. Remainder: text left after the reference. A non-empty remainder means the query is not a bare reference; the search box then runs the text path with the reference as a filter/boost, and does not redirect.
8. Several references in one string (`HB 1234, SB 5678`) are returned in order by `parseAll`; `parse` returns the first and puts the rest in `remainder`.

### 2.6 Test table

Current biennium in these tests is `2025-26`. `ver` is the version code; blank means introduced with `versionExplicit=false`.

| # | Input | kind | biennium | type | number | ver | amendment | confidence / notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `HB 1234` | bill | 2025-26 | HB | 1234 | | | exact |
| 2 | `HB1234` | bill | 2025-26 | HB | 1234 | | | exact |
| 3 | `hb-1234` | bill | 2025-26 | HB | 1234 | | | exact; case-insensitive |
| 4 | `H.B. 1234` | bill | 2025-26 | HB | 1234 | | | exact |
| 5 | `House Bill 1234` | bill | 2025-26 | HB | 1234 | | | exact |
| 6 | `House Bill No. 1234` | bill | 2025-26 | HB | 1234 | | | exact |
| 7 | `1234` | bill | 2025-26 | HB | 1234 | | | inferred; range 1000-3999 |
| 8 | `5001` | bill | 2025-26 | SB | 5001 | | | inferred |
| 9 | `4602` | bill | 2025-26 | HR | 4602 | | | inferred; range 4600-4999 |
| 10 | `8201` | bill | 2025-26 | SJR | 8201 | | | inferred |
| 11 | `2025` | bill | 2025-26 | HB | 2025 | | | inferred; warning "may be a year"; text path also runs |
| 12 | `SHB 1234` | bill | 2025-26 | HB | 1234 | S | | exact |
| 13 | `2SHB1234` | bill | 2025-26 | HB | 1234 | S2 | | exact |
| 14 | `ESHB 1234` | bill | 2025-26 | HB | 1234 | S.E | | exact |
| 15 | `E2SSB 5001` | bill | 2025-26 | SB | 5001 | S2.E | | exact |
| 16 | `2ESSB 5001` | bill | 2025-26 | SB | 5001 | S.E2 | | exact |
| 17 | `E3SSB 5001` | bill | 2025-26 | SB | 5001 | S3.E | | exact |
| 18 | `Engrossed Second Substitute Senate Bill 5001` | bill | 2025-26 | SB | 5001 | S2.E | | exact |
| 19 | `Second Substitute House Bill 1234` | bill | 2025-26 | HB | 1234 | S2 | | exact |
| 20 | `S.S.B. 5001` | bill | 2025-26 | SB | 5001 | S | | exact |
| 21 | `ESHB 1234 (2025)` | bill | 2025-26 | HB | 1234 | S.E | | exact; bienniumExplicit |
| 22 | `HB 1234 2025-26` | bill | 2025-26 | HB | 1234 | | | exact; bienniumExplicit |
| 23 | `HB 1234 (2026)` | bill | 2025-26 | HB | 1234 | | | 2026 → 2025-26 |
| 24 | `HB 1234 2023-24` | bill | 2023-24 | HB | 1234 | | | exact; different bill from #1 |
| 25 | `2023 HB 1234` | bill | 2023-24 | HB | 1234 | | | leading year |
| 26 | `HB 1234 (2025 Regular Session)` | bill | 2025-26 | HB | 1234 | | | session words ignored |
| 27 | `HB 1234-S.E` | bill | 2025-26 | HB | 1234 | S.E | | lawfiles suffix |
| 28 | `1234-S2` | bill | 2025-26 | HB | 1234 | S2 | | inferred type |
| 29 | `5127-S.PL` | bill | 2025-26 | SB | 5127 | S.PL | | inferred |
| 30 | `1941.E` | bill | 2025-26 | HB | 1941 | E | | inferred |
| 31 | `1941.SL` | bill | 2025-26 | HB | 1941 | SL | | inferred |
| 32 | `SB 5001 amendment S4812.1` | bill | 2025-26 | SB | 5001 | | S4812.1 | exact |
| 33 | `SHB 1234 amendment 579` | bill | 2025-26 | HB | 1234 | S | amdNumber 579 | exact |
| 34 | `SB 5127 as amended by AMH GRIF MYES 031` | bill | 2025-26 | SB | 5127 | | H, GRIF, MYES 31 | exact |
| 35 | `6137 AMS CORA S4812.1` | bill | 2025-26 | SB | 6137 | | S4812.1 | inferred type; lawfiles amendment name |
| 36 | `5127-S AMH TR H2208.1` | bill | 2025-26 | SB | 5127 | S | H2208.1 | version from filename |
| 37 | `AMS CORA S4812.1` | amendment | 2025-26 | | | | S, CORA, S4812.1 | no bill number; resolver finds the bill by drafter number |
| 38 | `S4812.1` | amendment | 2025-26 | | | | S4812.1 | drafter number alone |
| 39 | `H-3681.1` | amendment | 2025-26 | | | | H3681.1 | hyphen removed |
| 39a | `5998-S.E AMC CONF H3823.1` | bill | 2025-26 | SB | 5998 | S.E | C, CONF, H3823.1 | conference committee report |
| 40 | `chapter 5, Laws of 2025` | session_law | | | | | | year 2025, chapter 5 |
| 41 | `Ch. 11, 2025 Laws PV` | session_law | | | | | | pv=true |
| 42 | `2025 c 5` | session_law | | | | | | RCW-history form |
| 43 | `RCW 82.04.260` | rcw | | | | | | title 82, chapter 82.04, section 82.04.260 |
| 44 | `82.04.260` | rcw | | | | | | bare cite; not a bill (period after two digits) |
| 45 | `rcw 82.04` | rcw | | | | | | chapter only |
| 46 | `chapter 70A.350 RCW` | rcw | | | | | | title 70A |
| 47 | `Title 82 RCW` | rcw | | | | | | title only |
| 48 | `packageID=75952` | fiscal_note_package | | | | | | 75952 |
| 49 | `FN 75952` | fiscal_note_package | | | | | | 75952 |
| 50 | `I-2117` | initiative | | | | | | 2117; not in Legiscan; resolver links to leg.wa.gov |
| 51 | `Initiative Measure No. 2117` | initiative | | | | | | 2117 |
| 52 | `SB 1234` | bill | 2025-26 | SB | 1234 | | | exact type kept; warning "outside Senate range" |
| 53 | `HB 12345` | null | | | | | | five digits; remainder = whole input |
| 54 | `HB` | null | | | | | | no number |
| 55 | `phthalates` | null | | | | | | free text |
| 56 | `B&O tax credit for semiconductor manufacturing` | null | | | | | | free text |
| 57 | `HB 1234 phthalates` | bill | 2025-26 | HB | 1234 | | | remainder "PHTHALATES"; no redirect; text search filtered to the bill |
| 58 | `HB 1234, SB 5678` | bill | 2025-26 | HB | 1234 | | | `parseAll` returns two; UI shows both |
| 59 | `2402 HB (Final)` | bill | 2025-26 | HB | 2402 | | | exact; fiscal-note description form; remainder "(FINAL)" |
| 61 | `1234 2SHB (Partial)` | bill | 2025-26 | HB | 1234 | S2 | | exact; remainder "(PARTIAL)" |
| 62 | `HB 1234 579` | bill | 2025-26 | HB | 1234 | | | no amendment; a bare trailing number is remainder "579" |
| 60 | `` (empty) | null | | | | | | |

### 2.7 Parser

Package `packages/billref/src/index.ts`. No imports, no I/O. The functions below are the public surface.

```ts
export type Chamber = 'H' | 'S';
export type BillType = 'HB'|'SB'|'HJR'|'SJR'|'HJM'|'SJM'|'HCR'|'SCR'|'HR'|'SR';

export interface AmendmentRef {
  kind: 'amendment';
  chamber?: Chamber | 'C';  // from AMH/AMS/AMC (C = conference committee) or the drafter number's first letter
  committeeOrSponsor?: string; // "CORA", "SGOV", "TR"
  drafterNumber?: string;   // "S4812.1", "H2208.E"
  initials?: string;        // "MYES" (House floor amendments)
  amdNumber?: number;       // 579
}
export interface BillRef {
  kind: 'bill'; biennium: string; bienniumExplicit: boolean; chamber: Chamber; type: BillType;
  number: number; versionCode: string; versionExplicit: boolean; amendment?: AmendmentRef;
  confidence: 'exact' | 'inferred'; warnings: string[];
}
export interface RcwRef   { kind: 'rcw'; title: string; chapter?: string; section?: string; cite: string }
export interface SessionLawRef { kind: 'session_law'; year: number; chapter: number; pv: boolean }
export interface FnPackageRef  { kind: 'fiscal_note_package'; packageId: number }
export interface InitiativeRef { kind: 'initiative'; number: number }
export type Ref = BillRef | AmendmentRef | RcwRef | SessionLawRef | FnPackageRef | InitiativeRef;

export interface ParseResult { ref: Ref | null; remainder: string; normalized: string }
export interface ParseOptions { currentBiennium: string }   // "2025-26"

const TYPES = 'HB|SB|HJR|SJR|HJM|SJM|HCR|SCR|HR|SR';
const HOUSE: ReadonlySet<BillType> = new Set(['HB','HJR','HJM','HCR','HR']);

const WORD_FORMS: Array<[RegExp, string]> = [
  [/\b((?:[A-Z0-9]\.\s?){2,})/g, (m: string) => m.replace(/[.\s]/g, '')] as any,  // H.B. → HB, S.H.B. → SHB
  [/\bHOUSE\s+JOINT\s+RESOLUTION\b/g, 'HJR'], [/\bSENATE\s+JOINT\s+RESOLUTION\b/g, 'SJR'],
  [/\bHOUSE\s+JOINT\s+MEMORIAL\b/g, 'HJM'],   [/\bSENATE\s+JOINT\s+MEMORIAL\b/g, 'SJM'],
  [/\bHOUSE\s+CONCURRENT\s+RESOLUTION\b/g, 'HCR'], [/\bSENATE\s+CONCURRENT\s+RESOLUTION\b/g, 'SCR'],
  [/\bHOUSE\s+RESOLUTION\b/g, 'HR'], [/\bSENATE\s+RESOLUTION\b/g, 'SR'],
  [/\bHOUSE\s+BILL\b/g, 'HB'], [/\bSENATE\s+BILL\b/g, 'SB'],
  [/\b(?:SECOND|2ND)\s+SUBSTITUTE\b/g, '2S'], [/\b(?:THIRD|3RD)\s+SUBSTITUTE\b/g, '3S'],
  [/\b(?:FIRST\s+)?SUBSTITUTE\b/g, 'S'],
  [/\b(?:SECOND|2ND)\s+ENGROSSED\b/g, '2E'], [/\b(?:THIRD|3RD)\s+ENGROSSED\b/g, '3E'], [/\bENGROSSED\b/g, 'E'],
  [/\bINITIATIVE(?:\s+MEASURE)?(?:\s+NO\.?)?\s*/g, 'I-'],
  [/\b(?:NO\.?|NUMBER)\s+(?=\d)/g, ''],
  // glue prefix tokens: "2S HB" → "2SHB", then "E 2SHB" → "E2SHB"
  [new RegExp(`\\b([23]?S)\\s+(?=(?:${TYPES})\\b)`, 'g'), '$1'],
  [new RegExp(`\\b([23]?E)\\s+(?=[23]?S?(?:${TYPES})\\b)`, 'g'), '$1'],
];

export function normalize(input: string): string {
  let s = input.trim().toUpperCase().replace(/\s+/g, ' ');
  for (const [re, rep] of WORD_FORMS) s = s.replace(re, rep as string);
  return s;
}

export function bienniumOf(year: number): string {
  const start = year % 2 === 1 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}
function bienniumFromMatch(y: string, y2?: string): string {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return bienniumOf(year);
}

export function typeForNumber(n: number): { type: BillType; inRange: boolean } {
  const table: Array<[number, number, BillType]> = [
    [1000, 3999, 'HB'], [4000, 4199, 'HJM'], [4200, 4399, 'HJR'], [4400, 4599, 'HCR'], [4600, 4999, 'HR'],
    [5000, 7999, 'SB'], [8000, 8199, 'SJM'], [8200, 8399, 'SJR'], [8400, 8599, 'SCR'], [8600, 8999, 'SR'],
  ];
  for (const [lo, hi, t] of table) if (n >= lo && n <= hi) return { type: t, inRange: true };
  return { type: n < 5000 ? 'HB' : 'SB', inRange: false };
}

/** Build a version code from label prefixes ("2E","S") and/or a lawfiles suffix ("-S2", ".E"). */
export function versionCode(eng?: string, sub?: string, lsub?: string, leng?: string): string {
  let s = sub ? (sub.length === 1 ? 'S' : `S${sub[0]}`) : '';
  let e = eng ? (eng.length === 1 ? 'E' : `E${eng[0]}`) : '';
  if (lsub) s = `S${lsub.slice(2)}`;              // "-S2" → "S2"
  let stage = '';
  if (leng) { const t = leng.slice(1); if (t === 'PL' || t === 'SL') stage = t; else e = t; }
  return [s, stage || e].filter(Boolean).join('.');
}

export function decodeVersion(code: string): { substitute: number; engrossed: number; stage: '' | 'PL' | 'SL' } {
  const m = /^(?:S(\d?))?(?:\.?(?:E(\d?)|(PL|SL)))?$/.exec(code);
  if (!m) throw new Error(`bad version code ${code}`);
  return {
    substitute: m[1] === undefined ? 0 : Number(m[1] || 1),
    engrossed:  m[2] === undefined ? 0 : Number(m[2] || 1),
    stage: (m[3] as 'PL' | 'SL') ?? '',
  };
}

/** "ESHB 1234", "2SSB 5001". For PL/SL pass the engrossed level from the version list. */
export function label(ref: Pick<BillRef,'type'|'number'|'versionCode'>, engrossedOverride?: number): string {
  const v = decodeVersion(ref.versionCode);
  const e = engrossedOverride ?? v.engrossed;
  const ep = e === 0 ? '' : e === 1 ? 'E' : `${e}E`;
  const sp = v.substitute === 0 ? '' : v.substitute === 1 ? 'S' : `${v.substitute}S`;
  return `${ep}${sp}${ref.type} ${ref.number}${v.stage ? ` (${v.stage})` : ''}`;
}

export function lawfilesSuffix(code: string): string {
  const v = decodeVersion(code);
  const s = v.substitute ? `-S${v.substitute === 1 ? '' : v.substitute}` : '';
  const tail = v.stage ? `.${v.stage}` : v.engrossed ? `.E${v.engrossed === 1 ? '' : v.engrossed}` : '';
  return s + tail;
}

export function billKey(r: Pick<BillRef,'biennium'|'type'|'number'>): string { return `WA:${r.biennium}:${r.type}${r.number}`; }

const RE = {
  sessionLaw: /^(?:CH(?:APTER)?\.?\s*(\d{1,4}),?\s*(?:LAWS\s+OF\s+((?:19|20)\d\d)|((?:19|20)\d\d)\s+LAWS)|((?:19|20)\d\d)\s+C\s+(\d{1,4}))\s*(PV)?\b/,
  rcw: /^(?:RCW\s*)?(\d{1,2}[A-Z]?)\.(\d{2,3}[A-Z]?)(?:\.(\d{3,4}[A-Z]?))?\b|^CHAPTER\s+(\d{1,2}[A-Z]?)\.(\d{2,3}[A-Z]?)\s+RCW\b|^TITLE\s+(\d{1,2}[A-Z]?)\s+RCW\b/,
  fnPackage: /^(?:PACKAGE\s*ID\s*=?|PACKAGE|FN\s*#?|FISCAL\s+NOTE(?:\s+PACKAGE)?\s*#?)\s*(\d{3,8})\b/,
  initiative: /^I-?\s?(\d{3,4})\b/,
  drafter: /\b([HS])-?(\d{4}\.(?:\d+|E))\b/,
  amendmentOnly: /^(?:(\d{1,4})((?:-S[23]?)?(?:\.E[23]?)?)\s+)?AM([HSC])\s+([A-Z&]+)\s+(?:([HS])-?(\d{4}\.(?:\d+|E))|([A-Z]{3,5})\s+(\d{1,4}))\b/,
  bill: new RegExp(
    `^(?:((?:19|20)\\d\\d)(?:-(?:(?:19|20)?\\d\\d))?\\s+(?=[23ES]*(?:${TYPES})))?` +   // leading biennium, only before a type
    `([23]?E)?([23]?S)?(${TYPES})?[\\s-]*(\\d{1,4})(-S[23]?)?(\\.(?:E[23]?|PL|SL))?(?![\\d.])`),
  bienniumTail: /^\s*[(,]?\s*(?:FOR\s+|OF\s+)?((?:19|20)\d\d)(?:\s*-\s*((?:19|20)?\d\d))?(?:\s+(?:REGULAR|SPECIAL|1ST|2ND|3RD)?\s*SESSION)?\s*\)?/,
  // groups: 1 "as amended by", 2 AMENDMENT|AMD, 3 AM chamber, 4 committee/sponsor code, 5+6 drafter number, 7 initials, 8 floor number
  amendmentTail: /^\s*,?\s*(AS\s+AMENDED\s+BY\s+)?(?:(AMENDMENT|AMD)\s+(?:NO\.?\s*)?|AM([HSC])\s+(?:([A-Z&]+)\s+)?)?(?:([HS])-?(\d{4}\.(?:\d+|E))|(?:([A-Z]{3,5})\s+)?(\d{1,4}))\b/,
  trailingType: new RegExp(`^\\s+([23]?E)?([23]?S)?(${TYPES})\\b`),   // "2402 HB (Final)", "1234 2SHB"
};

export function parse(input: string, opts: ParseOptions): ParseResult {
  const s = normalize(input);
  const done = (ref: Ref | null, consumed: number): ParseResult =>
    ({ ref, remainder: s.slice(consumed).replace(/^[\s,;)]+/, ''), normalized: s });
  if (!s) return done(null, 0);

  let m: RegExpExecArray | null;
  if ((m = RE.sessionLaw.exec(s)))
    return done({ kind: 'session_law', chapter: Number(m[1] ?? m[5]), year: Number(m[2] ?? m[3] ?? m[4]), pv: !!m[6] }, m[0].length);
  if ((m = RE.rcw.exec(s))) {
    const title = m[1] ?? m[4] ?? m[6]; const chapter = m[2] ?? m[5]; const section = m[3];
    const cite = [title, chapter, section].filter(Boolean).join('.');
    return done({ kind: 'rcw', title, chapter: chapter && `${title}.${chapter}`, section: section && cite, cite }, m[0].length);
  }
  if ((m = RE.fnPackage.exec(s))) return done({ kind: 'fiscal_note_package', packageId: Number(m[1]) }, m[0].length);
  if ((m = RE.initiative.exec(s))) return done({ kind: 'initiative', number: Number(m[1]) }, m[0].length);

  if ((m = RE.amendmentOnly.exec(s))) {
    const amd: AmendmentRef = { kind: 'amendment', chamber: m[3] as Chamber | 'C', committeeOrSponsor: m[4],
      drafterNumber: m[6] ? `${m[5]}${m[6]}` : undefined, initials: m[7], amdNumber: m[8] ? Number(m[8]) : undefined };
    if (!m[1]) return done(amd, m[0].length);
    const n = Number(m[1]); const t = typeForNumber(n);
    const lsub = /-S[23]?/.exec(m[2] ?? '')?.[0]; const leng = /\.E[23]?/.exec(m[2] ?? '')?.[0];
    return done({ kind: 'bill', biennium: opts.currentBiennium, bienniumExplicit: false, chamber: HOUSE.has(t.type) ? 'H' : 'S',
      type: t.type, number: n, versionCode: versionCode(undefined, undefined, lsub, leng), versionExplicit: !!(lsub || leng),
      amendment: amd, confidence: 'inferred', warnings: [] }, m[0].length);
  }
  if ((m = RE.drafter.exec(s)) && m.index === 0)
    return done({ kind: 'amendment', chamber: m[1] as Chamber, drafterNumber: `${m[1]}${m[2]}` }, m[0].length);

  if ((m = RE.bill.exec(s))) {
    let [, y0, eng, sub, typeStr, numStr, lsub, leng] = m;
    const number = Number(numStr);
    const warnings: string[] = [];
    let end = m[0].length;
    if (!typeStr) {                                   // fiscal-note description form: "2402 HB", "1234 2SHB"
      const tt = RE.trailingType.exec(s.slice(end));
      if (tt) { eng = eng ?? tt[1]; sub = sub ?? tt[2]; typeStr = tt[3]; end += tt[0].length; }
    }
    let type = typeStr as BillType | undefined; let confidence: 'exact' | 'inferred' = 'exact';
    const inferred = typeForNumber(number);
    if (!type) {
      type = inferred.type; confidence = 'inferred';
      if (!inferred.inRange) warnings.push(`number ${number} is outside every known range`);
      if (number >= 1900 && number <= 2099 && !eng && !sub && !lsub && !leng) warnings.push('may be a year');
    } else if (inferred.inRange && (HOUSE.has(type) !== HOUSE.has(inferred.type))) {
      warnings.push(`number ${number} is outside the usual ${HOUSE.has(type) ? 'House' : 'Senate'} range`);
    }
    let biennium = y0 ? bienniumFromMatch(y0) : opts.currentBiennium; let bienniumExplicit = !!y0;
    const rest = s.slice(end);
    const bt = RE.bienniumTail.exec(rest);
    if (bt) { biennium = bienniumFromMatch(bt[1], bt[2]); bienniumExplicit = true; end += bt[0].length; }
    const at = RE.amendmentTail.exec(s.slice(end));
    let amendment: AmendmentRef | undefined;
    if (at && (at[1] || at[2] || at[3] || at[6])) {   // a bare trailing number is not an amendment
      amendment = { kind: 'amendment', chamber: (at[3] ?? at[5]) as Chamber | 'C' | undefined, committeeOrSponsor: at[4],
        drafterNumber: at[6] ? `${at[5]}${at[6]}` : undefined, initials: at[7], amdNumber: at[8] ? Number(at[8]) : undefined };
      end += at[0].length;
    }
    const code = versionCode(eng, sub, lsub, leng);
    return done({ kind: 'bill', biennium, bienniumExplicit, chamber: HOUSE.has(type) ? 'H' : 'S', type, number,
      versionCode: code, versionExplicit: !!(eng || sub || lsub || leng), amendment, confidence, warnings }, end);
  }
  return done(null, 0);
}

/** Every reference in a string, in order. */
export function parseAll(input: string, opts: ParseOptions): Ref[] {
  const out: Ref[] = []; let rest = input;
  for (let i = 0; i < 20 && rest; i++) {
    const r = parse(rest, opts);
    if (!r.ref) { const cut = rest.search(/[\s,;]/); if (cut < 0) break; rest = rest.slice(cut + 1); continue; }
    out.push(r.ref); rest = r.remainder;
  }
  return out;
}

/** True when the whole input is one reference (used by the search box to decide on redirect). */
export function isBareReference(input: string, opts: ParseOptions): boolean {
  const r = parse(input, opts); return !!r.ref && r.remainder === '';
}
```

The router uses `parse(params.ref)` for `/bills/:ref`; `remainder !== ''` or `ref === null` gives a 404 with a search link. The test table in 2.6 is the fixture file `packages/billref/test/cases.json`.

## 3. OpenSearch index design

OpenSearch 3.7.0 (June 2026; 2.19.x is the maintenance line). Features used: `search_as_you_type`, `completion` suggester with category contexts, `synonym_graph`, `shingle`, `kstem`, `collapse`, `highlight` (unified), `indices_boost`, aliases.

### 3.1 Indices

| Index | Document | Approx. count (2025-26) | Primary key |
|---|---|---|---|
| `bills` | one per bill per biennium | 3,413 | `WA:2025-26:HB2402` |
| `bill_sections` | one per section per version | 60k-120k (6,429 versions; budget bills have thousands of sections) | `WA:2025-26:HB2402:S:sec-3` |
| `amendments` | one per amendment | 4,127 | Legiscan `amendment_id` |
| `fiscal_notes` | one per note (OFM published or internal draft) | 5,761 OFM + internal | `fn:ofm:75952`, `fn:int:<uuid>` |
| `rcw_sections` | one per RCW section referenced by any bill | ~8k | `rcw:82.04.260` |
| `templates` | one per template version | tens | `tpl:<uuid>:<version>` |

Alias `search_all` covers all six. Aliases `bills`, `bill_sections`, ... point at versioned physical indices (`bills_v2026090201`).

Sections live in their own index rather than as `nested` objects in the bill document or as `join` children. A `nested` array would put an entire bill text in one document (a budget bill exceeds 10 MB and thousands of nested objects), every section change would re-index the whole bill, and highlighting requires `inner_hits`. A `join` field requires parent and child on the same shard through routing, allows one join field per index, and `has_child` scoring is slower than a flat query. Flat section documents with the bill's small identifying fields copied in (`bill_key`, `bill_number`, `title`, `biennium`, `chamber`, `status`) need no joins for filtering and support `collapse` on `bill_key` to show one entry per bill with the top matching sections as `inner_hits`.

### 3.2 Common fields

Every document in every index:

```json
{
  "doc_type": "bill | section | amendment | fiscal_note | rcw_section | template",
  "bill_key": "WA:2025-26:HB2402",
  "biennium": "2025-26",
  "chamber": "H",
  "visibility": "public | restricted",
  "allowed_roles": ["reviewer", "admin"],
  "allowed_user_ids": ["u_123"],
  "updated_at": "2026-09-02T10:00:00Z",
  "source_hash": "b6851eb64a7a252d220e7a363b47794b"
}
```

Permission rule per document type:

| doc_type | visibility | allowed_roles | allowed_user_ids |
|---|---|---|---|
| bill, section, amendment, rcw_section | public | [] | [] |
| fiscal_note, source=ofm | public | [] | [] |
| fiscal_note, status=draft | restricted | ["admin"] | author + assignees |
| fiscal_note, status=in_review | restricted | ["reviewer", "admin"] | author + assignees |
| fiscal_note, status=approved | public | [] | [] |
| template | restricted | ["drafter", "reviewer", "admin"] | owner |

### 3.3 Analysis settings

```json
{
  "settings": {
    "index": { "number_of_shards": 1, "number_of_replicas": 0, "refresh_interval": "1s" },
    "analysis": {
      "char_filter": {
        "ampersand": { "type": "mapping", "mappings": ["& => and"] }
      },
      "filter": {
        "legal_synonyms": {
          "type": "synonym_graph", "expand": true, "lenient": true,
          "synonyms": [
            "b and o, business and occupation, business and occupations, b o",
            "rcw, revised code of washington",
            "wac, washington administrative code",
            "dor, department of revenue",
            "ofm, office of financial management",
            "lsc, legislative service center",
            "fte, full time equivalent",
            "reet, real estate excise tax",
            "puc, public utility tax",
            "esd, employment security department",
            "dshs, department of social and health services",
            "l and i, labor and industries",
            "cte, career and technical education",
            "fiscal note, fn"
          ]
        },
        "legal_stem": { "type": "kstem" },
        "possessive": { "type": "english_possessive_stemmer" },
        "title_shingles": { "type": "shingle", "min_shingle_size": 2, "max_shingle_size": 3, "output_unigrams": false }
      },
      "analyzer": {
        "legal_text": {
          "type": "custom", "char_filter": ["ampersand"], "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "possessive", "legal_stem"]
        },
        "legal_text_search": {
          "type": "custom", "char_filter": ["ampersand"], "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "possessive", "legal_synonyms", "legal_stem"]
        },
        "title_shingle": {
          "type": "custom", "char_filter": ["ampersand"], "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "title_shingles"]
        },
        "billnum": {
          "type": "custom", "tokenizer": "keyword", "filter": ["uppercase"]
        }
      },
      "normalizer": {
        "upper": { "type": "custom", "filter": ["uppercase", "trim"] }
      }
    }
  }
}
```

Notes on the choices:

- `synonym_graph` runs at search time only (`legal_text_search`). Multi-word synonyms are not indexed as graphs. The synonym list is a file in the repo (`search/synonyms.txt`) loaded into the index settings at index creation; changing it requires closing and reopening the index or a rebuild, so it ships with the index version.
- `kstem` is a light stemmer. It maps `taxes` → `tax`, `manufacturing` → `manufacture`, and leaves `assessment` alone. No stopword removal: legal phrases such as "shall not" and "in lieu of" carry meaning.
- The standard tokenizer keeps `82.04.260` as one token but splits `70A.350.010` into `70A` and `350.010`. RCW cites are therefore not matched inside text fields; the ingester extracts them with a regex into keyword fields (`rcw_cites`, `rcw_chapters`, `rcw_titles`) and the query pipeline turns an RCW reference in the query into a `terms` filter on those fields.
- Shingles are indexed on `title` only. Phrase matching on section text uses `match_phrase` with positions, which needs no extra index.
- `search_as_you_type` on `title.sayt` produces `_2gram`, `_3gram`, and `_index_prefix` subfields and is queried with `multi_match` type `bool_prefix`.
- The completion suggester on `bills.suggest` holds the bill number in every written form plus the first six title words, with a `biennium` category context and a weight from status (chaptered > passed > in committee > introduced).

### 3.4 `bills` mapping

```json
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "doc_type":        { "type": "keyword" },
      "bill_key":        { "type": "keyword" },
      "biennium":        { "type": "keyword" },
      "chamber":         { "type": "keyword" },
      "type":            { "type": "keyword" },
      "number":          { "type": "integer" },
      "bill_number":     { "type": "keyword", "normalizer": "upper", "fields": { "text": { "type": "text", "analyzer": "billnum" } } },
      "bill_number_forms": { "type": "keyword", "normalizer": "upper" },
      "display":         { "type": "keyword" },
      "title":           { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search",
                           "fields": { "shingles": { "type": "text", "analyzer": "title_shingle" },
                                       "sayt": { "type": "search_as_you_type", "max_shingle_size": 3 },
                                       "keyword": { "type": "keyword", "ignore_above": 512 } } },
      "description":     { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search" },
      "status":          { "type": "keyword" },
      "status_code":     { "type": "integer" },
      "status_date":     { "type": "date" },
      "committee":       { "properties": { "id": { "type": "keyword" }, "name": { "type": "keyword" }, "chamber": { "type": "keyword" } } },
      "sponsors":        { "type": "object", "properties": {
                             "people_id": { "type": "keyword" }, "name": { "type": "text", "analyzer": "legal_text", "fields": { "keyword": { "type": "keyword" } } },
                             "last_name": { "type": "keyword" }, "party": { "type": "keyword" }, "district": { "type": "keyword" }, "primary": { "type": "boolean" } } },
      "sponsor_names":   { "type": "text", "analyzer": "legal_text" },
      "companion_bill_key": { "type": "keyword" },
      "chapter":         { "properties": { "year": { "type": "integer" }, "number": { "type": "integer" }, "pv": { "type": "boolean" } } },
      "versions":        { "type": "object", "enabled": false },
      "latest_version_code": { "type": "keyword" },
      "version_codes":   { "type": "keyword" },
      "has_fiscal_note": { "type": "boolean" },
      "fiscal_note_count": { "type": "integer" },
      "fiscal_note_status": { "type": "keyword" },
      "fiscal_note_package_ids": { "type": "keyword" },
      "assigned_user_ids": { "type": "keyword" },
      "rcw_cites":       { "type": "keyword" },
      "rcw_chapters":    { "type": "keyword" },
      "rcw_titles":      { "type": "keyword" },
      "rcw_actions":     { "type": "object", "enabled": false },
      "history_text":    { "type": "text", "analyzer": "legal_text" },
      "last_action":     { "type": "text", "analyzer": "legal_text", "fields": { "keyword": { "type": "keyword", "ignore_above": 512 } } },
      "last_action_date": { "type": "date" },
      "next_hearing_date": { "type": "date" },
      "hearing_count":   { "type": "integer" },
      "suggest":         { "type": "completion", "analyzer": "simple", "preserve_separators": false,
                           "contexts": [ { "name": "biennium", "type": "category" } ] },
      "visibility":      { "type": "keyword" },
      "allowed_roles":   { "type": "keyword" },
      "allowed_user_ids": { "type": "keyword" },
      "updated_at":      { "type": "date" },
      "source_hash":     { "type": "keyword" },
      "legiscan_bill_id": { "type": "integer" }
    }
  }
}
```

Example document:

```json
{
  "doc_type": "bill", "bill_key": "WA:2025-26:HB2402", "biennium": "2025-26", "chamber": "H", "type": "HB", "number": 2402,
  "bill_number": "HB2402", "bill_number_forms": ["HB2402", "HB 2402", "2402", "SHB 2402", "SHB2402"], "display": "HB 2402",
  "title": "Concerning phthalates in medical equipment used for intravenous purposes.",
  "description": "Concerning phthalates in medical equipment used for intravenous purposes.",
  "status": "in_committee", "status_code": 1, "status_date": "2026-01-13",
  "committee": { "id": "943", "name": "Rules", "chamber": "H" },
  "sponsors": [ { "people_id": "14824", "name": "Monica Stonier", "last_name": "Stonier", "party": "D", "district": "HD-049B", "primary": true },
                { "people_id": "26296", "name": "Lisa Parshley", "last_name": "Parshley", "party": "D", "district": "HD-022B", "primary": false } ],
  "sponsor_names": "Monica Stonier Lisa Parshley Ramel Reed",
  "companion_bill_key": null,
  "chapter": null,
  "versions": [
    { "code": "", "label": "HB 2402", "legiscan_doc_id": 3306876, "text_hash": "7b99f532fddbea473daaac11c5d551c8", "pdf": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Pdf/Bills/House%20Bills/2402.pdf", "htm": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Bills/House%20Bills/2402.htm", "session_year": 2026 },
    { "code": "S", "label": "SHB 2402", "legiscan_doc_id": 3350289, "text_hash": "b6851eb64a7a252d220e7a363b47794b", "pdf": "…/2402-S.pdf", "htm": "…/2402-S.htm", "session_year": 2026 }
  ],
  "latest_version_code": "S", "version_codes": ["", "S"],
  "has_fiscal_note": true, "fiscal_note_count": 2, "fiscal_note_status": "published", "fiscal_note_package_ids": ["75952", "76263"],
  "assigned_user_ids": [],
  "rcw_cites": [], "rcw_chapters": ["70A.350"], "rcw_titles": ["70A"],
  "rcw_actions": [ { "cite": "70A", "action": "new_chapter", "version_code": "S" } ],
  "history_text": "First reading, referred to Environment & Energy. Committee relieved of further consideration. Referred to Health Care & Wellness. …",
  "last_action": "Referred to Rules 2 Review.", "last_action_date": "2026-02-04",
  "next_hearing_date": null, "hearing_count": 2,
  "suggest": { "input": ["HB 2402", "HB2402", "2402", "SHB 2402", "phthalates in medical equipment used for"], "weight": 10, "contexts": { "biennium": ["2025-26"] } },
  "visibility": "public", "allowed_roles": [], "allowed_user_ids": [],
  "updated_at": "2026-09-02T10:00:00Z", "source_hash": "4a8a481e0badc86752030dd576e546ae", "legiscan_bill_id": 2072028
}
```

`status` labels from Legiscan status codes: 0 prefiled/none, 1 introduced (in committee), 2 engrossed (passed origin chamber), 3 enrolled (passed legislature), 4 passed (signed), 5 vetoed, 6 failed. The 2025-26 set: 2,233 introduced, 250 engrossed, 6 enrolled, 920 passed, 1 vetoed, 3 prefiled.

### 3.5 `bill_sections` mapping and document

```json
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "doc_type": { "type": "keyword" }, "bill_key": { "type": "keyword" }, "version_key": { "type": "keyword" },
      "biennium": { "type": "keyword" }, "chamber": { "type": "keyword" }, "type": { "type": "keyword" },
      "bill_number": { "type": "keyword", "normalizer": "upper" }, "display": { "type": "keyword" },
      "title": { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search" },
      "version_code": { "type": "keyword" }, "version_label": { "type": "keyword" }, "is_latest_version": { "type": "boolean" },
      "section_id": { "type": "keyword" }, "section_no": { "type": "keyword" }, "ordinal": { "type": "integer" },
      "heading": { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search", "fields": { "keyword": { "type": "keyword", "ignore_above": 512 } } },
      "action": { "type": "keyword" },
      "rcw_cite": { "type": "keyword" }, "rcw_chapter": { "type": "keyword" }, "rcw_title": { "type": "keyword" },
      "text": { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search", "term_vector": "with_positions_offsets" },
      "added_text": { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search" },
      "struck_text": { "type": "text", "analyzer": "legal_text", "search_analyzer": "legal_text_search" },
      "status": { "type": "keyword" }, "committee": { "properties": { "name": { "type": "keyword" } } },
      "has_fiscal_note": { "type": "boolean" },
      "visibility": { "type": "keyword" }, "allowed_roles": { "type": "keyword" }, "allowed_user_ids": { "type": "keyword" },
      "updated_at": { "type": "date" }, "source_hash": { "type": "keyword" }
    }
  }
}
```

```json
{
  "doc_type": "section", "bill_key": "WA:2025-26:HB1941", "version_key": "WA:2025-26:HB1941:E",
  "biennium": "2025-26", "chamber": "H", "type": "HB", "bill_number": "HB1941", "display": "HB 1941",
  "title": "Authorizing agricultural cooperatives for cannabis producers.",
  "version_code": "E", "version_label": "EHB 1941", "is_latest_version": false,
  "section_id": "sec-1", "section_no": "1", "ordinal": 1,
  "heading": "Sec. 1. RCW 69.50.325 and 2022 c 16 s 54 are each amended to read as follows:",
  "action": "amend", "rcw_cite": "69.50.325", "rcw_chapter": "69.50", "rcw_title": "69",
  "text": "(1) There shall be a cannabis producer's license regulated by the board and subject to annual renewal. … The application fee for a cannabis producer's license shall be $250. …",
  "added_text": "$250 $1,000 licensed cannabis producers,",
  "struck_text": "two hundred fifty dollars one thousand dollars",
  "status": "passed", "committee": { "name": "Agriculture & Natural Resources" }, "has_fiscal_note": true,
  "visibility": "public", "allowed_roles": [], "allowed_user_ids": [],
  "updated_at": "2026-09-02T10:00:00Z", "source_hash": "sha256-of-htm"
}
```

`text` is the section as it reads after the amendment (struck text removed, underlined text kept). `added_text` and `struck_text` hold the underlined and struck runs so "which bills add the phrase X" is a query on `added_text`. `action` is `new`, `amend`, `repeal`, `recodify`, `reenact`, `uncodified`, from the section heading.

### 3.6 `amendments`

```json
{
  "doc_type": "amendment", "amendment_id": "1092239", "amendment_key": "WA:2025-26:SB6137:AMD:S:S4812.1",
  "bill_key": "WA:2025-26:SB6137", "biennium": "2025-26", "chamber": "S", "bill_number": "SB6137", "display": "SB 6137",
  "title": "Concerning sports wagering.",
  "target_version_code": "", "target_version_label": "SB 6137",
  "amending_chamber": "S", "kind": "floor", "sponsor_kind": "member", "sponsor": "Cortes", "sponsor_code": "CORA",
  "drafter_number": "S4812.1", "initials": null, "amd_number": 579, "disposition": "withdrawn", "disposition_date": "2026-02-11",
  "description": "Cortes 6137 AMS CORA S4812.1", "legiscan_title": "Senate Floor Amendment",
  "text": "On page 3, after line 17, insert the following: \"Sec. 5. RCW 9.46.037 and 2020 c 127 s 5 are each amended to read as follows: …",
  "rcw_cites": ["9.46.037"], "rcw_chapters": ["9.46"],
  "pdf": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Pdf/Amendments/Senate/6137%20AMS%20CORA%20S4812.1.pdf",
  "htm": "https://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Amendments/Senate/6137%20AMS%20CORA%20S4812.1.htm",
  "visibility": "public", "allowed_roles": [], "allowed_user_ids": [], "updated_at": "…", "source_hash": "…"
}
```

Field mapping: keyword for all ids, codes, `sponsor`, `disposition`; `text` and `description` use `legal_text`. `kind` from the Legiscan title: `Senate Floor Amendment` → floor (3,673), `House Committee Amendment` → committee (366), `House Engrossed Amendment` → engrossed (81), `Senate Conference Amendment` → conference (7, `amending_chamber: "C"`); striking amendments detected from text starting with "Strike everything after the enacting clause".

### 3.7 `fiscal_notes`

```json
{
  "doc_type": "fiscal_note", "note_id": "fn:int:9f1c…", "source": "internal",
  "bill_key": "WA:2025-26:HB2402", "biennium": "2025-26", "chamber": "H", "bill_number": "HB2402", "display": "HB 2402",
  "version_code": "S", "version_label": "SHB 2402", "amendment_key": null,
  "package_id": null, "ofm_kind": null,
  "title": "Fiscal note: SHB 2402, phthalates in IV medical equipment",
  "status": "in_review", "note_version": 3, "agency": "DOR", "division": "RFA",
  "author_id": "u_17", "assigned_user_ids": ["u_17", "u_42"], "reviewer_ids": ["u_42"], "due_at": "2026-02-06T17:00:00Z",
  "summary": "The bill does not change any tax administered by the department. …",
  "assumptions": "…", "cash_receipts_text": "…", "expenditure_text": "…",
  "totals": { "fy2026": 0, "fy2027": 0, "biennium_2025_27": 0 },
  "body": "full plain text of every narrative field for full-text search",
  "visibility": "restricted", "allowed_roles": ["reviewer", "admin"], "allowed_user_ids": ["u_17", "u_42"],
  "updated_at": "2026-09-02T10:00:00Z", "source_hash": "note-version-hash"
}
```

OFM notes from Legiscan supplements are indexed with `source: "ofm"`, `package_id: "75952"`, `ofm_kind: "Final" | "Partial" | "Revised"`, the version label parsed from the description (`2402 HB (Final)` → `""`; `1234 2SHB (Final)` → `S2`; `6137 SB AMH SGOV H3681.1 (Partial)` → amendment `H3681.1`), and `body` empty until PDF text extraction is added. Labels with a leading `P` (`PSHB`, `PSSB`, `PEHB`; 56 notes) are notes on a proposed substitute and set `proposed: true`; a draft number after the label (`S-3966.1/26`) goes to `draft_number`; a label of just `B` (16 notes) sets `version_label: null`. The raw description is kept in `description_raw` and is searchable.

### 3.8 `rcw_sections`

```json
{
  "doc_type": "rcw_section", "cite": "82.04.260", "title": "82", "chapter": "82.04", "caption": "Tax on manufacturers and processors of various foods and by-products—Research and development organizations—Travel agents—Certain international activities—Stevedoring and associated activities—Low-level waste disposers—Insurance producers, surplus line brokers, and title insurance agents—Hospitals—Commercial airplane activities—Timber product activities—Canned salmon processors.",
  "text": "…current RCW text if licensed for indexing; otherwise null…",
  "affected_by": [ { "bill_key": "WA:2025-26:HB1234", "version_code": "S", "action": "amend", "display": "SHB 1234" } ],
  "affected_by_bill_keys": ["WA:2025-26:HB1234"],
  "biennium": "2025-26", "chamber": null, "bill_key": null,
  "visibility": "public", "allowed_roles": [], "allowed_user_ids": [], "updated_at": "…", "source_hash": "…"
}
```

The POC builds this index from bill text alone (cites and the bill's copy of the amended section). RCW captions and current text come from the LSC RCW web service or the leg.wa.gov RCW XML export when that adapter is added.

### 3.9 `templates`

```json
{
  "doc_type": "template", "template_id": "tpl:b7…", "template_version": 4, "name": "Fiscal note — revenue bill",
  "kind": "fiscal_note", "body": "plain text of the template with field placeholders", "fields": ["summary", "assumptions", "cash_receipts"],
  "owner_id": "u_3", "shared": true, "biennium": null, "bill_key": null, "chamber": null,
  "visibility": "restricted", "allowed_roles": ["drafter", "reviewer", "admin"], "allowed_user_ids": ["u_3"], "updated_at": "…", "source_hash": "…"
}
```

### 3.10 Index lifecycle

- Physical index names carry a date and sequence: `bills_v2026090201`. Aliases `bills`, `bill_sections`, ..., and `search_all` point at the live set. A full rebuild writes to new physical indices and swaps all aliases in one `_aliases` call.
- The ingest state table in Postgres (`ingest_source_state(source_kind, source_id, hash, indexed_at, index_name)`) holds the last indexed `change_hash` per bill, `text_hash` per version, `supplement_hash` per supplement, and `amendment_id` + description hash per amendment. An incremental run skips anything whose hash is unchanged.
- Internal fiscal notes and templates are indexed on write by the notes service (outbox table → indexer), not by the Legiscan loader.
- Index settings and mappings live in `search/indices/*.json` and are versioned. A mapping change increments the version and forces a rebuild.
- Replicas are 0 in dev and 1 in production; one primary shard per index is enough at this size.

## 4. Query pipeline

```
query text ──▶ parse() ──▶ bare reference? ──yes──▶ resolve (index lookup) ──▶ direct hit + related
                   │                                                              │ not found / ambiguous
                   └──no (or remainder non-empty)──▶ text search ◀────────────────┘
```

### 4.1 Reference path

1. `parse(q)`; require `remainder === ''`.
2. Resolve by kind:
   - bill: GET `bills/_doc/<billKey>`. If missing and `bienniumExplicit` is false, `terms` query on `bill_number` across all biennia; two or more hits → `ambiguous` with the candidate list; one → use it. If `versionExplicit` and the code is not in `version_codes`, return the bill with `warnings: ["version not found"]` and the latest version. If `amendment` is set, look it up in `amendments` by `bill_key` and (`drafter_number` | `amd_number` | `initials`+`amd_number`).
   - amendment only: `term` on `drafter_number` in `amendments` (and biennium); the hit gives the bill.
   - session_law: `bool` filter `chapter.year` and `chapter.number`.
   - fiscal_note_package: `term` on `fiscal_notes.package_id`.
   - rcw: no direct hit; the text path runs with `terms` on `rcw_cites` (section) or `rcw_chapters`/`rcw_titles` (chapter/title) and the query string empty, sorted by `last_action_date desc`.
   - initiative: `direct.external = "https://app.leg.wa.gov/billsummary?BillNumber=2117&Year=2025&Initiative=true"`.
3. Related results for a bill direct hit, fetched in one `_msearch`: amendments for the bill (`term bill_key`, size 20, sorted by `disposition_date`), fiscal notes for the bill (permission filter applied), the companion bill, and RCW sections affected.
4. The search box redirects to `/bills/2025-26/HB1234/S.E` (or `/bills/…/S.E/amendments/S4812.1`) when `confidence === 'exact'` and exactly one bill resolved. For `inferred` confidence the result page shows the direct hit as a card above the text results instead of redirecting.

Direct hit `_msearch` body:

```json
{ "index": "bills" }
{ "query": { "ids": { "values": ["WA:2025-26:HB2402"] } }, "size": 1 }
{ "index": "amendments" }
{ "query": { "term": { "bill_key": "WA:2025-26:HB2402" } }, "sort": [{ "disposition_date": "desc" }], "size": 20, "_source": { "excludes": ["text"] } }
{ "index": "fiscal_notes" }
{ "query": { "bool": { "filter": [
    { "term": { "bill_key": "WA:2025-26:HB2402" } },
    { "bool": { "should": [
        { "term": { "visibility": "public" } },
        { "terms": { "allowed_roles": ["drafter"] } },
        { "term": { "allowed_user_ids": "u_17" } } ], "minimum_should_match": 1 } } ] } },
  "sort": [{ "updated_at": "desc" }], "size": 10, "_source": { "excludes": ["body"] } }
{ "index": "rcw_sections" }
{ "query": { "term": { "affected_by_bill_keys": "WA:2025-26:HB2402" } }, "size": 50, "_source": ["cite", "caption", "affected_by"] }
```

### 4.2 Text path

Request: `GET /api/v1/search?q=B%26O%20tax%20credit%20semiconductor&biennium=2025-26&chamber=H&status=in_committee&has_fiscal_note=true&page=1&size=20`.

Field boosts:

| Field | Boost | Index |
|---|---|---|
| `bill_number`, `bill_number_forms` | 5 | bills |
| `title`, `title.shingles` (phrase) | 3 | bills, sections, fiscal_notes |
| `heading` | 2 | sections |
| `sponsor_names`, `sponsors.name` | 2 | bills |
| `text`, `body`, `description` | 1 | sections, fiscal_notes, amendments, templates |
| `added_text` | 1.5 | sections |
| `history_text`, `last_action` | 0.5 | bills |

`indices_boost`: bills 2.0, fiscal_notes 1.5, bill_sections 1.0, amendments 0.9, rcw_sections 0.8, templates 0.7.

```json
{
  "size": 20, "from": 0,
  "track_total_hits": true,
  "indices_boost": [ { "bills": 2.0 }, { "fiscal_notes": 1.5 }, { "bill_sections": 1.0 }, { "amendments": 0.9 }, { "rcw_sections": 0.8 }, { "templates": 0.7 } ],
  "query": {
    "bool": {
      "must": [
        { "bool": { "should": [
          { "multi_match": { "query": "B&O tax credit semiconductor", "type": "best_fields", "operator": "and",
              "fields": ["bill_number^5", "bill_number_forms^5", "title^3", "heading^2", "sponsor_names^2", "sponsors.name^2",
                         "added_text^1.5", "text", "body", "description", "caption", "name", "history_text^0.5", "last_action^0.5"],
              "fuzziness": "AUTO:4,7", "prefix_length": 2 } },
          { "multi_match": { "query": "B&O tax credit semiconductor", "type": "phrase", "slop": 2,
              "fields": ["title.shingles^3", "title^3", "heading^2", "text", "body"], "boost": 2 } }
        ], "minimum_should_match": 1 } }
      ],
      "filter": [
        { "term": { "biennium": "2025-26" } },
        { "term": { "chamber": "H" } },
        { "term": { "status": "in_committee" } },
        { "term": { "has_fiscal_note": true } },
        { "bool": { "should": [
            { "term": { "visibility": "public" } },
            { "terms": { "allowed_roles": ["drafter"] } },
            { "term": { "allowed_user_ids": "u_17" } } ], "minimum_should_match": 1 } }
      ],
      "should": [
        { "term": { "is_latest_version": { "value": true, "boost": 1.5 } } },
        { "range": { "last_action_date": { "gte": "now-30d", "boost": 1.2 } } }
      ]
    }
  },
  "collapse": {
    "field": "bill_key",
    "inner_hits": { "name": "per_bill", "size": 3, "_source": ["doc_type", "version_label", "section_no", "heading"],
                    "highlight": { "fields": { "text": { "fragment_size": 160, "number_of_fragments": 1 } } } }
  },
  "highlight": {
    "type": "unified", "pre_tags": ["<mark>"], "post_tags": ["</mark>"],
    "fields": { "title": { "number_of_fragments": 0 }, "heading": { "number_of_fragments": 0 },
                "text": { "fragment_size": 180, "number_of_fragments": 2 }, "body": { "fragment_size": 180, "number_of_fragments": 2 },
                "description": { "fragment_size": 180, "number_of_fragments": 1 } }
  },
  "aggs": {
    "doc_type":   { "terms": { "field": "doc_type" } },
    "biennium":   { "terms": { "field": "biennium" } },
    "chamber":    { "terms": { "field": "chamber" } },
    "status":     { "terms": { "field": "status", "size": 10 } },
    "committee":  { "terms": { "field": "committee.name", "size": 30 } },
    "has_fiscal_note": { "terms": { "field": "has_fiscal_note" } },
    "fiscal_note_status": { "terms": { "field": "fiscal_note_status" } },
    "sponsor":    { "terms": { "field": "sponsors.last_name", "size": 20 } },
    "rcw_title":  { "terms": { "field": "rcw_titles", "size": 20 } }
  },
  "_source": { "excludes": ["text", "body", "history_text", "versions", "suggest"] }
}
```

`collapse` on `bill_key` returns one hit per bill; documents with no `bill_key` (templates, RCW sections without a bill) collapse on a null value into a single group, so those two indices are searched in a second `_msearch` entry without collapse and merged after. `collapse` is applied before aggregations are computed only for the hit list; aggregation counts are per document, and the UI labels facet counts "documents".

Filters accepted from the client (`filters.*` query parameters): `biennium`, `chamber`, `type`, `status`, `committee`, `sponsor`, `has_fiscal_note`, `fiscal_note_status`, `doc_type`, `rcw_title`, `rcw_chapter`, `rcw_cite`, `version_code`, `date_from`/`date_to` on `last_action_date`, and `assigned_to_me` (server replaces with `term assigned_user_ids = session.userId`). The permission clause is always appended from the session; a client-supplied `visibility`, `allowed_roles`, or `allowed_user_ids` parameter is rejected with 400.

When the parse returns a bill reference with a non-empty remainder (`HB 1234 phthalates`), the text query runs with the remainder as `q` and `term bill_key` added to `filter`, and `direct` is still populated.

When the parse returns an RCW reference, `filter` gets `{ "terms": { "rcw_cites": ["82.04.260"] } }` (section), `{ "term": { "rcw_chapters": "82.04" } }` (chapter), or `{ "term": { "rcw_titles": "82" } }`; the `must` clause is dropped and `sort` is `last_action_date desc`.

### 4.3 Suggest

`GET /api/v1/search/suggest?q=phth&biennium=2025-26`, one `_msearch` with two entries.

```json
{ "index": "bills" }
{ "suggest": { "billnum": { "prefix": "phth", "completion": { "field": "suggest", "size": 6, "skip_duplicates": true, "fuzzy": { "fuzziness": 1, "prefix_length": 2 },
               "contexts": { "biennium": [ { "context": "2025-26" } ] } } } }, "_source": ["bill_key", "display", "title", "latest_version_code", "status"], "size": 0 }
{ "index": "bills,fiscal_notes" }
{ "query": { "bool": { "must": [ { "multi_match": { "query": "phth", "type": "bool_prefix",
      "fields": ["title.sayt", "title.sayt._2gram", "title.sayt._3gram"] } } ],
    "filter": [ { "term": { "biennium": "2025-26" } },
                { "bool": { "should": [ { "term": { "visibility": "public" } }, { "terms": { "allowed_roles": ["drafter"] } }, { "term": { "allowed_user_ids": "u_17" } } ], "minimum_should_match": 1 } } ] } },
  "size": 8, "_source": ["doc_type", "bill_key", "display", "title", "status", "note_id"] }
```

The completion suggester answers bill-number prefixes (`24` → HB 2402, SB 5124…) and exact title starts; the `bool_prefix` query answers infix title words. `preserve_separators: false` lets `hb24` match `HB 2402`. The API merges, de-duplicates by `bill_key`, and returns the parsed reference first when `parse(q)` succeeds so `24` shows "Go to HB 2402? / SB 5024?" above title matches.

## 5. Ingestion pipeline

### 5.1 Steps

1. Read every `bill/*.json`. Compare `bill.change_hash` with `ingest_source_state`; skip unchanged bills unless `--full`.
2. Build the bill document (3.4). Sponsors from `sponsors[]`; committee from `committee`; status from `status`; chapter from the last `history[]` action matching `^Chapter (\d+), (\d{4}) Laws( PV)?\.$`; companion from `sasts[]` where `type == "Crossfiled"`; hearings from `calendar[]`; fiscal-note package ids from `supplements[]` where `type == "Fiscal Note"` (`packageID=` in `state_link`).
3. For each `texts[]` entry, derive the version code from the `state_link` filename:

   ```
   name = last path segment, URL-decoded, extension removed
   m = /^(\d{1,4})(-S[23]?)?(\.(?:E[23]?|PL|SL))?(?:-(.*))?$/.exec(name)
   version_code = versionCode(undefined, undefined, m[2], m[3])
   short_title = m[4]           # resolutions and memorials only
   ```

   `type_id` is a cross-check: Introduced ⇒ `""`, Comm Sub ⇒ starts with `S`, Engrossed ⇒ contains `E`, Enrolled ⇒ ends `PL`, Chaptered ⇒ ends `SL`. A mismatch is logged and the filename wins. HTM URL = `state_link` with `/Pdf/` → `/Htm/` and `.pdf` → `.htm`. Two bills in the set have no texts (HR 4705, SR 8676); they index without versions.
4. Fetch the HTM (cache on disk by `text_hash`; skip fetch when the hash is unchanged). On 404 fetch the PDF and run `pdftotext -layout`; mark `text_source: "pdf"`.
5. Parse HTM into the Bill Document JSON with the bill viewer's parser (shared package `@wa-leg/billdoc`). The parser splits on `<!-- field: BeginningSection -->` markers, reads `Sec. N.` from the bold span, the RCW cite from the `<a href="…cite=69.50.325">` link inside the heading, the action from the heading text (`are each amended`, `NEW SECTION`, `are each repealed`, `recodified`), and collects `text-decoration:underline` runs as added text and `text-decoration:line-through` runs (inside `((…))`) as struck text. Output: `{ bill_key, version_code, label, sponsors_line, caption_title, sections: [{ id, no, heading, rcw_cite, action, text, added_text, struck_text }] }`.
6. Emit one `bill_sections` document per section (3.5). Set `is_latest_version` on the highest version in the bill's list; on a new version, update the flag on the previous version's sections with `_update_by_query`.
7. For each `amendments[]` entry: parse the description with `RE.amendmentOnly` (the description is `<sponsor> <lawfiles amendment name>`); fetch the HTM (`Pdf/Amendments/House/…` → `Htm/…`); read the header line `SB 6137 - S AMD 579 By Senator Cortes WITHDRAWN 02/11/2026` for `amd_number`, sponsor, disposition (`ADOPTED`, `WITHDRAWN`, `FAILED`, `NOT ADOPTED`, `RULED OUT OF ORDER`), and date; index (3.6).
8. For each `supplements[]` of type `Fiscal Note`: parse the description (`<number> <label> [<amendment>] (<kind>)`), index as an OFM note (3.7) keyed by `package_id`.
9. Aggregate `rcw_cites`/`rcw_chapters`/`rcw_titles` per bill from all versions' section headings and the caption title (`amending RCW 69.50.325 and 24.34.010`, `adding a new chapter to Title 70A RCW`), update `rcw_sections.affected_by`.
10. Bulk index with `refresh=false`; refresh once at the end. Record hashes in `ingest_source_state`.

### 5.2 Loader sketch (Python)

```python
# search/ingest/load_legiscan.py
import json, re, hashlib, pathlib, urllib.parse, concurrent.futures as cf
import httpx
from opensearchpy import OpenSearch, helpers
from billref import version_code, label, bill_key          # Python port of the TS package, same test fixtures
from billdoc import parse_bill_htm, parse_amendment_htm     # bill viewer's parser

TEXT_NAME = re.compile(r'^(\d{1,4})(-S[23]?)?(\.(?:E[23]?|PL|SL))?(?:-(.*))?$')
CHAPTER   = re.compile(r'^Chapter (\d+), (\d{4}) Laws( PV)?\.$')
TYPES     = 'HB|SB|HJR|SJR|HJM|SJM|HCR|SCR|HR|SR'
AMD_DESC  = re.compile(r'(\d{1,4})((?:-S[23]?)?(?:\.E[23]?)?) AM([HSC]) ([A-Z&]+) (?:([HS])(\d{4}\.(?:\d+|E))|([A-Z]{3,5}) (\d{1,4}))$')   # matches all 4,127
FN_DESC   = re.compile(r'^(\d{1,4}) (P?(?:[23]?E)?(?:[23]?S)?(?:%s|B))\s*(.*?)\s*\((Final|Partial|Revised)\)$' % TYPES)             # matches all 5,761
FN_EXTRA_AMD   = re.compile(r'AM([HSC]) ([A-Z&]+) (?:([HS])-?(\d{4}\.(?:\d+|E))|([A-Z]{3,5}) (\d{1,4}))')   # extra text: 5,262 empty, 311 amendment, 96 ".PL", 68 draft number, 24 free text
FN_EXTRA_DRAFT = re.compile(r'\b([HS])-?(\d{4}\.\d+)(?:/\d\d)?\b')

def htm_url(pdf_url: str) -> str:
    return pdf_url.replace('/Pdf/', '/Htm/').replace('.pdf', '.htm')

def version_from_link(link: str) -> tuple[str, str | None]:
    name = urllib.parse.unquote(link.rsplit('/', 1)[1]).rsplit('.', 1)[0]
    m = TEXT_NAME.match(name)
    if not m: raise ValueError(name)
    return version_code(None, None, m.group(2), m.group(3)), m.group(4)

class Loader:
    def __init__(self, os_client: OpenSearch, state, cache_dir: pathlib.Path, biennium: str):
        self.os, self.state, self.cache, self.biennium = os_client, state, cache_dir, biennium
        self.http = httpx.Client(timeout=30, headers={'User-Agent': 'wa-leg-search/0.1'})

    def fetch(self, url: str, key: str) -> str:
        p = self.cache / f'{key}.htm'
        if p.exists(): return p.read_text('utf-8')
        r = self.http.get(url); r.raise_for_status()
        p.write_text(r.text, 'utf-8'); return r.text

    def bill_docs(self, b: dict):
        key = bill_key(self.biennium, b['bill_number'])
        versions = []
        for t in sorted(b['texts'], key=lambda t: t['doc_id']):
            code, short = version_from_link(t['state_link'])
            versions.append({'code': code, 'legiscan_doc_id': t['doc_id'], 'text_hash': t['text_hash'],
                             'pdf': t['state_link'], 'htm': htm_url(t['state_link']), 'type_id': t['type_id']})
        chapter = next(({'number': int(m.group(1)), 'year': int(m.group(2)), 'pv': bool(m.group(3))}
                        for h in reversed(b['history']) if (m := CHAPTER.match(h['action']))), None)
        fn = [s for s in b['supplements'] if s['type'] == 'Fiscal Note']
        bill = {  # see section 3.4 for the full shape
            '_index': 'bills', '_id': key, 'doc_type': 'bill', 'bill_key': key, 'biennium': self.biennium,
            'chamber': b['body'], 'type': re.match(r'[A-Z]+', b['bill_number']).group(), 'number': int(re.search(r'\d+', b['bill_number']).group()),
            'bill_number': b['bill_number'], 'title': b['title'], 'description': b['description'],
            'status_code': b['status'], 'status_date': b['status_date'], 'chapter': chapter,
            'sponsors': [{'people_id': str(s['people_id']), 'name': s['name'], 'last_name': s['last_name'], 'party': s['party'],
                          'district': s['district'], 'primary': s['sponsor_type_id'] == 1} for s in b['sponsors']],
            'versions': versions, 'version_codes': [v['code'] for v in versions], 'latest_version_code': versions[-1]['code'] if versions else '',
            'has_fiscal_note': bool(fn), 'fiscal_note_count': len(fn),
            'fiscal_note_package_ids': [urllib.parse.parse_qs(urllib.parse.urlparse(s['state_link']).query)['packageID'][0] for s in fn],
            'history_text': ' '.join(h['action'] for h in b['history']),
            'visibility': 'public', 'allowed_roles': [], 'allowed_user_ids': [], 'source_hash': b['change_hash'],
        }
        yield bill
        for v in versions:
            if self.state.unchanged('text', v['legiscan_doc_id'], v['text_hash']): continue
            html = self.fetch(v['htm'], v['text_hash'])
            doc = parse_bill_htm(html, bill_key=key, version_code=v['code'])
            for i, s in enumerate(doc['sections'], 1):
                yield {'_index': 'bill_sections', '_id': f"{key}:{v['code']}:{s['id']}", 'doc_type': 'section', 'bill_key': key,
                       'version_key': f"{key}:{v['code']}", 'version_code': v['code'], 'is_latest_version': v is versions[-1],
                       'biennium': self.biennium, 'chamber': b['body'], 'bill_number': b['bill_number'], 'title': b['title'],
                       'section_id': s['id'], 'section_no': s['no'], 'ordinal': i, 'heading': s['heading'], 'action': s['action'],
                       'rcw_cite': s['rcw_cite'], 'text': s['text'], 'added_text': s['added_text'], 'struck_text': s['struck_text'],
                       'visibility': 'public', 'allowed_roles': [], 'allowed_user_ids': [], 'source_hash': v['text_hash']}
        for a in b['amendments']:
            m = AMD_DESC.search(a['description'])
            html = self.fetch(htm_url(a['state_link']), f"amd-{a['amendment_id']}")
            hdr = parse_amendment_htm(html)      # {'amd_number': 579, 'sponsor': 'Cortes', 'disposition': 'withdrawn', 'date': '2026-02-11', 'text': ...}
            yield {'_index': 'amendments', '_id': str(a['amendment_id']), 'doc_type': 'amendment', 'bill_key': key,
                   'biennium': self.biennium, 'chamber': b['body'], 'bill_number': b['bill_number'], 'title': b['title'],
                   'target_version_code': version_code(None, None, *re.match(r'(-S[23]?)?(\.E[23]?)?$', m.group(2)).groups()) if m else '',
                   'amending_chamber': m.group(3) if m else None, 'sponsor_code': m.group(4) if m else None,
                   'drafter_number': f'{m.group(5)}{m.group(6)}' if m and m.group(6) else None,
                   'initials': m.group(7) if m else None, 'amd_number': hdr.get('amd_number') or (int(m.group(8)) if m and m.group(8) else None),
                   'description': a['description'], 'legiscan_title': a['title'], **hdr,
                   'pdf': a['state_link'], 'htm': htm_url(a['state_link']),
                   'visibility': 'public', 'allowed_roles': [], 'allowed_user_ids': [], 'source_hash': hashlib.md5(html.encode()).hexdigest()}
        for pkg, s in zip(bill['fiscal_note_package_ids'], fn):
            desc = re.sub(r'\s+', ' ', s['description']).strip()
            m = FN_DESC.match(desc); lbl = m.group(2) if m else None; extra = m.group(3) if m else desc
            am = FN_EXTRA_AMD.search(extra); dn = FN_EXTRA_DRAFT.search(extra)
            yield {'_index': 'fiscal_notes', '_id': f"fn:ofm:{pkg}", 'doc_type': 'fiscal_note', 'source': 'ofm',
                   'bill_key': key, 'biennium': self.biennium, 'chamber': b['body'], 'bill_number': b['bill_number'],
                   'package_id': pkg, 'ofm_kind': m.group(4) if m else None, 'description_raw': desc,
                   'proposed': bool(lbl and lbl.startswith('P')), 'version_label': None if lbl in (None, 'B') else lbl.lstrip('P'),
                   'amendment_drafter_number': f'{am.group(3)}{am.group(4)}' if am and am.group(4) else None,
                   'draft_number': f'{dn.group(1)}{dn.group(2)}' if dn and not am else None,
                   'title': f"{desc} fiscal note", 'status': 'published',
                   'date': s['date'] if s['date'] != '0000-00-00' else None, 'pdf': s['state_link'],
                   'visibility': 'public', 'allowed_roles': [], 'allowed_user_ids': [], 'source_hash': s['supplement_hash']}

    def run(self, bill_dir: pathlib.Path, full: bool = False):
        bills = [json.loads(p.read_text())['bill'] for p in sorted(bill_dir.glob('*.json'))]
        todo = [b for b in bills if full or not self.state.unchanged('bill', b['bill_id'], b['change_hash'])]
        def docs():
            with cf.ThreadPoolExecutor(max_workers=8) as pool:      # HTM fetches are the slow part
                for gen in pool.map(lambda b: list(self.bill_docs(b)), todo):
                    yield from gen
        ok = fail = 0
        for success, info in helpers.streaming_bulk(self.os, docs(), chunk_size=500, max_retries=3, raise_on_error=False, refresh=False):
            ok += success; fail += (not success)
        self.os.indices.refresh(index='search_all')
        self.state.commit(todo)
        return ok, fail
```

Throughput: a full load fetches 6,429 bill texts and 4,127 amendments. At eight concurrent requests and roughly 150-300 ms per file from lawfilesext the fetch phase takes 4-7 minutes on first run and seconds thereafter from the cache. Parsing is under a millisecond per section. Bulk indexing of about 100k section documents plus 15k others at 500 per chunk runs at 3-8k documents per second on a single local node, under a minute. The whole first load is under 10 minutes; an incremental daily run touching a few dozen changed bills is under 30 seconds.

The loader runs as `wa-leg search load --biennium 2025-26 --dataset <dir> [--full]`. The `POST /search/reindex` endpoint enqueues the same job.

### 5.3 Freshness

The Legiscan dataset zip is weekly; the Legiscan API (`getMasterListRaw` for change hashes, `getBill` for changed bills) is daily. Either source feeds the same loader through a `BillSource` adapter (`LegiscanDatasetSource`, `LegiscanApiSource`, later `LscWebServiceSource` for the LSC API named in the RFP). During session the loader runs hourly against the API source.

## 6. Search API

Base path `/api/v1`. Auth: session cookie or bearer token; the session supplies `userId` and `roles`.

### 6.1 `GET /search`

| Parameter | Type | Notes |
|---|---|---|
| `q` | string | required unless a filter is present |
| `biennium` | string | `2025-26`; default current; `all` for every biennium |
| `chamber` | `H` \| `S` | |
| `type` | keyword list | `HB,SB` |
| `status` | keyword list | |
| `committee` | string | committee name |
| `sponsor` | string | last name or `people_id` |
| `has_fiscal_note` | bool | |
| `fiscal_note_status` | keyword list | `draft,in_review,approved,published` |
| `doc_type` | keyword list | restrict to `bill,section,amendment,fiscal_note,rcw_section,template` |
| `rcw` | string | cite, chapter, or title |
| `version_code` | string | |
| `date_from`, `date_to` | date | on `last_action_date` |
| `assigned_to_me` | bool | server substitutes the session user |
| `page`, `size` | int | `size` ≤ 100, default 20 |
| `sort` | `relevance` \| `date` \| `bill_number` | |

Response:

```json
{
  "query": "HB 2402 phthalates",
  "parsed": { "kind": "bill", "biennium": "2025-26", "type": "HB", "number": 2402, "versionCode": "", "versionExplicit": false, "confidence": "exact", "remainder": "PHTHALATES" },
  "direct": {
    "bill_key": "WA:2025-26:HB2402", "display": "HB 2402", "title": "Concerning phthalates in medical equipment used for intravenous purposes.",
    "resolved_version_code": "S", "resolved_version_label": "SHB 2402", "url": "/bills/2025-26/HB2402/S",
    "ambiguous": false, "candidates": [], "warnings": [],
    "related": {
      "amendments": [], "companion": null,
      "fiscal_notes": [ { "note_id": "fn:ofm:75952", "source": "ofm", "title": "2402 HB (Final) fiscal note", "status": "published", "url": "/notes/fn:ofm:75952" } ],
      "rcw": [ { "cite": "70A", "action": "new_chapter" } ]
    }
  },
  "hits": [
    { "doc_type": "section", "score": 14.2, "bill_key": "WA:2025-26:HB2402", "display": "SHB 2402", "version_code": "S",
      "title": "Concerning phthalates in medical equipment used for intravenous purposes.",
      "section_no": "2", "heading": "NEW SECTION. Sec. 2.",
      "highlight": { "text": ["… medical equipment containing intentionally added <mark>phthalates</mark> used for intravenous …"] },
      "url": "/bills/2025-26/HB2402/S#sec-2",
      "inner_hits": [ { "doc_type": "section", "section_no": "3", "heading": "NEW SECTION. Sec. 3.", "highlight": { "text": ["…"] } } ] }
  ],
  "facets": {
    "doc_type": [ { "key": "section", "count": 7 }, { "key": "bill", "count": 1 }, { "key": "fiscal_note", "count": 2 } ],
    "biennium": [ { "key": "2025-26", "count": 10 } ],
    "chamber": [ { "key": "H", "count": 10 } ],
    "status": [ { "key": "in_committee", "count": 10 } ],
    "committee": [ { "key": "Rules", "count": 10 } ],
    "has_fiscal_note": [ { "key": "true", "count": 10 } ],
    "sponsor": [ { "key": "Stonier", "count": 8 } ]
  },
  "page": 1, "size": 20, "total": 10, "took_ms": 23, "backend": "opensearch"
}
```

`direct` is `null` when nothing parsed. When `ambiguous` is true, `candidates` lists `{ bill_key, display, title, biennium, url }` and `url` is null. For `kind: "initiative"` the direct object has `external_url` only.

### 6.2 `GET /search/suggest`

`q` (min 1 char), `biennium`, `size` (≤ 10).

```json
{
  "query": "24",
  "reference": { "kind": "bill", "type": "HB", "number": 24, "confidence": "inferred", "warnings": ["number 24 is outside every known range"] },
  "suggestions": [
    { "kind": "bill", "bill_key": "WA:2025-26:HB2402", "display": "HB 2402", "label": "SHB 2402", "title": "Concerning phthalates in medical equipment used for intravenous purposes.", "status": "in_committee", "url": "/bills/2025-26/HB2402/S" },
    { "kind": "bill", "bill_key": "WA:2025-26:HB2400", "display": "HB 2400", "label": "HB 2400", "title": "…", "status": "in_committee", "url": "/bills/2025-26/HB2400" },
    { "kind": "fiscal_note", "note_id": "fn:int:9f1c…", "display": "SHB 2402", "title": "Fiscal note: SHB 2402 …", "status": "in_review", "url": "/notes/fn:int:9f1c…" }
  ],
  "took_ms": 6
}
```

### 6.3 `GET /bills/resolve`

`ref` (required), `biennium` (default current). Runs `parse` and the resolver from 4.1 without related results.

```json
{
  "input": "ESHB 1234 (2025)",
  "parsed": { "kind": "bill", "biennium": "2025-26", "bienniumExplicit": true, "chamber": "H", "type": "HB", "number": 1234, "versionCode": "S.E", "versionExplicit": true, "confidence": "exact", "warnings": [] },
  "resolved": { "bill_key": "WA:2025-26:HB1234", "version_code": "S.E", "version_label": "ESHB 1234", "url": "/bills/2025-26/HB1234/S.E" },
  "ambiguous": false, "candidates": [], "remainder": ""
}
```

404 with `{ "parsed": …, "resolved": null, "reason": "not_found" }` when the parse succeeded but no bill exists; 400 with `reason: "unparsed"` when the parse failed. The parser also ships to the browser, so the search box calls `parse` locally for the redirect decision and this endpoint only for confirmation.

### 6.4 `POST /search/reindex`

Admin role. Body `{ "scope": "full" | "incremental" | "bill", "bill_keys": [], "indices": [] }`. Returns `202 { "job_id": "…", "status_url": "/api/v1/jobs/…" }`. Full scope builds new physical indices and swaps aliases on completion; the old indices are kept for one run and deleted on the next.

### 6.5 Errors

`400` invalid parameter (including any client-supplied permission field), `401` no session, `403` reindex without admin, `503` `{ "error": "search_unavailable", "backend": "opensearch" }` when the backend health check fails and no fallback is configured.

## 7. Local development

### 7.1 Docker Compose

```yaml
# docker-compose.search.yml
services:
  opensearch:
    image: opensearchproject/opensearch:3.7.0
    container_name: waleg-opensearch
    environment:
      - discovery.type=single-node
      - cluster.name=waleg-dev
      - node.name=os1
      - bootstrap.memory_lock=true
      - "OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g"
      - DISABLE_INSTALL_DEMO_CONFIG=true
      - DISABLE_SECURITY_PLUGIN=true
    ulimits:
      memlock: { soft: -1, hard: -1 }
      nofile: { soft: 65536, hard: 65536 }
    volumes:
      - waleg-os-data:/usr/share/opensearch/data
    ports:
      - "9200:9200"
      - "9600:9600"
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:9200/_cluster/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 12

  opensearch-dashboards:
    image: opensearchproject/opensearch-dashboards:3.7.0
    profiles: ["tools"]
    environment:
      - 'OPENSEARCH_HOSTS=["http://opensearch:9200"]'
      - DISABLE_SECURITY_DASHBOARDS_PLUGIN=true
    ports:
      - "5601:5601"
    depends_on:
      opensearch:
        condition: service_healthy

volumes:
  waleg-os-data:
```

The API reads `SEARCH_BACKEND=opensearch|postgres`, `OPENSEARCH_URL=http://localhost:9200`, `OPENSEARCH_INDEX_PREFIX=waleg_`. With the security plugin disabled the endpoint is plain HTTP without credentials; production uses the security plugin or Amazon OpenSearch Service with IAM auth and TLS, configured through the same two variables plus `OPENSEARCH_AUTH=basic|sigv4`.

Setup: `docker compose -f docker-compose.search.yml up -d`, then `wa-leg search init` (creates indices from `search/indices/*.json` and aliases), then `wa-leg search load --dataset data/WA/2025-2026_Regular_Session`.

Host requirement on Linux: `vm.max_map_count=262144`. Docker Desktop on macOS sets it.

### 7.2 Postgres fallback

The API depends on a `SearchBackend` interface; the OpenSearch and Postgres implementations are swapped by `SEARCH_BACKEND`.

```ts
interface SearchBackend {
  search(req: SearchRequest, principal: Principal): Promise<SearchResponse>;
  suggest(q: string, biennium: string, principal: Principal, size: number): Promise<Suggestion[]>;
  resolve(ref: BillRef | AmendmentRef | SessionLawRef | FnPackageRef, principal: Principal): Promise<Resolution>;
  index(docs: SearchDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  reindex(scope: ReindexScope): Promise<JobId>;
  health(): Promise<{ ok: boolean; backend: string }>;
}
```

Postgres implementation:

- One table `search_docs(id text pk, doc_type text, bill_key text, biennium text, chamber text, status text, committee text, has_fiscal_note bool, fiscal_note_status text, visibility text, allowed_roles text[], allowed_user_ids text[], rcw_cites text[], rcw_chapters text[], rcw_titles text[], sponsor_last_names text[], last_action_date date, title text, heading text, body text, payload jsonb, tsv tsvector generated always as (setweight(to_tsvector('legal', coalesce(title,'')),'A') || setweight(to_tsvector('legal', coalesce(heading,'')),'B') || setweight(to_tsvector('legal', coalesce(body,'')),'C')) stored)`.
- Indexes: GIN on `tsv`; GIN on the array columns; btree on `(biennium, doc_type)`; `pg_trgm` GIN on `title` for suggestions; btree on `bill_key`.
- Text search configuration `legal`: `english` with a `synonym` dictionary file holding the same synonym list (single-word forms; `b&o` handled by rewriting `&` to `and` before `to_tsquery`) and a thesaurus dictionary for multi-word forms.
- Query: `websearch_to_tsquery('legal', q)`; rank with `ts_rank_cd(tsv, query, 32)` multiplied by a per-`doc_type` weight; highlight with `ts_headline('legal', body, query, 'MaxFragments=2, MaxWords=30, StartSel=<mark>, StopSel=</mark>')`; facets with `count(*) ... group by` over the filtered set in one CTE; one hit per bill with `distinct on (bill_key)` ordered by rank.
- Permission filter: `visibility = 'public' or allowed_roles && $roles or $user_id = any(allowed_user_ids)`.
- Suggest: `bill_number ilike $1 || '%'` union `title % $1` ordered by `similarity`.
- Bill-number prefix search on the number itself uses the same `parse` function; nothing in the parser depends on the backend.

Differences the UI tolerates: no fuzzy matching, no phrase slop (Postgres `<->` supports exact adjacency only), facet counts and highlights are cheaper but less precise. The response shape is identical and `backend` reports `postgres`.

## 8. Risks and POC slice

### 8.1 Risks

| Risk | Effect | Mitigation |
|---|---|---|
| lawfilesext HTM layout changes or is missing for some files | Section splitting fails or degrades | Parser tests pinned to cached fixtures; PDF fallback through `pdftotext`; a failed parse indexes one section holding the whole text |
| Budget and omnibus bills (thousands of sections, tens of MB) | Slow parse, large index, long bulk chunks | Stream sections; chunk by byte size; `ignore_above` on keywords; test with the operating budget bill |
| Bare-number ambiguity (`2025`, `1234` across biennia) | Wrong redirect | `inferred` confidence never redirects; cross-biennium candidates are listed |
| Bills carried over between the two session years keep one number; reintroduced bills in a new biennium reuse numbers | Wrong bill when biennium is omitted | Biennium is part of the id; default is the current biennium; older matches appear as candidates |
| Legiscan lag against 48- and 72-hour deadlines | Stale versions and amendments | Hourly API source during session; LSC web service adapter as the production source |
| Synonym list quality | Missed or noisy matches | Synonyms are a versioned file; changes require an index version bump and a relevance test set (`search/relevance/*.json`, 30 queries with expected top hits) |
| Draft-note leakage through facets, highlights, or suggest | Confidentiality | The permission clause is a `filter` in every query including `suggest` and `_msearch` entries; aggregations run inside the filtered set; tests assert a reviewer query never returns another drafter's draft |
| OpenSearch memory on developer machines | Dev friction | 1 GB heap single node; Postgres backend for laptops that cannot run it |
| Amendment header parsing (disposition, number) | Wrong status shown | Header regex tested on a sample of 200 amendments; unknown dispositions are stored as `unknown` |
| Standard tokenizer splits `70A.350.010` | Cite text search misses | Cites are keyword fields extracted at ingest; text-field matching on cites is not relied on |
| `search_as_you_type` and `completion` add index size and heap (completion is in-memory) | Memory | Completion inputs limited to number forms and six title words per bill (3.4k bills, negligible) |

### 8.2 POC slice

1. `@wa-leg/billref` with the parser and the 62-case fixture file; Python port for the loader with the same fixtures.
2. Indices `bills`, `bill_sections`, `amendments`, `fiscal_notes` (OFM metadata plus internal notes). `rcw_sections` built from bill text only; `templates` deferred.
3. Loader from the Legiscan dataset directory with HTM fetch, disk cache, and `change_hash` skip.
4. `GET /search` with the direct-hit path, text path, filters `biennium`, `chamber`, `status`, `committee`, `has_fiscal_note`, `fiscal_note_status`, `assigned_to_me`, and the facets listed; `GET /search/suggest`; `GET /bills/resolve`; `POST /search/reindex`.
5. Search box in the UI: local `parse`, redirect on exact bare references, suggestions dropdown, results page with facets and grouped hits.
6. Permission tests for draft notes across the three roles.
7. `SearchBackend` interface with the OpenSearch implementation; the Postgres implementation is a stub that returns `503 search_unavailable` until built.

Out of the slice: OFM fiscal-note PDF text extraction, RCW current text, LSC API source, relevance tuning beyond the 30-query set, cross-biennium data (only 2025-26 is loaded; the parser and ids already carry the biennium).
