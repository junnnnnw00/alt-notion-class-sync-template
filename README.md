# Alt → Notion Lecture Sync

Sync completed [Alt](https://www.altalt.io/en/developers/quickstart) recordings into the matching class page in Notion. A Cloudflare Worker receives signed webhooks, fetches the current transcript and optional Alt summary, and stores both in a single collapsed `원본 자료` source block.

This is an unofficial community project and is not affiliated with Alt, Notion, Cloudflare, or OpenAI.

The project isolates its writes: it does not create task statuses, it never rewrites user-authored blocks, and deletion removes only the source content managed by this Worker. A content-free deletion marker remains so an optional Codex curation pass can rebuild derived notes.

## What is included

- Near-real-time delivery from Alt webhooks
- A 15-minute incremental reconciliation safety net
- A daily full inventory check for missed deletions and access loss
- Course-and-time matching instead of guessing a page
- Duplicate and out-of-order event protection using Alt revisions
- A per-class `AI 자동 노트` checkbox
- Transcript-only operation when no Alt summary exists
- PDF-only curation when a recording was missed, with automatic enrichment if an Alt source appears later
- Configurable Notion property labels and IANA time zone
- Optional, separate Codex curation for polished class and course summaries
- Optional class-page PDF reading, including later additions and replacements
- A continuous lecture note with every PDF page placed beside the explanation it supports

## Two independent layers

| Layer | Runs in | Purpose |
|---|---|---|
| Source ingestion | Cloudflare Worker | Reliably sync the Alt transcript and optional Alt summary into Notion |
| Note curation | The user's Codex app | Turn new source revisions into a polished class note and cumulative course summary |

Deploying this repository installs only the first layer. The Worker does not call Codex or ChatGPT, and a ChatGPT/Codex subscription is not a server API credential. The optional second layer is installed and scheduled separately in the Codex app; it does not require an OpenAI API key.

## Data flow

```text
Alt recording ends
  → signed webhook
  → Cloudflare Worker + Durable Object
  → match by local date, course title, and class time
  → Notion class page / AI 수업 노트 / 원본 자료
  → optional Codex curation pass (+ current Notion `수업 자료` PDFs)
  → polished note with context-aware inline slides
```

## Quick start

Requirements: Node.js 22 or newer, a Cloudflare Workers account, Alt API access, and a Notion internal connection.

Choose **Use this template** on GitHub to create your own private copy, then clone that copy:

```bash
git clone https://github.com/<your-account>/<your-repository>.git
cd <your-repository>
npm install
npm run setup
```

The setup wizard creates an ignored `wrangler.local.jsonc`; it never asks for or writes API keys. Continue with the step-by-step [setup guide](docs/SETUP.md) to add secrets, deploy, and register the Alt webhook.

```bash
npm run typecheck
npm test
npm run deploy
```

Do not run `npm run deploy` before `npm run setup`. The tracked `wrangler.example.jsonc` contains only placeholders; account-specific IDs stay in the ignored local file.

## Notion schema

The default labels are Korean, but every label is configurable during setup.

| Default label | Type | Meaning |
|---|---|---|
| `이름` | Title | Event title |
| `일시` | Date with start and end | Scheduled class interval |
| `구분` | Select | Rows whose value is `수업` are eligible |
| `과목` | Select or text | Course used for matching |
| `AI 자동 노트` | Checkbox | Enables ingestion for that class |
| `수업 자료` | Files, optional | Guaranteed full-semester trigger for PDFs that Codex should read directly |

The Worker creates an `AI 수업 노트` heading when absent. It owns only the `원본 자료` toggle below that heading; other page properties and blocks remain untouched.

## Matching and recovery

- Matching uses the timetable's local calendar day, course-title similarity, and actual time overlap.
- Ambiguous recordings remain unmatched instead of being written to a guessed page.
- Webhook event IDs and note revisions make retries idempotent.
- A Durable Object alarm checks recent changes without a Cron Trigger.
- Every 24 hours by default, the same alarm pages through the complete Alt note list with deletion tombstones enabled. A stored active or unmatched note missing from a successfully completed inventory is handled as `access_lost`.
- Missing-note cleanup runs only after the complete inventory succeeds. Invalid pagination, an API failure, or more than 2,500 listed notes aborts the pass without deleting anything and retries later.
- Every Alt `note.deleted` event removes the Worker-managed transcript and summary. This includes both an explicit deletion and `access_lost`, as required by [Alt's webhook guidance](https://www.altalt.io/en/developers/webhooks#check-for-missed-changes). The replacement `원본 자료` toggle contains only `Alt · 삭제됨 · revision N`; it has no note ID, title, or source text.
- User-authored blocks and page properties are not removed by that cleanup.

`GET /health` reports configuration flags, counts, timestamps, `lastFullReconciledAt`, `fullScanInProgress`, and boolean incremental/full reconciliation error flags. Raw error text is intentionally omitted from the public response.

## Optional Codex curation

The repository includes the reusable [`alt-notion-note-curator`](skills/alt-notion-note-curator/SKILL.md) skill. See [Codex workflow setup](docs/CODEX.md) for installation, a manual run, and a scheduled-task prompt. A safe run compares both the Alt revision marker and the byte fingerprint of current Notion PDFs, then makes no changes when neither changed.

Alt's current public API exposes note metadata, transcripts, and summaries, but not raw PDF attachments. If a PDF must be read directly and cited by page, attach it once to the matching Notion class page's `수업 자료` property. This Files property is the guaranteed path for detecting a material added to an old class; a PDF block embedded only in the page body is supplemental and is read only when that page is already a processing candidate. For every current PDF, the curator renders every page as an image and places it directly after the paragraph that explains or references that slide, captioned `파일명 · 슬라이드 N`. The result is one top-to-bottom reading flow rather than a detached gallery. It replaces only its own prior inline images when the source changes and leaves user images untouched.

If a recording was missed but the class page has a readable PDF, the curator can create a material-only note. It uses only slide-supported claims and does not invent instructor remarks, corrections, or announcements. If an Alt source appears later, the same note is rebuilt from both sources.

If Alt regenerated a summary from slides, that summary can still arrive through the normal source-ingestion path, but it is not a substitute for direct file access. In Alt desktop 0.10.1, the import path accepts PDF rather than PPT/PPTX, so export slides to PDF first; later Alt releases may differ.

## Documentation

- [Complete setup](docs/SETUP.md)
- [Codex curation and manual runs](docs/CODEX.md)
- [Korean end-user guide for a Notion dashboard](docs/NOTION_USER_GUIDE.ko.md)
- [Security and data retention](SECURITY.md)

## License

[MIT](LICENSE)
