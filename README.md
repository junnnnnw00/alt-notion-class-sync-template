# Alt → Notion Lecture Sync

Sync completed [Alt](https://www.altalt.io/en/developers/quickstart) recordings into the matching class page in Notion. A Cloudflare Worker receives signed webhooks, fetches the current transcript and optional Alt summary, and stores both in a single collapsed `원본 자료` source block beneath `원본 동기화`.

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
- Optional, separate Codex curation for lecture and cumulative course workbooks
- Optional class-page PDF reading, including later additions and replacements
- A user-owned class/event page for `직접 필기`, with generated content isolated in a child `AI 학습 교재`
- A self-contained lecture workbook with continuous teaching prose, worked examples, generated practice, collapsed answers, and an unobtrusive evidence map

## Two independent layers

| Layer | Runs in | Purpose |
|---|---|---|
| Source ingestion | Cloudflare Worker | Reliably sync the Alt transcript and optional Alt summary into Notion |
| Workbook curation | The user's Codex app | Turn new source revisions into a lecture workbook and cumulative course workbook while leaving manual notes untouched |

Deploying this repository installs only the first layer. The Worker does not call Codex or ChatGPT, and a ChatGPT/Codex subscription is not a server API credential. The optional second layer is installed and scheduled separately in the Codex app; it does not require an OpenAI API key.

## Data flow

```text
Alt recording ends
  → signed webhook
  → Cloudflare Worker + Durable Object
  → match by local date, course title, and class time
  → Notion class page / 원본 동기화 / 원본 자료
  → optional Codex curation pass (+ current Notion `수업 자료` PDFs)
  → protected parent 직접 필기 + child AI 학습 교재
  → continuous explanation + worked examples + practice + collapsed answers/evidence
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

The Worker places its collapsed `원본 자료` below `원본 동기화` and owns only that source block. The class/event page remains the student's `직접 필기` workspace. Optional Codex curation writes generated material only inside the page's child `AI 학습 교재`; it never uses or rewrites parent-page notes unless the user explicitly requests a particular passage be incorporated. A course root follows the same separation with protected child `내 과목 정리`, managed child `AI 과목 교재`, and a linked class view under `수업별 회차`.

Existing pages remain compatible. On the next real curation trigger, the curator can read `원본 자료` from a legacy `AI 수업 노트`, rebuild the current source into the `AI 학습 교재` child, and remove only a legacy `AI 회차 교재` range whose recorded identifiers prove curator ownership. It never moves the Worker source or treats an unrecorded legacy block as generated content.

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

The repository includes the reusable [`alt-notion-note-curator`](skills/alt-notion-note-curator/SKILL.md) skill. See [Codex workflow setup](docs/CODEX.md) for installation, a manual run, and a scheduled-task prompt. A safe run compares both the Alt revision marker and the byte fingerprint of current Notion PDFs, then makes no changes when neither changed. Manual notes are not a regeneration trigger.

Alt's current public API exposes note metadata, transcripts, and summaries, but not raw PDF attachments. If a PDF must be read directly, attach it once to the matching Notion class page's `수업 자료` property. This Files property is the guaranteed path for detecting a material added to an old class; a PDF block embedded only in the page body is supplemental and is read only when that page is already a processing candidate. The curator reads every page, but uploads only visuals that materially improve understanding: diagrams, tables, schedules, equation layouts, annotated code, algorithm traces, and necessary comparisons. Title pages, decorative images, section dividers, and ordinary text-only slides are normally absorbed into the prose rather than repeated as images. Selected images appear directly after the paragraph that prepares the reader to interpret them, producing one top-to-bottom flow instead of a detached gallery.

The `workbook-v3` output is a learning workbook rather than a short summary. It uses three to seven broad chapters with continuous prose, worked reasoning, a compact recap, generated practice questions, and a separate collapsed answer key. Repeated `[Alt revision …]` and `[file.pdf, p. …]` labels do not interrupt the teaching text; a collapsed `근거 지도` maps each chapter, example, formula, exact value, and assessment claim back to transcript ranges and verified PDF pages. Source changes replace only the managed child page and its images and leave the parent `직접 필기`, user images, properties, files, and raw sources untouched.

Before publication, the curator inventories the source, requires 100% coverage of critical units and at least 92% weighted coverage, and scores grounding, coverage, teaching depth, exercises, readability, and preservation. A workbook must score at least 90/100 with no weak category. Unsupported important facts, unread PDF pages, altered manual content, broken answers, hidden source conflicts, or a class update without its cumulative course update prevent replacement of the last good workbook.

If a recording was missed but the class page has a readable PDF, the curator can create a material-only workbook. It uses only slide-supported claims and does not invent instructor remarks, corrections, or announcements. If an Alt source appears later, the same managed workbook is rebuilt from both sources.

If Alt regenerated a summary from slides, that summary can still arrive through the normal source-ingestion path, but it is not a substitute for direct file access. In Alt desktop 0.11.1, the observed import path accepts PDF rather than PPT/PPTX, so export slides to PDF first; later Alt releases may differ.

## Documentation

- [Complete setup](docs/SETUP.md)
- [Codex curation and manual runs](docs/CODEX.md)
- [Optional read-only local Alt inspection](docs/LOCAL_ALT.md)
- [Korean end-user guide for a Notion dashboard](docs/NOTION_USER_GUIDE.ko.md)
- [Security and data retention](SECURITY.md)

## License

[MIT](LICENSE)
