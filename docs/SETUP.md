# Complete setup

This guide installs the Alt-to-Notion source-ingestion layer. Codex curation is optional and configured separately.

## 1. Prepare the Notion data source

Create or reuse a timetable data source with these property types. Names may be different; the setup wizard asks for each one.

| Purpose | Required type | Default |
|---|---|---|
| Event title | Title | `이름` |
| Class interval | Date with a start and preferably an end | `일시` |
| Event category | Select | `구분` |
| Course name | Select, title, or rich text | `과목` |
| Per-class opt in | Checkbox | `AI 자동 노트` |
| Direct course material, optional for Codex | Files | `수업 자료` |

The configured class-category value defaults to `수업`. Turn on the checkbox for every class that should receive Alt source material. The Worker does not read `수업 자료`; the optional Codex curation layer uses that Files property as the guaranteed full-semester trigger for PDFs added later. A PDF embedded only as a page-body block is supplemental and is read only after another trigger already made that page a candidate. Put every file that must trigger a refresh in `수업 자료`, even if it is also embedded in the page.

Create a Notion internal connection with only read, insert, and update content capabilities. Share the original timetable database with that connection; sharing a linked view is not sufficient. Copy the data source ID in Notion from the database settings under **Manage data sources → … → Copy data source ID**. A database ID or view ID is different from a data source ID in current Notion APIs. See [Notion's data-source guide](https://developers.notion.com/cli/guides/data-sources).

Keep the internal integration token for the secret step below.

## 2. Create the local deployment configuration

```bash
npm install
npm run setup
```

The wizard validates the Worker name, data source UUID, and IANA time zone, then creates `wrangler.local.jsonc` with file mode `0600`. The file is ignored by Git. It contains account-specific configuration but no API tokens.

To automate setup or use English property labels:

```bash
npm run setup -- \
  --worker my-alt-notion-sync \
  --data-source-id 00000000-0000-0000-0000-000000000000 \
  --date-property Date \
  --category-property Type \
  --course-property Course \
  --title-property Name \
  --auto-note-property "AI notes" \
  --class-category Class \
  --time-zone America/New_York
```

Replace the zero UUID with a real data source ID. Validate the result at any time:

```bash
npm run setup -- --check
```

The ignored local-config strategy prevents a fork from publishing a Notion ID. `keep_vars` is also enabled so a later Wrangler deployment does not remove variables configured directly in the Cloudflare dashboard. Cloudflare documents this behavior in [Wrangler's source-of-truth settings](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).

## 3. Create the Alt integration

In Alt, open **Account → API & Webhooks**, create an integration, and grant only:

```text
notes:read
transcripts:read
summaries:read
webhooks:manage
```

Alt displays the full API key only once. Save it directly as a Cloudflare secret; do not paste it into a repository file. The current scope names and webhook flow are documented in the [Alt quickstart](https://www.altalt.io/en/developers/quickstart).

## 4. Store the first secrets and deploy

```bash
npx wrangler login
npx wrangler secret put ALT_API_KEY --config wrangler.local.jsonc
npx wrangler secret put NOTION_API_TOKEN --config wrangler.local.jsonc
npm run typecheck
npm test
npm run deploy
```

Save the resulting `https://<worker>.<subdomain>.workers.dev` URL.

## 5. Register the Alt webhook

Create an Alt webhook endpoint at:

```text
https://<worker>.<subdomain>.workers.dev/webhooks/alt
```

Subscribe to:

```text
note.ended
note.summary.generated
note.updated
note.deleted
```

Alt returns a `whsec_…` signing secret once. Store it immediately:

```bash
npx wrangler secret put ALT_WEBHOOK_SECRET --config wrangler.local.jsonc
```

The endpoint's first verification may arrive before that secret is installed. After storing it, use Alt's **Send test** or verification action again. A valid endpoint responds with HTTP 204. Alt webhooks contain identifiers and statuses; the Worker then fetches the current content from Alt. See [Alt webhook behavior](https://www.altalt.io/en/developers/webhooks).

## 6. Verify

Open:

```text
https://<worker>.<subdomain>.workers.dev/health
```

The three credentials and coordinator should be configured. `pendingEvents` and `unmatchedNotes` should normally settle to zero. `lastFullReconciledAt` records the most recent complete inventory and `fullScanInProgress` shows a retrying pass. `hasReconcileError` and `hasFullReconcileError` signal problems without exposing private error messages publicly.

Finish with a short test recording during a class slot. Confirm that the matching Notion page contains:

```text
AI 수업 노트
  원본 자료
    Alt 요약       (only when available)
    전체 녹취
```

## Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `NOTION_DATA_SOURCE_ID` | none | Required data source UUID |
| `NOTION_*_PROPERTY` | Korean labels | Exact Notion property labels |
| `CLASS_CATEGORY` | `수업` | Eligible select value |
| `TIME_ZONE` | `Asia/Seoul` | IANA zone used for local class-day boundaries, including DST |
| `MATCH_WINDOW_MINUTES` | `90` | Maximum end-time matching window |
| `RECONCILE_LOOKBACK_HOURS` | `48` | Initial/recovery lookback |
| `RECONCILE_INTERVAL_MINUTES` | `15` | Safety-net interval |
| `FULL_RECONCILE_INTERVAL_HOURS` | `24` | Complete inventory interval for deletion and scope-loss recovery; minimum `1` |
| `COURSE_ALIASES_JSON` | none | Optional aliases, for example `{"Algorithms":["CS 201"]}` |

## Local development

Copy `.dev.vars.example` to `.dev.vars` and replace its dummy values. Never commit `.dev.vars`.

```bash
npm run dev
```

A public HTTPS URL is still required for real Alt webhook delivery.

## Updating an installation

Keep `wrangler.local.jsonc` and the Cloudflare secrets. Then:

```bash
git pull
npm ci
npm run typecheck
npm test
npm run deploy
```

The `v1` Durable Object migration tag must remain in the config. Do not create a new migration tag unless the Durable Object class/storage migration actually changes.

## Troubleshooting

- **Notion 404:** Share the original database with the internal connection and recheck the data source ID.
- **Notion 403:** Enable read, insert, and update content capabilities.
- **Webhook 401:** The Alt signing secret is wrong or the request timestamp is stale.
- **Webhook 503:** `ALT_WEBHOOK_SECRET` is not installed yet.
- **Unmatched note:** Ensure the timetable interval is accurate, the recording overlaps it, and Alt's title resembles the course name. Add `COURSE_ALIASES_JSON` only for known aliases.
- **Mobile recording missing:** Confirm that the note has synced to the same Alt account and is visible through that integration.
- **No summary:** This is expected; transcript-ready notes sync without an Alt summary.
- **PDF added in Alt but missing from the curated note:** Alt's public API does not expose raw attachments. Regenerate the slide summary in Alt for possible indirect inclusion, or attach the PDF to the matching Notion class page's `수업 자료` property for direct page-level reading. Export PPT/PPTX to PDF first.
- **Inline slides did not refresh:** Confirm that the PDF is in the `수업 자료` Files property, not only embedded in the page body. A successful curation run renders every current PDF page and places it beside the relevant explanation in the managed note; if any current file cannot be read, rendered, uploaded, or written, the prior note, images, and fingerprint intentionally remain.
