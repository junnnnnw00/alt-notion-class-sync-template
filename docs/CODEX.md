# Optional Codex workbook curation

The Cloudflare Worker syncs source material deterministically. Codex can separately turn each new source revision into a Korean lecture workbook and update a cumulative course workbook. The generated workbook and the student's own notes remain separate.

This layer runs through the user's Codex app and connected Notion account. The Worker cannot invoke a ChatGPT or Codex subscription, and this repository does not turn that subscription into a server-side API. No OpenAI API key is required for the account-local workflow described here.

## Install the repository skill

Copy the skill folder into your Codex skills directory:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/alt-notion-note-curator "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Restart or refresh Codex if the skill is not discovered. Connect Notion to Codex and grant access only to the timetable dashboard, class pages, and course pages that the workflow needs.

## Required configuration

Have these values ready in the Codex task that owns the workflow:

- The Notion data source reference or ID for class rows
- A mapping from each exact course name to its cumulative course page
- The optional Files-property name for direct course materials, default `수업 자료`

The mapping is intentionally not stored in this public repository. Keep it in the private Codex task prompt or another private project note.

For an immediate run on the same Mac as Alt Desktop, the optional [local Alt inspector](LOCAL_ALT.md) can report active component metadata and verified slide-PDF paths without exposing transcript or memo bodies. It is an unsupported convenience layer over Alt's private local schema, not a replacement for attaching durable source files to Notion `수업 자료`.

## Notion ownership model

The curator uses explicit ownership boundaries:

- The class or calendar-event page is the student's user-owned `직접 필기` workspace. The curator never changes or uses that writing as evidence by default.
- Generated content lives in one child page titled `AI 학습 교재`. Routine curation writes only that child page and replaces only block and image identifiers recorded in its `자동화 정보`.
- The Worker-owned collapsed `원본 자료` remains on the parent class page beneath `원본 동기화`. The curator reads it without moving or rewriting it.
- Each mapped course root has protected child `내 과목 정리`, managed child `AI 과목 교재`, and a linked class view beneath `수업별 회차`. The curator writes only `AI 과목 교재`.

This keeps live class scribbles fast and personal while the generated workbook can be rebuilt safely from Alt and PDFs.

Legacy layouts migrate lazily on the next real processing trigger. The curator can read `원본 자료` from legacy `AI 수업 노트`, create or reuse the identified `AI 학습 교재` child, rebuild current sources there as `workbook-v3`, and only after class/course verification remove a legacy `AI 회차 교재` whose recorded identifiers prove curator ownership. It preserves ambiguous blocks and leaves movement of the Worker source into `원본 동기화` to the ingestion layer. Repeated runs reuse the same child and cannot duplicate links, workbooks, or images.

## Manual run

Put each trigger PDF in the class page's `수업 자료` Files property. A PDF embedded only in the body is supplemental and does not independently make an old page discoverable in the semester-wide scan.

Send this in the Notion-connected Codex task:

```text
Use $alt-notion-note-curator now. In DATA_SOURCE, process new Alt source revisions from the last 36 hours and changed PDFs across the full semester. Use `수업 자료` as the guaranteed material-discovery path and read page-body PDFs only on pages already selected as candidates. Treat each class/event page as user-owned `직접 필기`; read the Worker-owned `원본 자료` beneath `원본 동기화` and write generated content only to that page's identified child `AI 학습 교재`. Accept legacy source placement under `AI 수업 노트`; on a real trigger, lazily rebuild any recorded legacy `AI 회차 교재` into the child and remove only proven curator-owned legacy blocks after verification. For each candidate, inventory every substantive Alt and PDF source unit, read every current PDF page, and build a `workbook-v3` child with three to seven broad, continuous teaching chapters, worked examples or traces where supported, one compact recap, generated practice questions, a separate collapsed answer key, a collapsed evidence map, and automation metadata. Do not place repeated Alt-revision or PDF-page citations in the teaching prose; map chapters, examples, formulas, exact values, and announcements to their source locations in `근거 지도`. Select only visuals whose layout materially improves understanding and place each once inside the child explanation. If there is a readable PDF but no Alt source, create a material-only workbook without inventing instructor statements. Require 100% critical and at least 92% weighted source coverage, at least 85% applicable concept-depth coverage, and a QA score of at least 90/100 with no weak category. Repair and rescore before publishing. Preserve the previous good workbook on any hard failure. In the same successful run rebuild the mapped course root's child `AI 과목 교재`, deduplicated around concepts rather than appended by date; preserve child `내 과목 정리` and the `수업별 회차` linked view. If nothing changed, finish quietly.
```

Replace `DATA_SOURCE` and `COURSE_PAGE_MAP` with private values. A manual run is the simplest way to curate immediately after an important class. If the workflow is already scheduled, open **Scheduled**, select the task, and choose **Run now**. Sending the manual prompt in its existing Codex task is also valid.

## Scheduled task

Ask Codex to create a recurring automation in the same Notion-connected task. A responsive semester schedule is once every 15 minutes during waking study hours on all seven days. This tightens workbook refreshes but does not make Alt source ingestion faster; the Worker already receives Alt webhooks immediately. Keep a manual **Run now** path for an urgent refresh, and widen the interval if the cadence uses more Codex allowance than desired.

Suggested automation prompt:

```text
Use $alt-notion-note-curator. In DATA_SOURCE, process every explicit `Alt · 삭제됨 · revision N` marker first. For active Alt changes, inspect auto-note-enabled classes from the last 36 hours. Separately inspect every semester class with a non-empty `수업 자료` property or an existing managed material fingerprint. Process only a newer revision, changed PDF bytes, material_only-to-active upgrade, layout older than `workbook-v3`, legacy layout, or incomplete class/course write. Treat the class/event page as user-owned `직접 필기`. Read but never change its Worker-owned `원본 동기화` / `원본 자료`, properties, files, images, or other blocks. Write generated material only to the identified child `AI 학습 교재`. Accept legacy `AI 수업 노트` source placement and lazily replace only recorded curator-owned `AI 회차 교재` after the new child and course child pass verification.

For each candidate, inventory definitions, formulas and values, mechanisms, relations, examples and traces, instructor emphasis/corrections/Q&A, policies, and essential visuals. Read every current PDF page. Create one continuous child `AI 학습 교재` with three to seven broad chapters; explain each applicable concept through definition or intuition, purpose, mechanism, supported example or trace, confusion or boundary, and connection. Add a compact recap, 6–18 source-adjusted generated practice questions, one collapsed separate answer key, optional unresolved-points toggle, collapsed section-level evidence map, and automation metadata. Keep normal prose free of repeated `[Alt revision …]` and `[file, p. …]` labels. Use the evidence map for exact transcript ranges, verified PDF pages, generated educational transformations, conflicts, and deterministic corrections. Use sparse inline visuals only when the image itself adds information, and upload them only to the child.

Require 100% critical coverage, at least 92% weighted coverage, at least 85% applicable concept-depth coverage, and at least 90/100 on grounding, coverage, teaching depth, questions and answers, readability, and preservation. Independently reread, repair, and rescore up to three times. Unsupported important facts, unread PDF pages, modified parent or protected-child content, hidden conflicts, bad questions or answers, false evidence, duplicate child pages, blocks, or images, or a class update without a cumulative course update are hard failures. Stage the complete class-child and course-child replacements first and advance revision, fingerprint, child and managed identifiers, layout, coverage, and QA metadata only after both writes and reread verification succeed. Preserve the last good state on any failure. Rebuild only the course root's child `AI 과목 교재` by concept with representative worked examples, a deduplicated mixed problem bank and collapsed answers, class links, evidence, and regression checks; preserve child `내 과목 정리` and the linked view beneath `수업별 회차`. If nothing changed, make no writes and do not notify; report only actionable permissions, damaged sources, or repeated failures.
```

The exact scheduling interface and available frequency depend on the current Codex app. Create the automation through the app rather than committing scheduler files or private Notion IDs to this repository. See the official OpenAI guide to [Scheduled tasks](https://learn.chatgpt.com/docs/automations) for creating, testing, managing, and manually triggering runs.

## What `workbook-v3` contains

A successful child `AI 학습 교재` contains:

- Three to six observable learning outcomes
- Three to seven broad chapters written as connected explanatory prose
- Definitions, motivation, mechanisms, supported worked reasoning, boundary cases, and concept links
- Sparse, context-aware PDF visuals inside the reading flow
- One compact review map or rule sheet
- Generated practice questions without answer leakage
- One collapsed, separate answer key with reasoning, grading points, and common errors
- A collapsed evidence map instead of citation clutter in the teaching text
- Collapsed metadata recording source state, fingerprints, managed identifiers, page counts, coverage, QA, and `workbook-v3`

For a standard lecture, the skill normally creates 8–14 questions split across retrieval, application or tracing, and comparison, diagnosis, or synthesis. It never presents generated questions as authentic or predicted exam items.

The cumulative child `AI 과목 교재` is not a list of per-date summaries. It merges lessons into a concept graph, keeps representative worked examples, maintains a deduplicated mixed problem bank with separate answers, links every included class page, and checks that previously supported content does not disappear without a source deletion or replacement. Its course root preserves the separate child `내 과목 정리` and the linked class view headed `수업별 회차`.

## Publication safety

The skill stages and verifies the complete `AI 학습 교재` child and cumulative `AI 과목 교재` child before advancing markers. It preserves the last good children, selected visuals, parent sources, and fingerprints when a file cannot be read, an image cannot be prepared, a write fails, or the quality gate does not pass. A retry with the same inputs does not duplicate child links, blocks, images, questions, answers, or evidence rows.

On a deletion marker, the curator removes only child-workbook claims supported solely by the deleted Alt source. If current PDFs remain, it can rebuild a material-only child; otherwise it clears only the managed generated content and rebuilds the course child from remaining current sources. Parent `직접 필기`, protected `내 과목 정리`, and Worker sources remain untouched.

## PDFs added after recording

Alt desktop distinguishes a regular **Note** from a **Slide** note. As observed in Alt desktop 0.11.1, a regular recording note created without a PDF has no supported action to convert it to a Slide note or attach a PDF later. The missing Slide view is therefore expected in that version; a later Alt release may add or change this behavior. Leave the recording note intact and attach the PDF to the matching Notion class page's `수업 자료` property instead. The curator combines that file with the existing Alt transcript.

If a separate Alt slide workspace is useful, create a new note with type **Slide** and import the PDF there; this does not merge it into the earlier regular note. In Alt desktop 0.11.1, that observed import path is PDF-only, so export PPT/PPTX first.

Alt's public API currently has no file or attachment endpoint. The Worker therefore cannot guarantee direct access to a PDF added inside Alt. Regenerating Alt's slide summary may indirectly update the exported summary, but direct page-level analysis requires attaching the PDF to the matching Notion class page's `수업 자료` property. The curator notices changed file bytes even when the Alt revision did not change.

If a run fails midway, rerun it. Source, fingerprint, layout, and managed-range markers make successful work idempotent, while the available `원본 자료` remains the recovery source.
