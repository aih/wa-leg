# Washington State legislative data services

Research notes for ingesting bill text, versions, and amendments into a fiscal-note drafting tool. Verified 2026-09-02 against the live services and the LegiScan 2025-2026 Regular Session dataset (3,413 bill JSON files).

## Summary

- The Legislative Service Center (LSC) publishes nine free, unauthenticated web services at `https://wslwebservices.leg.wa.gov/`. Every operation answers plain XML to an HTTP GET with query-string parameters (`/LegislationService.asmx/GetLegislation?biennium=2025-26&billNumber=2402`) and also to SOAP 1.1/1.2 POST. There is no JSON output and no documented rate limit.
- Every bill version, amendment, and session law on `lawfilesext.leg.wa.gov` exists in three parallel trees: `/Pdf/`, `/Htm/`, and `/Xml/`. The XML (namespace `http://leg.wa.gov/2012/document`) is a structured drafting format with typed sections (`BillSection type="amendatory" action="amend"`), parsed RCW cites (`SectionCite/TitleNumber/ChapterNumber/SectionNumber`), and explicit change marks (`TextRun amendingStyle="add|strike"`). The LegiScan dataset links only to the PDF; the XML URL is derived by substituting the path segment and extension.
- Bill reports, bill analyses, digests, and RCW sections have HTM and PDF but no XML.
- The version name in the file name (`2402-S.E`) is the only reliable version identity. LegiScan collapses first, second, and third substitutes into the single type `Comm Sub` and every engrossment into `Engrossed`.
- Page-and-line amendments ("On page 3, after line 17, insert...") refer to page and line numbers that exist only in the PDF layout. The HTM and XML carry no line numbers.
- OFM's public fiscal note search has an undocumented JSON endpoint (`POST /fnspublicsearch/dosearch`) that returns package IDs, bill version, and publication date; PDFs come from `GetPDF?packageID=`. FNS, BEARS, and BATS are login-only systems. No public reference to an "Electronic Bill Book" (EBB) was found.
- Change detection within minutes is feasible by polling LSC: `GetLegislativeStatusChangesByDateRange`, `GetAllDocumentsByClass` (carries `HtmLastModifiedDate` per document; the full 6,405-document Bills class returns in 1.5 s), `GetAmendments?year=`, and `GetRevisedCommitteeMeetings?changedSinceDate=`. `lawfilesext` serves `Last-Modified` and `ETag` headers for conditional GETs.

## Sources and URLs

Verified means the URL was fetched during this research and returned the described content.

| Resource | URL | Status |
|---|---|---|
| LSC web services index and policies | https://wslwebservices.leg.wa.gov/ | Verified |
| LSC detailed service page (last updated 11/13/2006) | https://wslwebservices.leg.wa.gov/lwsDetails.htm | Verified |
| LSC data dictionary (Word) | https://wslwebservices.leg.wa.gov/WebServiceDataDictionary.doc | Verified (converted with `textutil`) |
| LSC WSDL per service | https://wslwebservices.leg.wa.gov/LegislationService.asmx?WSDL | Verified |
| data.wa.gov catalog entry for LWS | https://data.wa.gov/dataset/Legislative-Web-Services-SOAP-API-/2v6q-xjj9 | Unverified (search result only) |
| Bill/amendment file tree | https://lawfilesext.leg.wa.gov/biennium/2025-26/ | Verified; IIS directory listings are enabled |
| Bill summary page | https://app.leg.wa.gov/billsummary?BillNumber=2402&Year=2025&Initiative=false | Verified |
| Bill summary RSS | https://app.leg.wa.gov/billsummary/Home/Rss/2402/2025/House/False | Verified |
| Detailed legislative reports | https://app.leg.wa.gov/bi/ | Verified (HTML) |
| Abbreviations, naming conventions, bill number ranges | https://app.leg.wa.gov/bi/home/helpwithabbreviations | Verified |
| Help with bills (version designations) | https://leg.wa.gov/bills-meetings-and-session/bills/help-with-bills/ | Verified |
| RSS tracking help | https://leg.wa.gov/bills-meetings-and-session/bills/how-to-track-a-bill/bill-tracking-with-rss-feeds/ | Verified |
| Selected Bill Tracking (account required) | https://app.leg.wa.gov/bi/selectedbilltracking | Verified (302 to login) |
| GovDelivery email subscriptions | https://public.govdelivery.com/accounts/WALEG/subscriber/new | Verified (link only) |
| RCW section page | https://app.leg.wa.gov/RCW/default.aspx?cite=82.04.220 | Verified |
| RCW section file tree | https://lawfilesext.leg.wa.gov/law/rcw/ | Verified |
| RCW archive | https://lawfilesext.leg.wa.gov/law/RCWArchive/ | Verified |
| RCW publish currency | https://lawfilesext.leg.wa.gov/law/LawPublishInfo/RcwPublishInfo.xml | Verified |
| OFM fiscal note public search | https://fnspublic.ofm.wa.gov/FNSPublicSearch/Search | Verified |
| OFM fiscal note PDF | https://fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=75952 | Verified |
| OFM FNS description | https://ofm.wa.gov/it-systems/budget-and-legislative-systems/fiscal-note-system-fns | Verified |
| OFM BEARS description | https://ofm.wa.gov/it-systems/budget-and-legislative-systems/bill-enrollment-and-agency-request-system-bears | Verified |
| LEAP fiscal site | https://fiscal.wa.gov/ | Verified (HTML only) |
| LegiScan API manual v1.91 (2025-03-17) | https://api.legiscan.com/dl/LegiScan_API_User_Manual.pdf | Verified (PDF text extracted) |
| LegiScan web pages (legiscan.com/legiscan, /datasets) | https://legiscan.com/legiscan | Unverified (HTTP 403 to scripted fetch) |
| Open States WA scraper | https://raw.githubusercontent.com/openstates/openstates-scrapers/main/scrapers/wa/bills.py | Verified |
| wa-leg-api Python wrapper | https://github.com/j-carson/wa-leg-api | Verified (README) |
| Initiatives list | https://app.leg.wa.gov/billinfo/initiatives.aspx | Fetched; page is a Blazor app and renders no content without a browser |

Things not found on the public web: an "Electronic Bill Book"/EBB; any JSON or XML export of the RCW; any public API for FNS, BEARS, or BATS.

## LSC Web Services catalog

Base: `https://wslwebservices.leg.wa.gov/`. Three transports work on every operation:

- HTTP GET: `/{Service}.asmx/{Operation}?param=value...` returns XML in namespace `http://WSLWebServices.leg.wa.gov/`. Dates are ISO (`2026-02-04T00:00:00`). Errors come back as HTTP 500 with a plain-text message (`Missing parameter: year.`, `GetLegislativeStatusChanges Web Service method name is not valid.`).
- SOAP 1.2 POST to `/{Service}.asmx` with `Content-Type: application/soap+xml` (verified with `GetCurrentStatus`).
- SOAP 1.1 (per the `.asmx` operation pages).

An `Accept: application/json` header is ignored; a JSON-body POST returns HTTP 401. Service names are case-insensitive in the URL. Biennium format is `YYYY-YY` (`2025-26`); data starts at `1991-92`. Support: `WebRequest@leg.wa.gov`; LSC gives 30 days notice of changes when possible and states no SLA. Returned document URLs use `http://` and unencoded spaces (`http://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Bills/House Bills/2402-S.htm`).

| Service | Operations (verified list from the `.asmx` page) | Notes for ingestion |
|---|---|---|
| LegislationService | GetLegislation, GetLegislationByYear, GetLegislationByRequestNumber, GetCurrentStatus, GetHearings, GetSponsors, GetRollCalls, GetRcwCitesAffected, GetSessionLawChapter, GetAmendmentsForBiennium, GetAmendmentsForYear, GetLegislativeStatusChangesByBillId, GetLegislativeStatusChangesByBillNumber, GetLegislativeStatusChangesByDateRange, GetLegislationIntroducedSince, GetLegislationInfoIntroducedSince, GetPrefiledLegislation, GetPreFiledLegislationInfo, GetLegislationPassedHouse/Senate/Legislature (+WithinTimeFrame variants), GetHouseLegislationPassedHouse/Senate, GetSenateLegislationPassedHouse/Senate, GetLegislationGovernorSigned/Veto/PartialVeto, GetPublishedEnrolledLegislation, GetLegislationNotYetIntroducedInHouseOfOrigin, GetLegislationPassedOriginalBodyAndNotIntroducedInOppositeBody, GetLegislationHistoricalRecapCategoriesByLegislationNumber, GetTotalLegislationIntroducedByDateRange, GetLegislationTypes, GetLegislativeBillListFeatureData | `GetLegislation` returns one `<Legislation>` per version (HB 2402 and SHB 2402) with `SubstituteVersion`, `EngrossedVersion`, `Request` (Code Reviser draft number `H-3353.1`), `StateFiscalNote`, `LocalFiscalNote`, `Appropriations`, `RequestedByDepartment`, `CurrentStatus`, `LegalTitle`, `Companions`. |
| LegislativeDocumentService | GetDocumentClasses, GetDocuments, GetDocumentsByClass, GetAllDocumentsByClass | Classes for 2025-26: Amendments, Bill Reports, Bills, Conference Reports, Digests, Initiatives, Reports, Workroom Reports. Each document has `Name`, `Type` (House Bills, Session Laws, ...), `HtmUrl`, `PdfUrl`, `HtmCreateDate`, `HtmLastModifiedDate`, `PdfLastModifiedDate`, `BillId`. No XML URL is returned. |
| AmendmentService | GetAmendments(year) | All amendments offered in a year. Fields: `Name`, `BillId`, `Type` (Floor, Committee, Conference), `FloorNumber`, `SponsorName`, `Description` ("Page 3 Line 17" or "Striker"), `Drafter`, `FloorAction` (ADOPTED, NOT ADOPTED, WITHDRAWN), `FloorActionDate`, `HtmUrl`, `PdfUrl`, `Agency`. |
| CommitteeMeetingService | GetCommitteeMeetings(beginDate,endDate), GetRevisedCommitteeMeetings(changedSinceDate), GetCommitteeMeetingItems(agendaId) | Meetings carry `AgendaId`, `Date` with time, `RevisedDate` with seconds, `Cancelled`. Items carry `BillId`, `HearingType` (Public, Executive, Work Session). |
| CommitteeService | GetCommittees, GetActiveCommittees, GetHouseCommittees, GetSenateCommittees, GetActiveHouseCommittees, GetActiveSenateCommittees, GetCommitteeMembers, GetActiveCommitteeMembers | Committee `Id`, `Acronym` (HCW, WM), `LongName`. |
| CommitteeActionService | GetCommitteeExecutiveActionsByBill, GetCommitteeReferralsByBill, GetCommitteeReferralsByCommittee, GetDoPassByCommittee, GetDoPassSubstituteByCommittee, GetDoPassWithAmendmentsByCommittee, GetDoPassWithAmendmentsToSubByCommittee, GetInCommittee, GetLegislationReportedOutOfCommittee, GetLegislationScheduledHearingsByCommittee, GetMajorityReportByCommittee, GetMinorityReportByCommittee, GetReReferralByCommittee, GetReferredToAnotherCommitteeByCommittee, GetReferredToCommittee, GetRemovedFromCommittee, GetWithoutRecommendationByCommittee | Executive actions include `Recommendation` (DPS, DPA, DNP, w/oRec), `LongRecommendation`, member signatures. |
| RcwCiteAffectedService | GetLegislationAffectingRcw, GetLegislationAffectingRcwCite | `GetLegislationAffectingRcwCite?biennium=2025-26&rcwCite=82.04.4462` returned an empty array; the expected cite format is unverified. |
| SessionLawService | GetSessionLawByBill, GetSessionLawByBillId, GetSessionLawByInitiativeNumber, GetBillByChapterNumber, GetChapterNumbersByYear | `GetSessionLawByBill?biennium=2025-26&billNumber=1069` returns `ChapterNumber` 189, `Year` 2026, `EffectiveDate` 2026-06-11, `MultipleEffectiveDates`, `PartialVeto`, `Veto`. |
| SponsorService | GetSponsors, GetHouseSponsors, GetSenateSponsors, GetRequesters | Member `Id` values match `PrimeSponsorID` and roll-call `MemberId`. |

Example requests and abbreviated responses (all fetched 2026-09-02):

```
GET /legislationservice.asmx/GetLegislation?biennium=2025-26&billNumber=2402
<ArrayOfLegislation xmlns="http://WSLWebServices.leg.wa.gov/">
  <Legislation>
    <Biennium>2025-26</Biennium><BillId>SHB 2402</BillId><BillNumber>2402</BillNumber>
    <SubstituteVersion>1</SubstituteVersion><EngrossedVersion>0</EngrossedVersion>
    <OriginalAgency>House</OriginalAgency><Active>true</Active>
    <StateFiscalNote>true</StateFiscalNote><LocalFiscalNote>false</LocalFiscalNote>
    <Request>H-3353.1</Request><IntroducedDate>2026-02-04T00:00:00</IntroducedDate>
    <CurrentStatus><HistoryLine>Referred to Rules 2 Review.</HistoryLine>
      <ActionDate>2026-02-04T00:00:00</ActionDate><Status>H Rules R</Status></CurrentStatus>
    <Sponsor>HCW(Stonier)</Sponsor><PrimeSponsorID>17279</PrimeSponsorID>
    <LegalTitle>AN ACT Relating to phthalates in medical equipment used for intravenous purposes;</LegalTitle>
  </Legislation>
</ArrayOfLegislation>

GET /legislationservice.asmx/GetRcwCitesAffected?biennium=2025-26&billId=SHB%202402
<RcwCiteAffected><RcwCite>70a </RcwCite><Action>ADD</Action></RcwCiteAffected>
  (note the lowercase title and trailing space; actions seen in the data dictionary: AMD, REP, ADD)

GET /legislationservice.asmx/GetLegislativeStatusChangesByDateRange?biennium=2025-26&beginDate=2026-03-01&endDate=2026-03-02
<LegislativeStatus><BillId>E2SHB 1170</BillId><HistoryLine>WM - Majority; do pass with amendment(s).</HistoryLine>
  <ActionDate>2026-03-02T00:00:00</ActionDate><AmendedByOppositeBody>true</AmendedByOppositeBody>
  <AmendmentsExist>true</AmendmentsExist><Status>C 167 L 26</Status></LegislativeStatus>
  (ActionDate has day granularity; Status is the current status, not the status at that action)

GET /legislationservice.asmx/GetAmendmentsForBiennium?biennium=2025-26&billNumber=6137
<Amendment><Name>6137 AMS CORA S4812.1</Name><BillId>SB 6137</BillId><Type>Floor</Type>
  <FloorNumber>579</FloorNumber><SponsorName>Cortes</SponsorName><Description>Page 3 Line 17</Description>
  <Drafter>S4812.1</Drafter><FloorAction>WITHDRAWN</FloorAction><FloorActionDate>2026-02-11T00:00:00</FloorActionDate>
  <HtmUrl>http://lawfilesext.leg.wa.gov/biennium/2025-26/Htm/Amendments/Senate/6137 AMS CORA S4812.1.htm</HtmUrl></Amendment>
<Amendment><Name>6137 AMH SGOV H3681.1</Name><Type>Committee</Type><SponsorName>State Government &amp; Tribal Relations</SponsorName>
  <Description>Striker</Description><FloorAction>ADOPTED</FloorAction></Amendment>

GET /legislativedocumentservice.asmx/GetDocuments?biennium=2025-26&namedLike=2402
  returns 2402 (Original Bill), 2402 HBA HCW 26 (House Bill Analysis), 2402 HBR HCW 26 (House Bill Report),
  2402-S (Substitute Bill "as Recommended by Health Care & Wellness"), each with HtmUrl/PdfUrl and modified dates.

GET /legislativedocumentservice.asmx/GetAllDocumentsByClass?biennium=2025-26&documentClass=Bills
  6,405 documents, 5.1 MB, 1.5 s. Types: House Bills 2602, Senate Bills 2087, Session Laws 691,
  House Passed Legislature 397, Senate Passed Legislature 313, resolutions and memorials.

GET /legislationservice.asmx/GetHearings?biennium=2025-26&billNumber=2402
  two <Hearing> entries (Public 2026-01-23T08:00, Executive 2026-02-04T13:30) each embedding the CommitteeMeeting.

GET /committeemeetingservice.asmx/GetRevisedCommitteeMeetings?changedSinceDate=2026-03-01
  meetings with <RevisedDate>2026-03-02T08:40:31.32</RevisedDate>.

GET /legislationservice.asmx/GetRollCalls?biennium=2025-26&billNumber=1069
  <RollCall><Motion>3rd Reading &amp; Final Passage</Motion><YeaVotes><Count>78</Count>...</YeaVotes>
  <Votes><Vote><MemberId>31526</MemberId><Name>Abbarno</Name><VOte>Yea</VOte></Vote>...
```

Data dictionary points that matter for parsing: `BillId` is `varchar(14)` of the form `2E2SHB 1000`; `Request` is `H-1000.1`, `S-1002.3`, or `Z-2222.1` (Z = agency/governor request drafts); `SubstituteVersion` has no upper bound "although it is rare to go above 4"; `EngrossedVersion` increments each time the originating body amends the bill on the floor; `Status` is `varchar(15)` (`H3rd Reading`, `SRules G`, `C 189 L 26`); `HistoryLine` is up to 620 characters.

## Bill text formats and markup structure

### File tree

```
https://lawfilesext.leg.wa.gov/biennium/{YYYY-YY}/{Pdf|Htm|Xml}/
  Bills/House Bills/2402.pdf|htm|xml, 2402-S.*, 1163-S2.E.*
  Bills/Senate Bills/6137.*
  Bills/House Passed Legislature/1069.PL.*          (Xml verified for 1069.PL)
  Bills/Senate Passed Legislature/5004-S.PL.*
  Bills/Session Laws/House/1069.SL.*                (Xml verified)
  Bills/Session Laws/Senate/5079.SL.*
  Bills/House Resolutions/4600-Temporary rules.htm  (resolutions and memorials carry a short title after the hyphen; "4603-.htm" when none)
  Bills/House Joint Memorials/..., House Joint Resolutions/..., House Concurrent Resolutions/...
  Amendments/House/6137 AMH SGOV H3681.1.*          (Xml verified)
  Amendments/Senate/6137 AMS CORA S4812.1.*
  Bill Reports/House/2402 HBA HCW 26.htm|pdf        (no Xml; /Xml/Bill Reports/ is 404)
  Bill Reports/Senate/2557-S.E SBR EDU OC 26.*
  Initiatives/Initiatives/INITIATIVE 2066.SL.htm|pdf (no Xml)
  Digests/, Conference Reports/, Reports/, Workroom Reports/
```

Directory listings are plain IIS HTML (`<A HREF="...">1000.htm</A>` with date and size), which is how the Open States scraper enumerates versions. Responses carry `Last-Modified`, `ETag`, and `Content-Length`; Htm and Xml files start with a UTF-8 BOM. XML files are served as `text/xml`.

### XML schema (namespace `http://leg.wa.gov/2012/document`)

Inventory from 31 bill files (2025-26, including PL and SL variants):

Structure

- `Bill[@type="bill"]` > `BillHeading`, `BillBody`.
- `BillHeading`: `RequestNumber` (`H-3353.1`, absent on PL/SL), `ShortBillId` (`SHB 2402`, `HB 1069.SL`), `LongBillId` (`SUBSTITUTE HOUSE BILL 2402`), `Legislature` (`69th Legislature`), `Session` (`2026 Regular Session`), `Sponsors` (free text: `House Health Care & Wellness (originally sponsored by Representatives Stonier, Parshley, Ramel, and Reed)`), `BillHistory` > `PrefiledDate`, `ReadDate` (`READ FIRST TIME 02/04/26.`), `ReferredCommittee`; `BriefDescription`. Engrossed/PL/SL headings add `AsAmended` (`SENATE`) and `PLMessage` > `Message`, `PLSession`.
- `BillBody`: `BillTitle` (the "AN ACT Relating to ...; amending RCW ...; adding a new section to chapter ... RCW; creating new sections; prescribing penalties; providing an effective date; and declaring an emergency." string, unparsed), `EnactedClause` (empty element rendered as "BE IT ENACTED BY THE LEGISLATURE OF THE STATE OF WASHINGTON:"), optional `Part` (`PART I` / heading), then `BillSection` elements.
- `BillSection[@type][@action]`:
  - `type="new"` with no action: NEW SECTION not tied to a chapter (findings, severability, short title).
  - `type="new" action="addsect"`: "A new section is added to chapter 59.18 RCW to read as follows:" — header contains `ChapterCite` > `TitleNumber`, `ChapterNumber`.
  - `type="new" action="addchap"`: "Sections 1 through 3 of this act constitute a new chapter in Title 70A RCW." — `TitleCite`.
  - `type="amendatory" action="amend"`: "RCW 9.46.038 and 2020 c 127 s 11 are each amended to read as follows:" — header contains `SectionCite` > `TitleNumber`, `ChapterNumber`, `SectionNumber`, the session-law history as text, and `Caption` (the RCW section caption). Body ends with `History` (`2020 c 127 s 11.`) and `RCWNoteSection` > `AnnNote` > `NoteP` (the RCW annotations).
  - `type="amendatory" action="remd"`: "are each reenacted and amended".
  - `type="amendatory" action="amenduncod"`: header contains `UncodCite` (`2019 c 297 s 4`) "(uncodified) is amended".
  - `type="new" action="repeal"`: "The following acts or parts of acts are each repealed:" with `P` > `RepealNumber`, `SectionCite`, caption in parentheses, session-law list.
  - `type="new" action="effdate"`: "Sections 2 and 3 of this act take effect July 1, 2026." (`EffectiveDate` also appears as a top-level element in the SL certificate.)
  - `type="new" action="emerg"`: emergency clause ("...takes effect immediately.").
  - `type="new" action="expdate"`: "Section 4 of this act expires January 1, 2031."
- `BillSectionHeader` > `BillSectionNumber` > `TextRun`("Sec. "), `Value` (section number; `Value[@fixed="true"]` marks numbers that must not be renumbered, used in part-numbered bills like 101, 201), `TextRun`(".  "). In new sections the first paragraph is inside the header as `P`.
- `P` is the paragraph unit. Subsection numbering is inline text at the start of the paragraph: `(1)`, `(1)(a)`, `(i)`, `(A)`, `(I)`. There is no structural subsection element; a parser must tokenise the leading `(\d+)|([a-z]+)|([ivx]+)|([A-Z])` markers. `P` attributes: `indent`, `indentStyle="hanging"`, `margin`, `textAlign`, `prePadding`/`postPadding`, `pubwidth="wide"`.
- `TextRun[@amendingStyle]`: `add` (new text, rendered underlined), `strike` (deleted text, rendered `((`line-through`))`), and for deletions spanning paragraphs `strikemarkleft` (opens `((`), `strikemarknone` (middle paragraphs), `strikemarkright` (closes `))`). Other `TextRun` attributes: `fontWeight="bold"`, `fontStyle="italic"`, `fontFamily="Times New Roman"` (used for em dashes in captions), `permanentStyle="underline"`, `readOnly="yes"`.
- Tables: `Table[@width @align @fontSize @pubwidth]` > `Col[@width]`, `THead`, `TR` > `TD[@colspan @rowspan @valign @textAlign]` > `P`. Tax rate tables in revenue bills use this.
- Other: `Hyphen[@type="nobreak"]`, `CrossRefNote`, `RevNote` (reviser's notes), `Caption`.
- Passed-legislature and session-law files wrap the bill: `CertifiedBill[@type="pl"|"sl"]` > `EnrollingCertificate[@type="hBill"]` (with `ChapterLaw[@year]`, `SessionLawCaption`, `EffectiveDate`, `Passage` > `PassedBy[@chamber]` > `PassedDate`, `Yeas`, `Nays`, `Signer`; `Certificate`, `ApprovedDate`, `FiledDate`, `Governor`) then `Bill`, then `SLHistory`. Partial-veto markup was not observed in the sample and is unverified.

Annotated excerpt (SB 6137, section 2, from `Xml/Bills/Senate Bills/6137.xml`):

```xml
<BillSection type="amendatory" action="amend">                       <!-- amends an existing RCW section -->
<BillSectionHeader>
  <BillSectionNumber><TextRun>Sec. </TextRun><Value>2</Value><TextRun>.  </TextRun></BillSectionNumber>
  <SectionCite><TextRun>RCW </TextRun><TitleNumber>9</TitleNumber><TextRun>.</TextRun>
    <ChapterNumber>46</ChapterNumber><TextRun>.</TextRun><SectionNumber>038</SectionNumber></SectionCite>
  and 2020 c 127 s 11 are each amended to read as follows:          <!-- session-law history is loose text -->
  <Caption>Sports wagering<TextRun fontFamily="Times New Roman">—</TextRun>Defined.</Caption>
</BillSectionHeader>
<P>(1)(a) For purposes of this chapter, "sports wagering" means ...</P>   <!-- subsection markers are inline text -->
<P>(i) A professional sport or athletic event;</P>
<P>(2) For purposes of this section:</P>
<P>(a) "Collegiate sport or athletic event" means a sport or athletic event ... beyond the secondary level
  <TextRun amendingStyle="strike">, other than such an institution that is located within the state of Washington</TextRun>
  <TextRun amendingStyle="add">. Sports wagering may not be conducted on the performance or nonperformance of any
  specifically named individual participant ... located within the state of Washington</TextRun>.</P>
<History>2020 c 127 s 11.</History>                                   <!-- RCW history line carried into the bill -->
<RCWNoteSection><AnnNote><NoteP><TextRun fontWeight="bold">Intent—Effective date—2020 c 127:</TextRun>
  See notes following RCW 9.46.0364.</NoteP></AnnNote></RCWNoteSection>
</BillSection>
```

The same passage in the HTM (`Htm/Bills/Senate Bills/6137.htm`):

```html
<div style="margin-top:0.25in;text-indent:0.5in;"><!-- field: BeginningSection -->
  <span style="font-weight:bold;padding-right:0.1in;">Sec. 2.  </span>RCW
  <a href='http://app.leg.wa.gov/RCW/default.aspx?cite=9.46.038'>9.46.038</a> and 2020 c 127 s 11 are each amended to read as follows:<!-- field: --></div>
<div style="text-indent:0.5in;"><!-- field: Text -->(1)(a) For purposes of this chapter, ...</div>
<div style="text-indent:0.5in;">(a) "Collegiate sport or athletic event" means ... beyond the secondary level((<span style="text-decoration:line-through;">, other than such an institution that is located within the state of Washington</span>))<span style="text-decoration:underline;">. Sports wagering may not be conducted ...</span>.</div>
```

HTM characteristics: one `<div>` per paragraph with inline styles only; the only style vocabulary is `font-weight:bold`, `text-decoration:underline`, `text-decoration:line-through`, `text-indent:0.5in`, `text-align:center`, and margins; field markers are HTML comments (`<!-- field: Sponsors -->`, `CaptionsTitles`, `BeginningSection`, `Text`); new sections start with `<span style="text-decoration:underline;">NEW SECTION.</span>`; RCW cites are hyperlinked to `app.leg.wa.gov/RCW/default.aspx?cite=`; the double parentheses around struck text are literal characters; the file ends with `--- END ---`. The HTM is adequate for display and for diffing plain text, but section type, RCW cite parts, and multi-paragraph strike boundaries are only explicit in the XML.

Bill reports and analyses (`2402 HBA HCW 26.htm`) are exported rich-text HTML (TinyMCE classes such as `briefSummary`, `committeeTitle`) with no field markers. They contain the staff summary, fiscal note status, and hearing testimony summary.

## Naming conventions

### Bill number ranges (from app.leg.wa.gov/bi/home/helpwithabbreviations, confirmed by the LegiScan dataset)

| Prefix | Type | Range | Dataset count 2025-26 |
|---|---|---|---|
| HB | House Bill | 1000-3999 | 1749 |
| HJM | House Joint Memorial | 4000-4199 | 18 |
| HJR | House Joint Resolution (constitutional amendment) | 4200-4399 | 14 |
| HCR | House Concurrent Resolution | 4400-4599 | 9 |
| HR | House Resolution | 4600-4999 | 115 |
| SB | Senate Bill | 5000-7999 | 1364 |
| SJM | Senate Joint Memorial | 8000-8199 | 17 |
| SJR | Senate Joint Resolution | 8200-8399 | 13 |
| SCR | Senate Concurrent Resolution | 8400-8599 | 11 |
| SR | Senate Resolution | 8600-8999 | 103 |
| SGA | Senate Gubernatorial Appointment | 9000-9999 | not in LegiScan |
| I / IL | Initiative to the People (`INITIATIVE 2066`) / to the Legislature (`INITIATIVE IL26-001`) | separate series | not in LegiScan |

LSC `ShortLegislationType` values: B, CR, JM, JR, R, GA, I. LegiScan `bill_type` values in the dataset: B 3113, R 218, JM 35, JR 27, CR 20.

A number is assigned once per biennium. Bills that do not pass in the odd-year session carry over to the even-year session with the same number and version ("By resolution, reintroduced and retained in present status." appears 1,518 times in the 2025-26 history data). `GetLegislationByYear?year=2026` therefore lists 1000-series bills introduced in 2025. Substitutes and engrossments do not change the number; they change the prefix.

### Version designations

| File name | BillId | Meaning |
|---|---|---|
| `2402` | HB 2402 | As introduced |
| `2402-S` | SHB 2402 | Substitute (committee-recommended replacement text) |
| `1163-S2` | 2SHB 1163 | Second substitute (a later committee, usually fiscal) |
| `1163-S3` | 3SHB 1163 | Third substitute |
| `2402.E` | EHB 2402 | Engrossed (floor amendments in house of origin folded in) |
| `1163-S2.E` | E2SHB 1163 | Engrossed second substitute |
| `1008-S2.E2` | 2E2SHB 1008 | Second engrossment of second substitute |
| `1069.PL`, `1163-S2.PL` | (Passed Legislature) | Text as passed both houses, before governor action; includes opposite-house amendments |
| `1069.SL`, `1163-S2.SL` | C 189 L 26 | Session law; adds chapter number, effective date, governor signature block |
| `1000-S.DIG` | | Digest (data dictionary example) |
| `INITIATIVE 2066.SL` | | Initiative enacted |

Order of a version's life: `N` → `N-S` → `N-S.E` (or `N-S2` then `N-S2.E`) → `N-S.E.PL` is not used; PL and SL names drop the `.E` and keep only the substitute suffix (`1163-S2.PL`, `5004-S.PL` whose friendly name is "Engrossed Substitute Senate Bill 5004 ... as passed by the Legislature"). The PL/SL files therefore do not encode engrossment in the file name; `GetLegislation` `EngrossedVersion` or the `LongBillId` element does.

Observed 2025-26 House Bills directory (2,602 HTM files): `N.htm` 1748, `N-S.htm` 556, `N-S2.htm` 123, `N-S.E.htm` 88, `N.E.htm` 37, `N-S2.E.htm` 37, `N-S3.htm` 8, `N-S3.E.htm` 3, `N-S.E2.htm` 2.

Regex-friendly grammar:

```
bill_number   := [1-9][0-9]{3}
version_file  := bill_number ( '-S' [2-9]? )? ( '.E' [2-9]? )? ( '.PL' | '.SL' )?
bill_id       := ( [2-9]? 'E' )? ( [2-9]? 'S' )? ( 'HB'|'SB'|'HJM'|'SJM'|'HJR'|'SJR'|'HCR'|'SCR'|'HR'|'SR' ) ' ' bill_number

Python:
VERSION_FILE = re.compile(r'^(?P<num>\d{4})(?:-S(?P<sub>\d)?)?(?:\.E(?P<eng>\d)?)?(?:\.(?P<stage>PL|SL))?$')
BILL_ID      = re.compile(r'^(?:(?P<eng>\d)?E)?(?:(?P<sub>\d)?S)?(?P<type>HB|SB|HJM|SJM|HJR|SJR|HCR|SCR|HR|SR) (?P<num>\d{4})$')
```

with `sub` absent meaning "not a substitute", `sub` None-with-`-S` meaning first substitute, and the same for `eng`. Resolutions and memorials append `-` plus a short title to the file name (`4600-Temporary rules`, `8000-Const. conv. applications`); strip everything from the first `-` that is not followed by `S\d?` before applying the grammar.

Prefix mapping House/Senate directory: House Bills, House Joint Memorials, House Joint Resolutions, House Concurrent Resolutions, House Resolutions, and the Senate equivalents; PL files live in `House Passed Legislature` / `Senate Passed Legislature`; SL files in `Session Laws/House` / `Session Laws/Senate`, keyed by the originating chamber.

### Amendment names

Pattern: `{version_file} {AMH|AMS|AMC} {SPONSOR} {DRAFTER}`.

- `AMH` House amendment, `AMS` Senate amendment, `AMC` conference amendment.
- `SPONSOR` is a four-letter member code (`CORA` Cortes, `ORCU` Orcutt, `STOK` Stokesbary, `WALJ` Walsh, `DUFA` Dufault), a committee acronym (`SGOV`, `HCW`, `APP`, `WM`, `HLTC`), or `ENGR` for the engrossing amendment.
- `DRAFTER` is either a Code Reviser draft number `H3681.1` / `S4812.1` (letter for the requesting chamber, sequence, `.` version; `H3830.E` observed for an engrossed amendment) or a caucus-staff code plus set number `TAYT 607`, `HARO 697`, `MYES 010`.

```
AMEND_NAME = re.compile(r'^(?P<bill>\d{4}(?:-S\d?)?(?:\.E\d?)?) (?P<house>AMH|AMS|AMC) (?P<sponsor>[A-Z]{2,4}) (?P<drafter>[HS]\d{3,4}\.(?:\d+|E)|[A-Z]{4} \d{3})$')
```

LSC exposes the same parts as `Name`, `Drafter`, `SponsorName`, `FloorNumber` (the "H AMD 2663" / "S AMD 579" rostrum number), and `Type`. LegiScan puts the sponsor surname and the full name string in `amendments[].description` (`"Cortes 6137 AMS CORA S4812.1"`) and classifies `title` as House/Senate Floor, Committee, Engrossed, or Conference Amendment with an `adopted` flag.

## Amendment document structure

Three shapes appear in the XML (`Amendment[@type="amendment"]`):

Header, common to all: `AmendTitle` > `BillName`, `AmendType` (AMH/AMS), `SponsorAcronym`, `DraftNumber`; `AmendBody` > `AmendSection` > `SectionHeading` > `ReferenceNumber` (`SB 6137`), `AmendType` (`S AMD`, `H AMD`, `H COMM AMD`), `AmendNumber` (floor number, empty for committee amendments), `Sponsors` (`By Senator Cortes`, `By Committee on State Government & Tribal Relations`), `FloorAction` (`WITHDRAWN 02/11/2026`, `ADOPTED 03/06/2026`, `NOT ADOPTED 03/12/2026`).

1. Striking amendment ("striker"). One `AmendItem` whose first `P` is `Strike everything after the enacting clause and insert the following:` followed by a complete set of `BillSection` elements (same markup as a bill, with the opening quotation mark before the first section and a closing mark after the last), then an `AmendItem` reading `Correct the title.` The adopted striker's body is the text of the next engrossed version.
2. Page-and-line amendment. Each `AmendItem` is an instruction paragraph such as `On page 3, after line 17, insert the following:`, `On page 2, at the beginning of line 25, strike all material through "2026." on line 26`, `Beginning on page 11, line 25, after "2015" strike all material through "center))" on page 12, line 21 and insert "..."`, `Renumber the remaining sections consecutively and correct any internal references accordingly.`, `On page 1, line 2 of the title, after "9.46.0364," strike "and 9.46.0368" and insert "9.46.0368, and 9.46.037"`. Inserted sections appear as nested `BillSection` with `amendingStyle` marks relative to current law. Page and line numbers refer to the numbered lines of the target version's PDF; the HTM and XML of the bill have no line numbers, so applying a page-and-line amendment mechanically requires the PDF's line layout (or a text-anchor heuristic using the quoted words).
3. Committee amendment and engrossing amendment: same as 1 or 2 with `AmendType` `H COMM AMD` and committee sponsor.

Every amendment ends with `Effect` > `P` beginning `EFFECT:` (staff-written plain-language summary, sometimes with bullet `P` elements). The HTM mirrors this with the same inline-style vocabulary as bills. The LegiScan dataset carries only the amendment PDF link plus adopted flag; the LSC `GetAmendments` list adds `FloorAction`, date, and the "Page 3 Line 17" / "Striker" classification.

## Fiscal note public data (OFM FNS)

FNS (`fns.ofm.wa.gov`) is login-only for agencies, OFM, and legislative staff. The public side is `https://fnspublic.ofm.wa.gov/FNSPublicSearch/Search` (an older URL `fortress.wa.gov/ofm/fnspublic/` is still referenced on ofm.wa.gov). The search page is a jQuery DataTables app backed by two undocumented endpoints:

```
POST https://fnspublic.ofm.wa.gov/fnspublicsearch/dosearch
     SessionYear=69&BillNumber=2402&BillTitle=&RequestType=      (SessionYear is the legislature number: 69 = 2025-26; "all" for initiatives)
→ {"data":[
     {"packageId":75952,"SessionYear":"2026","ProposedFlag":"N","BillId":"2402 HB","BillNumber":"2402 HB",
      "BillTitle":"Phthalates/medical equipment","PublishedDate":"/Date(1769720908460)/","BillType":"Final",
      "RequestType":"B","AmendmentName":" ","EngrossedNotation":"  ","SustituteNotation":"  ","Qualifier":"  ","Origin":"H"},
     {"packageId":76263,...,"BillType":"Revised",...}]}

POST https://fnspublic.ofm.wa.gov/fnspublicsearch/getbillnumbers
     session=69&requestType=
→ [{"Text":"1001","Value":"1001"},...]                             (bills that have any fiscal note)

GET  https://fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=75952   → application/pdf (263 KB)
GET  https://fnspublic.ofm.wa.gov/FNSPublicSearch/Search/bill/2402/69       → search page prefilled (linked from billsummary)
```

`BillType` values seen: Final, Revised, Partial. `EngrossedNotation` / `SustituteNotation` (sic) identify the bill version the note was prepared for; `AmendmentName` is populated for notes on amendments; `ProposedFlag` and `RequestType` distinguish proposed-substitute and bill requests. LegiScan mirrors these as `supplements[].type == "Fiscal Note"` with `description` such as `2402 HB (Final)` and `state_link` to `GetPDF?packageID=` (5,761 fiscal-note supplements in the dataset; `date` populated). The fiscal note content itself is only in the PDF (agency sections, cash receipts and expenditure tables, assumptions); no structured export exists publicly. The endpoints above are unofficial and could change without notice.

BEARS (`bears.ofm.wa.gov`) handles agency request legislation, agency bill analyses, and enrolled-bill recommendations; it is login-only with no public interface or API. BATS (Bill Analysis and Tracking System) is the same family. The LSC `Legislation` record exposes `StateFiscalNote`, `LocalFiscalNote`, `Appropriations`, and `RequestedByDepartment`/`Governor`/`BudgetCommittee` flags. fiscal.wa.gov (LEAP) publishes budgets and budget bills, not bill-level fiscal data, and exposes no API.

## RCW data access

- Section HTML: `https://app.leg.wa.gov/RCW/default.aspx?cite=82.04.220` (chapter: `?cite=82.04`; title: `?cite=82`). Adding `&pdf=true` returns the section PDF. Repealed or decodified cites redirect to `dispo.aspx?cite=...`. Page markup: `<h1><!-- field: Citations -->RCW  82.04.220<!-- field: --></h1>`, `<h2><!-- field: CaptionsTitles -->Business and occupation tax imposed.<!-- field: --></h2>`, then `<div id='contentWrapper' class='section-page'>` with one `<div style="text-indent:0.5in;">` per paragraph (same inline-marker convention as bills), then the history block `[ 2021 c 145 s 5; 2019 c 8 s 103; ... ]` where each cite links to the session-law PDF (`.../Session Laws/Senate/5251-S.SL.pdf?cite=2021 c 145 s 5`), then notes.
- Static files: `https://lawfilesext.leg.wa.gov/law/rcw/RCW  82  TITLE/RCW  82 . 04  CHAPTER/RCW  82 . 04 .220.htm` (title padded to width 3 with spaces, chapter and section separated by ` . `; the chapter index is `RCW  82 . 04  CHAPTER.htm`). `/law/RCWPDF/` holds the same tree as PDF, `/law/RCW Supplement/` the interim supplement, `/law/RCWArchive/{2023,2024,2025,2026}/` yearly snapshots (HTM per chapter, `pdf/` subtree, `Dispositions.pdf`), and `/law/RCWArchive/RCWTitleOnlyList.txt` the title list. `/law/LawPublishInfo/RcwPublishInfo.xml` reports `CurrencyDate` (July 15, 2026 at the time of research); the RCW is republished twice a year.
- No XML or JSON edition of the RCW was found on lawfilesext or app.leg.wa.gov. Bills carry the amended RCW text themselves (the full section with strike/add marks), so a redline view does not need a separate RCW fetch; a "current law" side panel does, via the section HTM.
- Cite references: bills write `RCW 82.04.220`, `chapter 82.04 RCW`, `Title 82 RCW`, and session laws as `2021 c 145 s 5` or `2013 2nd sp.s. c 2 s 2`. In XML these are `SectionCite`, `ChapterCite`, `TitleCite`, `UncodCite`; in HTM the numeric part is hyperlinked. `GetRcwCitesAffected` returns the cite and an action code (ADD, AMD, REP) per bill version.

## Change detection strategy

Timing facts:

- LSC `ActionDate` fields have day granularity. Committee meetings carry `RevisedDate` with seconds. `LegislativeDocument` records carry `HtmLastModifiedDate`/`PdfLastModifiedDate` with milliseconds (`2026-02-05T14:06:24.25` for `2402-S`, one day after the committee vote).
- `lawfilesext` sends `Last-Modified` and `ETag`.
- LegiScan datasets refresh weekly; API `getMasterListRaw` is rated for hourly polling and `getBill` for every 3 hours; public keys are limited to 30,000 queries per month; the Push API (webhooks, `last_push` and a `reasons` array of 25 change flags) is a paid subscription. The recommended LegiScan workflow is bulk-load a dataset, then poll `getMasterListRaw`, compare each `change_hash`, and call `getBill` for changed bills. `getBillText`, `getAmendment`, `getSupplement` return the document base64-encoded (PDF for Washington).
- Per-bill RSS: `https://app.leg.wa.gov/billsummary/Home/Rss/{number}/{year}/{House|Senate}/{False}` returns RSS 2.0 with one item per history line (`04 - January 23, 2026 - Public hearing in the House Committee on Health Care & Wellness at 8:00 AM.`), `pubDate` at day granularity. The bill summary page also offers "Get Email Notifications" (GovDelivery, with an immediate-delivery option per the Legislature's help text) and the account-based Selected Bill Tracking app. Neither is machine-consumable beyond RSS.
- Open States scrapes LSC on its own schedule; it adds no freshness over calling LSC directly.

Polling plan for a tool that must notice a substitute, an engrossment, an amendment, or a hearing within minutes during session:

1. Every 5 minutes: `GetAllDocumentsByClass?biennium=2025-26&documentClass=Bills` and `...documentClass=Amendments`; diff `Name` + `HtmLastModifiedDate` against the stored set. A new `2402-S` or a modified `5004-S.PL` record is the earliest public signal of a new version. Fetch the `/Xml/` file with `If-None-Match`.
2. Every 5 minutes: `GetLegislativeStatusChangesByDateRange?biennium=2025-26&beginDate={today}&endDate={tomorrow}`; diff on (`BillId`, `HistoryLine`, `ActionDate`). This yields committee actions ("HCW - Majority; 1st substitute bill be substituted, do pass."), referrals, floor passage, and governor action.
3. Every 5 minutes: `GetRevisedCommitteeMeetings?changedSinceDate={last_poll}` then `GetCommitteeMeetingItems?agendaId=` for changed agendas; this covers scheduled, moved, and cancelled hearings for tracked bills. `GetHearings?billNumber=` gives the per-bill view.
4. Every 15 minutes: `GetAmendments?year=2026` (full year list, a few thousand rows) diffed on `Name` + `FloorAction`; this captures adoption/withdrawal, which the document list does not.
5. Every 15 minutes: `GetLegislationIntroducedSince?sinceDate=` for new bills and new substitute versions (each substitute is a separate `Legislation` row with its own `IntroducedDate`).
6. Daily: FNS `dosearch` per tracked bill (or `getbillnumbers` for the session) for new fiscal note packages.
7. Weekly: LegiScan dataset refresh as reconciliation for sponsors, votes, and LegiScan IDs.

`GetLegislativeStatusChangesByBillNumber` and the per-bill RSS feed are the fallbacks when a specific bill needs confirmation.

## Recommended ingestion pipeline for the proof of concept

Index: LegiScan JSON (`bill/*.json`). Use `bill_id`, `bill_number`, `title`, `sponsors`, `history`, `calendar`, `votes`, `referrals`, `texts[]`, `amendments[]`, `supplements[]`, and `change_hash`. Treat `texts[].type` as a coarse label and derive the real version from the `state_link` file name with `VERSION_FILE`. Note that `texts[].date` is `0000-00-00` for 2,843 of 3,440 introduced texts and for every substitute, engrossed, PL, and SL text; take dates from LSC `GetLegislation` (`IntroducedDate` per version) or `GetDocuments` (`HtmCreateDate`).

Text fetch: map each `texts[].state_link` to XML by replacing `/Pdf/` with `/Xml/` and `.pdf` with `.xml` (verified for original, substitute, engrossed, PL, and SL bills and for amendments). Keep the PDF URL for page-and-line resolution and display. Bill reports, digests, and initiatives use `/Htm/`.

Parse to structured JSON:

```
BillVersion {
  bill_number, version_file ("2402-S"), bill_id ("SHB 2402"), substitute: int, engrossed: int, stage: null|"PL"|"SL",
  heading: {request_number, long_id, legislature, session, sponsors_text, read_first_time, prefiled, referred, brief_description},
  title: "AN ACT Relating to ...",          // split on ';' to get amending/adding/repealing/effective-date/emergency clauses
  parts: [{label, heading}],
  sections: [{
    number, fixed: bool, kind: "new"|"amendatory", action: "addsect"|"addchap"|"amend"|"remd"|"amenduncod"|"repeal"|"effdate"|"emerg"|"expdate"|null,
    cite: {title, chapter, section} | {chapter} | {title} | {uncodified}, history_text, caption,
    paragraphs: [{ marker_path: ["(2)","(a)"], runs: [{text, style: null|"add"|"strike"}] }],
    repealed: [{cite, caption, history}], rcw_notes: [...]
  }],
  certificate: {chapter, year, effective_date, passed_house: {date,yeas,nays}, passed_senate: {...}, approved, filed}   // PL/SL only
}
Amendment {
  name, bill_version_file, chamber, sponsor_code, drafter, floor_number, type: "striker"|"page_line"|"committee",
  floor_action, floor_action_date, items: [{instruction_text, page, line, anchor_quote, inserted_sections: [Section]}], effect_text
}
```

Enrich from LSC per bill: `GetLegislation` (versions, request numbers, fiscal-note flags), `GetRcwCitesAffected` per `BillId`, `GetAmendmentsForBiennium`, `GetHearings`, `GetSessionLawByBill`. Enrich from FNS `dosearch` for note packages and from the bill report HTM for the staff summary.

Version comparison: diff the parsed section list of two versions by section cite (amendatory sections keyed on RCW cite, new sections keyed on order and first-sentence similarity); within a section diff paragraph runs. The redline the Legislature itself prints (strike/add against current law) is already in every amendatory section, so "bill vs. current law" needs no diff, and "version A vs. version B" is a diff of two already-marked texts.

Fallbacks:

- If the XML is missing or fails to parse (older bienniums, some resolutions), parse the HTM using the inline-style vocabulary (`line-through` = strike, `underline` = add, `NEW SECTION.` span, `Sec. N.` bold span, `text-indent` divs as paragraphs).
- If only PDF exists (fiscal notes, bill reports before the HTM era, page-and-line resolution), extract text with a layout-preserving tool and keep line numbers from the left margin.
- If LSC is unavailable, fall back to LegiScan `getMasterListRaw`/`getBill` (hourly/3-hourly cadence, 30,000 queries per month) and the per-bill RSS feed.

## Open items

- Confirm the accepted cite format for `RcwCiteAffectedService.GetLegislationAffectingRcwCite`.
- Confirm partial-veto markup in SL XML (no vetoed bill was sampled).
- Confirm whether FNS `dosearch` accepts a bill-version filter or only bill number.
- Identify what the DOR RFP means by "Electronic Bill Book"; nothing public matches the name.
- Digests (`Digests` document class) exist in LSC's class list but the 2025-26 `Htm/Digests/House/` listing was empty.
