# Legiscan dataset profile: WA 2025-2026 Regular Session

Source file: `WA_2025-2026_Regular_Session_JSON_20260401_abdf16b3217bbab20694ab26954b12a4.zip` (14 MB). Unpacks to `WA/2025-2026_Regular_Session/{bill,people,vote}/` plus `hash.md5`, `README.md`, `LICENSE`. Each bill is one JSON file named by bill number (`HB2402.json`) containing the `getBill` API payload under the `bill` key. People are keyed by `people_id`, roll calls by `roll_call_id`.

## Counts

| Object | Count |
|---|---|
| Bills (all types) | 3,413 |
| HB / SB | 1,749 / 1,364 |
| HR / SR (simple resolutions) | 115 / 103 |
| HJM / SJM, HJR / SJR, HCR / SCR | 35, 27, 20 |
| Text documents (`texts[]`) | 6,429, all `application/pdf` |
| Amendments (`amendments[]`) | 4,127, all PDF; 462 adopted |
| Fiscal note supplements | 5,761 on 2,351 bills |
| Misc supplements (bill reports, bill analyses) | 11,123 |
| Bill number ranges | House 1000-3992, Senate 5000-7991 |

Bills with two or more text versions: 1,373. Bills with no text: 2.

## Bill object fields used by the POC

| Field | Use |
|---|---|
| `bill_id`, `change_hash` | Stable Legiscan id; change detection on re-import |
| `session.{session_id,year_start,year_end,session_name}` | Biennium `2025-26` |
| `bill_number`, `bill_type`, `body`, `current_body` | Identity and chamber |
| `title`, `description` | Short title ("Concerning ...") |
| `status` (1 introduced, 2 engrossed, 3 enrolled, 4 passed, 5 vetoed; 0 unknown), `status_date`, `progress[]` | Status timeline |
| `committee`, `referrals[]`, `pending_committee_id` | Current and past committees |
| `history[]` `{date, action, chamber, importance}` | Action log; hearing and substitute events are in the action text |
| `calendar[]` `{type, date, time, location, description}` | Hearings and executive sessions, the basis for the 4-hour deadline |
| `sponsors[]` | Prime and co-sponsors with `people_id`, party, district |
| `texts[]` `{doc_id, type, type_id, mime, url, state_link, text_hash}` | Versions. Types: Introduced, Comm Sub, Engrossed, Enrolled, Chaptered |
| `amendments[]` `{amendment_id, adopted, chamber, title, description, state_link, amendment_hash}` | Amendments. Titles: House/Senate Floor, Committee, Engrossed, Conference Amendment |
| `supplements[]` `{supplement_id, type, title, description, state_link}` | Fiscal notes (OFM FNS PDFs) and bill reports |
| `votes[]` | Roll call summaries, details in `vote/` |
| `sasts[]` | Companion bills (`Crossfiled`, 1,168 links) |
| `state_link` | `https://app.leg.wa.gov/billsummary?BillNumber=2402&Year=2025&Initiative=false` |

`subjects[]` is empty for every bill in this dataset. `texts[].date` is `0000-00-00` throughout; version ordering must come from `type` and the file name.

## Version codes derived from `texts[].state_link`

The PDF file name at `lawfilesext.leg.wa.gov/biennium/2025-26/Pdf/Bills/{House|Senate} Bills/` carries the version suffix. Legiscan's `type` is coarser than the suffix.

| Suffix | Legiscan type | Meaning | Display prefix |
|---|---|---|---|
| (none) | Introduced | As introduced | HB / SB |
| `-S` | Comm Sub | First substitute | SHB / SSB |
| `-S2`, `-S3` | Comm Sub | Second, third substitute | 2SHB, 3SHB |
| `.E` | Engrossed | Engrossed original | EHB / ESB |
| `-S.E`, `-S2.E`, `-S3.E` | Engrossed | Engrossed substitute | ESHB, E2SHB, E3SHB |
| `-S.E2` | Engrossed | Second engrossed substitute | 2ESHB |
| `.PL`, `-S.PL`, `-S2.PL` | Enrolled | Passed legislature | (same prefix as the passed version) |
| `.SL`, `-S.SL`, `-S2.SL` | Chaptered | Session law | Chapter N, Laws of YYYY |

Counts: 3,160 introduced, 1,060 `-S`, 178 `-S2`, 10 `-S3`, 72 `.E`, 190 `-S.E`, 62 `-S2.E`, 6 `-S.E2`, 3 `-S3.E`, 612 `.PL` variants, 690 `.SL` variants.

Resolutions (HR, SR, and some memorials) use topic-named files such as `4601-Apple blossom festival.pdf`, and 56 introduced bills have a bare `-` suffix. The parser must treat anything after the number that is not a recognized version suffix as a title fragment and fall back to Legiscan `type` for the version.

The HTM version of each text is expected at the parallel path `.../Htm/Bills/House Bills/2402-S.htm`. The leg-wa-gov services report covers verification of this and of XML availability.

## Fiscal note supplements

Descriptions follow `{number} {version prefix} ({Partial|Final|Revised})`, with amendment-specific notes such as `6137 SB AMH SGOV H3681.1 (Partial)`. Links are `https://fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=NNNNN`. A package is the multi-agency fiscal note bundle for one bill version; DOR's note is one agency section within it. Counts by pattern: HB Final 1,269; SB Final 1,037; HB Partial 523; SB Partial 420; SHB Final 348; SSB Final 319; Revised 247.

## Amendments

Description format: `{sponsor or committee} {number}[-S] {AMH|AMS} {CODE} {H|S}{drafter number}.{n}`, for example `Cortes 6137 AMS CORA S4812.1`. The PDF file name is `{number}[-S] {AMH|AMS} {CODE} {H|S}NNNN.N.pdf` under `.../Pdf/Amendments/{House|Senate}/`. `adopted` is 1 for 462 of 4,127.

## History action vocabulary

The most frequent actions, with digits replaced by N, give the event types the workflow module reacts to:

- `First reading, referred to {Committee}.`
- `Public hearing in the {House|Senate} Committee on {Committee} at N:NN AM.`
- `Executive action taken in the ... Committee on ...`
- `Nst substitute bill substituted` (a new version exists)
- `Floor amendment(s) adopted` / `Committee amendment`
- `Rules suspended. Placed on Third Reading.` / `Third reading, passed; yeas, N; nays, N...`
- `Delivered to Governor.` / `Governor signed.` / `Chapter N, N Laws.` / `Effective date N/N/N.`
- `By resolution, reintroduced and retained in present status.` (start of the second year)

Fiscal committees appearing most often: Senate Ways & Means, House Appropriations, House Finance, House Transportation.

## Ingest implications

- Identity: `(biennium, bill_number)` from the session and `bill_number`; keep `bill_id` and `change_hash` for reconciliation.
- Versions: derive `version_code` from the state link file name; order by the natural sequence introduced → substitutes → engrossed → passed legislature → session law.
- Text: fetch HTM (or XML if available) per version; PDF is the fallback with text extraction.
- Amendments: parse the description into sponsor, base version, chamber, drafter id; fetch the PDF or HTM.
- Fiscal notes: keep supplement links as "prior fiscal notes" references on the bill (useful for the drafter and for clone-from-prior).
- Hearings: `calendar[]` gives the hearing date and time used to compute the "4 hours before hearing" due date.
- Refresh: Legiscan publishes weekly dataset snapshots and an API with `change_hash`; re-import compares hashes and only re-fetches changed bills.
