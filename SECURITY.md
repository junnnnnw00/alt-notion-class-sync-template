# Security and privacy

## Secrets

Store `ALT_API_KEY`, `ALT_WEBHOOK_SECRET`, and `NOTION_API_TOKEN` only as Cloudflare encrypted secrets. For local development, use the ignored `.dev.vars` file. Never put real values in `wrangler.local.jsonc`, screenshots, issues, logs, or commits.

If a credential is exposed, revoke or rotate it at the provider before doing anything else. Removing it from the latest commit is not sufficient because Git history and forks may retain it.

## Least privilege

- Alt: `notes:read`, `transcripts:read`, `summaries:read`, and `webhooks:manage`
- Notion: read, insert, and update content only
- Notion content access: the specific timetable/dashboard subtree, not the whole workspace

Use a separate integration for this project so it can be revoked without affecting other automations.

## Public endpoints

`POST /webhooks/alt` rejects unsigned, stale, oversized, and malformed requests. `GET /health` is public but returns only configuration booleans, counts, timestamps, and a boolean error indicator. It does not return credentials or raw reconciliation errors.

Do not add transcript text, note titles, page URLs, headers, request bodies, or provider error bodies to public health responses or production logs.

Alt's public API does not expose raw slide attachments. Do not scrape private Alt endpoints, reuse session cookies, or guess attachment URLs. The optional Codex layer reads only PDFs explicitly available on an authorized Notion class page. Temporary Notion download URLs must never be stored in markers, logs, fixtures, or Git; compute material fingerprints from file bytes and discard temporary downloads after processing.

## Retention and deletion

The Durable Object retains processed webhook IDs for seven days. Note mappings, current revisions, and unresolved-match records may remain until the Worker and its Durable Object storage are deleted. Unmatched records can include an Alt note title and candidate course names, so treat the Worker account as student-data storage. When a non-stale deletion or fetched tombstone is processed, its unmatched payload is purged before any Notion cleanup or marker request begins.

Every Alt `note.deleted` event removes the transcript and summary managed by this Worker, whether the reason is `deleted` or `access_lost`. Reconciliation does the same when it fetches a deleted tombstone. This follows [Alt's requirement](https://www.altalt.io/en/developers/webhooks#check-for-missed-changes) to remove or block stored copies that leave an API key's visibility scope. The Worker leaves only a content-free `원본 자료` marker whose first line is `Alt · 삭제됨 · revision N`; it contains no Alt note ID, note title, transcript, or summary. User-authored blocks and page properties are outside the Worker's deletion target.

Incremental reconciliation cannot detect a note that disappears from the API key's scope. The Worker therefore performs a full inventory every 24 hours by default. It follows every cursor with `include_deleted=true` and compares IDs only after all pages succeed. API, cursor, validation, or 2,500-note safety-limit failures do not trigger missing-note deletion; the same scan generation retries later. Records created after the scan cutoff are excluded from cleanup to avoid racing a webhook.

Deletion delivery can be delayed if a webhook is missed. The complete inventory scan detects that case at the next successful run (every 24 hours by default); a failed scan retries without deleting from a partial inventory. Once the Worker processes the deletion, source content is removed before it writes the minimal marker. A manual or scheduled Codex curator run then sees that marker and rebuilds the managed class and course summaries from remaining active sources. Until that curator run completes, derived prose can temporarily retain deleted facts; run the curator immediately when stricter timing is required.

To uninstall, first remove or disable the Alt webhook, then delete the Worker and its Durable Object data in Cloudflare. Revoking the Alt and Notion integrations prevents further access. Deleting the Worker does not remove copies already stored in Notion.

## Recording consent

Recordings and transcripts may contain personal or protected educational information. The operator is responsible for applicable consent rules, institutional policies, retention requirements, and access controls.

## Reporting a vulnerability

Use a private GitHub security advisory in the repository. Do not include real transcripts, page IDs, webhook payloads, or credentials in the report.
