# Published notes API

Read access to published fiscal notes for a downstream consumer: a feed of every published note and four
export formats per note. All paths are under `/api/v1` on the API origin (`PUBLIC_API_ORIGIN`, default
`http://localhost:4800`).

## Authentication

Signed-in users of any role may read the feed and the exports. A session cookie or a bearer token
(`Authorization: Bearer <token>`) identifies the user; `pnpm wa-leg token --user dev-committee` prints a
token for a seeded user.

`PUBLISHED_PUBLIC=true` in the API environment allows anonymous requests to `GET /published` and to the
export route of a published note. The default is `false`, and anonymous requests then receive `401`.

## GET /published

Published notes, newest first by `publishedAt`. A note appears once, at the moment it is published, and
never changes afterwards.

### Request

```
GET /api/v1/published?limit=50&cursor=<nextCursor>
```

| Query | Type | Default | Meaning |
|---|---|---|---|
| `limit` | integer 1..200 | 50 | Items per page |
| `cursor` | string | none | The `nextCursor` of the previous page |

A `limit` above 200 or a cursor that did not come from this feed returns `400`.

### Response

```
200 { items: PublishedNote[], nextCursor: string | null }
```

Each item:

| Field | Type | Meaning |
|---|---|---|
| `revisionId` | string (UUID) | The note revision; the id in the export URLs |
| `bill.biennium` | string | `2025-26` |
| `bill.billId` | string | `HB2402` |
| `bill.number` | string | `2402` |
| `bill.title` | string | The bill's title |
| `versionCode` | string | Bill version the note is written for: `I` (introduced), `S`, `S2`, `E`, `S.E`, ... |
| `versionLabel` | string | The version's short label: `SHB 2402` |
| `title` | string | The note's title: `SHB 2402 Fiscal Note` |
| `publishedAt` | string | ISO 8601 timestamp of the publication |
| `publishedBy.userId` | string | The reviewer who published |
| `publishedBy.displayName` | string | The reviewer's display name |
| `publishedVersion` | integer | The document version that was published |
| `exports.pdf` | string | Absolute URL of the PDF export |
| `exports.docx` | string | Absolute URL of the DOCX export |
| `exports.html` | string | Absolute URL of the HTML export |
| `exports.xml` | string | Absolute URL of the FNS XML export |

### Paging

`nextCursor` is an opaque string when more items exist and `null` on the last page. Pass it back as
`cursor` to fetch the next page. Items are ordered by `publishedAt` descending, then `revisionId`
descending; the cursor names the last item of the page, so an item published while paging appears on a
later fetch of the first page and never inside an existing page.

### Example

```
GET /api/v1/published?limit=2
```

```json
{
  "items": [
    {
      "revisionId": "5f1c2b1e-9a4d-4b7e-8c1f-2a3b4c5d6e7f",
      "bill": { "biennium": "2025-26", "billId": "HB2402", "number": "2402", "title": "Concerning a sales and use tax exemption for ..." },
      "versionCode": "S",
      "versionLabel": "SHB 2402",
      "title": "SHB 2402 Fiscal Note",
      "publishedAt": "2026-09-03T18:22:41.512Z",
      "publishedBy": { "userId": "dev-reviewer", "displayName": "Rae Reviewer" },
      "publishedVersion": 4,
      "exports": {
        "pdf": "http://localhost:4800/api/v1/notes/5f1c2b1e-9a4d-4b7e-8c1f-2a3b4c5d6e7f/export?format=pdf",
        "docx": "http://localhost:4800/api/v1/notes/5f1c2b1e-9a4d-4b7e-8c1f-2a3b4c5d6e7f/export?format=docx",
        "html": "http://localhost:4800/api/v1/notes/5f1c2b1e-9a4d-4b7e-8c1f-2a3b4c5d6e7f/export?format=html",
        "xml": "http://localhost:4800/api/v1/notes/5f1c2b1e-9a4d-4b7e-8c1f-2a3b4c5d6e7f/export?format=xml"
      }
    },
    {
      "revisionId": "0b9d8c7e-6f5a-4d3c-9b2a-1f0e9d8c7b6a",
      "bill": { "biennium": "2025-26", "billId": "HB1019", "number": "1019", "title": "Providing a tax credit ..." },
      "versionCode": "I",
      "versionLabel": "HB 1019",
      "title": "HB 1019 Fiscal Note",
      "publishedAt": "2026-09-02T22:05:10.004Z",
      "publishedBy": { "userId": "dev-reviewer", "displayName": "Rae Reviewer" },
      "publishedVersion": 3,
      "exports": {
        "pdf": "http://localhost:4800/api/v1/notes/0b9d8c7e-6f5a-4d3c-9b2a-1f0e9d8c7b6a/export?format=pdf",
        "docx": "http://localhost:4800/api/v1/notes/0b9d8c7e-6f5a-4d3c-9b2a-1f0e9d8c7b6a/export?format=docx",
        "html": "http://localhost:4800/api/v1/notes/0b9d8c7e-6f5a-4d3c-9b2a-1f0e9d8c7b6a/export?format=html",
        "xml": "http://localhost:4800/api/v1/notes/0b9d8c7e-6f5a-4d3c-9b2a-1f0e9d8c7b6a/export?format=xml"
      }
    }
  ],
  "nextCursor": "MjAyNi0wOS0wMlQyMjowNToxMC4wMDRafDBiOWQ4YzdlLTZmNWEtNGQzYy05YjJhLTFmMGU5ZDhjN2I2YQ"
}
```

## Exports

```
GET /api/v1/notes/{revisionId}/export?format=pdf
GET /api/v1/notes/{revisionId}/export?format=docx
GET /api/v1/notes/{revisionId}/export?format=html
GET /api/v1/notes/{revisionId}/export?format=xml
```

The `exports` map of a feed item holds these four URLs. Each call renders the published version of the
note and returns it in the body with these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/html; charset=utf-8`, or `application/xml; charset=utf-8` |
| `Content-Disposition` | `inline; filename="..."` for PDF and HTML on `GET`; `attachment; filename="..."` otherwise |
| `X-Document-Version` | The document version rendered, equal to `publishedVersion` |
| `Cache-Control` | `no-store` |

Viewers and anonymous callers get the published version. A `version` query parameter naming another
version returns `403`. A note that is not published returns `404` to viewers and anonymous callers; a
signed-in drafter or reviewer with access to the note gets its head version (the approved version of an
approved note).

`format=xml&strict=true` returns `422` with `details.unfilledSlots` when a required slot of the note is
empty; without `strict` the XML is rendered with the empty slots.

### File names

`{billId}-{versionCode}-fiscal-note.{ext}`, with no version suffix for an introduced bill:

| Note | PDF file name |
|---|---|
| SHB 2402 (`HB2402`, version `S`) | `HB2402-S-fiscal-note.pdf` |
| HB 1004 (`HB1004`, version `I`) | `HB1004-fiscal-note.pdf` |
| 2E2SSB 5814 (`SB5814`, version `S2.E2`) | `SB5814-S2.E2-fiscal-note.pdf` |

### Footer

The PDF and HTML exports carry a footer with the form identifier, `Bill # <short label>`, and
`Published <Month D, YYYY>` (Pacific time). The DOCX footer carries the same text.

## Events

The API's outbox emits `note.published` when a note is published, with `noteRevisionId`, `billKey`,
`versionCode`, `publishedVersion`, `publishedAt` and `publishedBy`. The outbox is internal to the API;
the feed is the consumer-facing record.
