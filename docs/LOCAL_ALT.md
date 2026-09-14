# Optional local Alt inspection

`scripts/inspect-local-alt.mjs` is an experimental, read-only helper for Codex runs on the same Mac as Alt Desktop. It inventories active local notes and components and resolves slide PDFs already stored by Alt. This can make a freshly added PDF visible before Alt's public API exposes equivalent attachment metadata.

This is not an official Alt integration. It relies on Alt Desktop's private PowerSync database schema and file layout, which can change without notice. The Cloudflare Worker does not use this script, and a scheduled run on another computer cannot see these files.

## Run it

Requirements:

- macOS with Alt Desktop installed and signed in
- Node.js 22 or newer
- the `sqlite3` command-line program available on `PATH`

From the repository root:

```bash
npm run alt:inspect
npm run --silent alt:inspect -- --json
npm run --silent alt:inspect -- --date 2026-09-07 --title "Database Systems" --json
```

Automatic discovery reads every `powersync-store.account-*.db` file beneath:

```text
~/Library/Application Support/alt/data/database
```

To inspect an explicit account database, pass `--database`. The option can be repeated:

```bash
npm run --silent alt:inspect -- --database "/absolute/path/to/account.db" --json
```

Use `--silent` when another program must parse stdout as JSON; it suppresses npm's command banner.

The JSON includes a neutral per-database label, note title, lecture date, status, component type, text-presence and byte counts, and verified local PDF paths and SHA-256 values. It deliberately omits the account-scoped database path; note and component identifiers; transcript, summary, and memo bodies; user, channel, and folder identifiers; recording paths; and calendar identifiers. It never opens Alt's local HTTP-server configuration or token file.

Treat the output as private even though it is sanitized: note titles and absolute PDF paths can still reveal personal information. Do not commit the output to Git.

## Safety boundary

The helper invokes `sqlite3` with `-readonly`, never runs mutation statements, and never writes to Alt storage. PDF hashing also remains read-only. Paths supplied by Alt are accepted only when their resolved target remains inside Alt's local `data/storage` directory; symbolic-link escapes are ignored. If an exact stored path is unavailable, a storage-wide filename fallback is accepted only when the unique candidate also matches Alt's stored SHA-256 and declared size (when present).

If Alt changes a required table or column, the command stops with an `Unsupported Alt database schema` error instead of guessing. Update and review the inspector before using it with that Alt release.

## Durable semester workflow

Local discovery is useful for an immediate, account-local curation run, but it is not a durable source contract. For reliable semester operation, copy or attach each authoritative PDF to the matching Notion class page's `수업 자료` property. That keeps the material available to Notion-connected Codex runs, byte-change detection, retries, and future machines even if Alt's internal database or storage layout changes.

The inspector only reports local source availability. It does not upload PDFs, read draft bodies, create Notion pages, or trigger the Cloudflare Worker.
