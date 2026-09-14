---
name: alt-notion-note-curator
description: Curate Alt-synced Notion lecture sources and optional class-page PDFs into Korean lecture workbooks with exercises, answer keys, evidence maps, and cumulative course workbooks. Use for manual or scheduled processing of new Alt revisions or changed course materials; do not use for ingesting recordings or configuring the Cloudflare Worker.
---

# Alt Notion Note Curator

Require a Notion class data source and an exact course-name-to-course-page mapping. If either is unavailable, request only the missing private configuration; never invent an ID or destination.

## Ownership boundaries

Keep human writing, synced sources, and generated material on separate page ownership boundaries.

- The class or calendar-event page is the student's workspace. Its `직접 필기` and every other user-authored block are user-owned. Never rewrite, reformat, move, summarize, use as factual evidence, or delete them unless the user explicitly requests that exact operation.
- The class page has one child page titled `AI 학습 교재`. The curator writes generated chapters, inline images, exercises, answers, `근거 지도`, and `자동화 정보` only inside that child page. Record the child page ID and deterministic managed block and image identifiers; a matching title alone is not ownership proof.
- The class page keeps the Worker-owned collapsed `원본 자료` toggle under the top-level heading `원본 동기화`. The curator may read it but never rewrites, moves, renames, or deletes it.
- A course root page has a protected child page `내 과목 정리`, a curator-managed child page `AI 과목 교재`, and a `수업별 회차` heading above the linked class view. The curator writes only the managed child page and preserves the course root, the protected child, the heading, and the linked view.
- Creating a missing managed child-page link during an explicitly authorized bootstrap or safe legacy migration is the only structural parent-page write. Routine curation updates only the two managed child pages.
- Editing `직접 필기` or `내 과목 정리` never triggers regeneration. New Alt revisions, changed course-material bytes, a legacy layout, or an incomplete prior run are the only ordinary generation triggers.

Do not use `직접 필기` or `내 과목 정리` as a source by default. If the user explicitly asks to incorporate a particular manual passage, treat it as a one-run supplemental source, identify it as user-supplied in `근거 지도`, and still leave the original passage untouched.

## Backward-compatible lazy migration

Accept both the canonical layout and legacy pages that still contain `AI 수업 노트`, `AI 회차 교재`, or `Alt 자동 기록`. Migrate a legacy page only when a normal source, material, legacy-layout, or recovery trigger already makes it a candidate; do not rewrite the semester merely to rearrange pages.

1. Read the active Worker-owned `원본 자료` from canonical `원본 동기화` or from legacy `AI 수업 노트`. Preserve that toggle in place. Moving the source and renaming its parent heading belong to the ingestion layer, not the curator.
2. Find or create the class page's child `AI 학습 교재`. Rebuild a complete `workbook-v3` there from current sources instead of copying legacy prose as evidence.
3. After the child workbook, mapped `AI 과목 교재`, and reread verification all succeed, remove only legacy `AI 회차 교재` blocks and images whose prior managed identifiers prove curator ownership. If ownership is ambiguous, preserve them and report the ambiguity rather than risking manual content.
4. Record the legacy identifiers and completed migration in the child `자동화 정보`. A retry must reuse the same child and must not duplicate the child link, workbook, source toggle, or images.

Legacy source placement remains readable until the ingestion layer places `원본 자료` beneath `원본 동기화`. Never block workbook generation solely because that source heading has not yet migrated.

## Find work

Before processing the requested time window, find Worker deletion markers in the class data source. A deletion marker is a `원본 자료` toggle whose first line is `Alt · 삭제됨 · revision N`; it contains no transcript or summary. Process these markers before ordinary notes regardless of class date or auto-note checkbox. Never treat an absent or incomplete source as a deletion unless this explicit marker exists.

For ordinary Alt processing, query class rows in the requested source-revision time window whose configured auto-note checkbox is on. On each class page, read the Worker's active `원본 자료` beneath `원본 동기화`, or its legacy placement under `AI 수업 노트` or `Alt 자동 기록`, and its source revision. Inspect the child `AI 학습 교재` for processed metadata and layout state.

Material changes are not limited by the class-date window: a user may attach a PDF weeks after recording. Across the configured semester data source, inspect every auto-note-enabled class whose `수업 자료` Files property is non-empty or whose managed `자동화 정보` already contains a material fingerprint. The Files property is the guaranteed full-semester discovery path. A PDF block placed only in the page body is supplemental: inspect it when another trigger already made that page a candidate, but do not assume it independently triggers the default semester-wide scan.

Compare the active source revision, material fingerprint, managed state, and layout version. Process a page only for a newer active revision, an unprocessed deletion marker, a changed material fingerprint, a `material_only` note that now has an Alt source, a layout older than `workbook-v3`, or an incomplete prior class/course write. Otherwise make no change.

When course materials exist, read [references/materials.md](references/materials.md) completely and follow it. Alt's public API does not expose raw slide attachments. An Alt-generated summary may indirectly contain slide-derived content, but never present that as direct PDF analysis. For direct page-level analysis, use only material actually available on the Notion class page. As observed in Alt desktop 0.11.1, its slide import path accepts PDF rather than PPT/PPTX; later versions may differ.

## Optional local Alt material discovery

When a run occurs on the same authorized Mac as Alt Desktop and the repository helper exists, `npm run --silent alt:inspect -- --json` may be used to discover locally cached slide PDFs. The helper is an unofficial, read-only adapter over Alt's private PowerSync schema. Treat its output and local paths as private, never expose note or component identifiers, and never read Alt tokens, recording paths, transcript bodies, summary bodies, or memo bodies through that adapter.

Local discovery does not by itself establish the destination. Copy a discovered PDF into Notion `수업 자료` only when the class is auto-note-enabled and there is one conservative match using the configured course alias plus lecture date or overlapping class slot. Verify the file SHA-256 and check that the same byte hash is not already attached. If the match is ambiguous, leave both Alt and Notion unchanged and report the candidate names once. After a successful attachment, refetch the class page and use that durable Notion file as the authoritative material source. The local adapter is an early-discovery convenience, not a replacement for Notion storage or the normal Alt webhook.

## Build the source inventory first

Ground the workbook only in the preserved Alt summary, transcript, and successfully read current course materials. External facts are off by default. Do not fill a gap from general knowledge merely because it seems obvious.

Before drafting, split the available sources into atomic units: definitions; formulas and values; mechanisms or algorithms; causal or relational explanations; examples and state traces; instructor emphasis, corrections, or Q&A; assessment or assignment announcements; and essential visual evidence. Give each unit an importance weight:

- `3 — critical`: definitions, formulas, algorithms, key diagrams, explicit instructor emphasis or correction, and assessment/deadline claims
- `2 — supporting`: substantive explanations, comparisons, examples, and boundary cases
- `1 — incidental`: repetition, transitions, anecdotes without instructional content, and decorative material

Map every critical unit and all substantive supporting units to the planned workbook. Critical coverage must be 100 percent and weighted coverage must be at least 92 percent. A weight-2 omission needs a reason in the internal coverage ledger. A weight-3 item may be omitted only when its source is unreadable or genuinely contradictory, in which case expose it in `확인 필요` and do not claim completion.

The transcript is authoritative for what the instructor said, including emphasis, corrections, exam scope, deadlines, and assignment instructions. A directly available PDF is authoritative for displayed notation, formulas, tables, diagrams, and slide order. If they conflict, preserve both source claims and explain the unresolved conflict; do not silently choose or blend them. Correct an apparent STT error only when an independent source or a deterministic calculation establishes the correction, and record that correction in the evidence map.

A missing Alt source does not block a material-only workbook when the auto-note checkbox is on and at least one current PDF was read successfully. Mark the child workbook state `material_only`, use only PDF-supported claims, and do not attribute anything to the instructor. If an active Alt source later arrives, rebuild the same child page from both sources and advance it to `active`.

## Write a `workbook-v3` lecture workbook

Create or replace one continuous Korean workbook in the `AI 학습 교재` child page, not a short outline and not a collection of disconnected summary cards. It must be possible to learn the available lecture content, practise it, and check the work without reopening the transcript or PDF.

Use this order:

1. Title and `이 회차가 끝나면 할 수 있어야 하는 것`: three to six observable learning outcomes.
2. `개념을 따라가는 본문`: three to seven broad chapters in the lecture's logical order.
3. `한 장 복습`: one compact relationship map, comparison table, or rule sheet that adds retrieval value instead of repeating whole paragraphs.
4. `수업에서 명시된 평가·과제`: include only when the sources actually contain an assessment, deadline, or instructor emphasis. Never label generated questions as expected exam questions.
5. `연습문제`: source-grounded generated practice without answers or leading hints.
6. A collapsed `정답·해설` containing the separate answer key.
7. A collapsed `확인 필요` only when a genuine uncertainty or source conflict remains.
8. A collapsed `근거 지도` and collapsed `자동화 정보`.

The Worker-owned `원본 자료` remains on the parent class page beneath `원본 동기화`; never duplicate it into the child workbook.

Keep the explanatory body flowing. Use only three to seven meaningful chapter headings; do not create a heading and a one-line bullet for every small concept. Prefer coherent paragraphs of roughly three to seven sentences. As a fragmentation check, headings should not normally occur more often than once per 600–900 Korean characters, and bullets should occupy no more than roughly 25 percent of the explanatory body. These are readability checks rather than reasons to pad the note.

For each substantive concept, cover every applicable dimension: intuition or definition, why it matters, how it works, a concrete source-supported example or trace, a common confusion or boundary condition, and how it connects to the next concept. Definitions, motivation, and mechanism are mandatory when they apply. Across all applicable dimensions, completeness must be at least 85 percent. A mathematical, algorithmic, or procedural concept needs a fully worked derivation, calculation, or state trace whenever the sources provide enough information to construct one safely.

Use small tables, equations, code traces, and selected PDF images only when they make a relationship materially clearer. Set up each visual in prose, place it immediately after that explanation, then state what the reader should notice. Do not create a detached slide gallery, repeat an image, or repeat the same fact across the opening outcomes, body, recap, and problems.

Use source-adjusted length as a diagnostic, not a quota. Excluding exercises, answers, evidence, automation metadata, and raw sources, a short lecture will often need 3,000–6,000 Korean characters, a standard 31–90 minute or 16–50 slide lecture 6,000–12,000 characters, and a dense lecture 10,000–18,000 characters. A shorter body is acceptable only when the coverage and depth gates pass. Review an overlong body for duplication; when dense source material genuinely requires more, use `Part A` and `Part B` within the same managed workbook instead of compressing concepts into one-line bullets.

## Generate exercises and separate answers

For a standard lecture, create 8–14 exercises; use 6–8 for a short source and 12–18 for a dense source. Adapt the form to the subject while aiming for:

- 25–35 percent definition and concept retrieval
- 40–50 percent application, calculation, code or state tracing
- 20–30 percent comparison, error diagnosis, explanation, or synthesis

Include at least two `why` questions, at least one misconception-correction question, one application question for every central formula or algorithm, and from the second lecture onward at least one supported connection to an earlier lecture. Call them generated practice questions, never authentic or predicted exam questions. Every question must be solvable from the workbook and its sources. Independently recalculate new numeric examples and verify their units.

Keep all solutions out of `연습문제`. Put one collapsed `정답·해설` after the complete problem set, with stable `P1` to `A1` correspondence. Each answer includes the result, the reasoning path, required points or a compact scoring guide, and a likely wrong approach. For multiple choice, explain why each distractor fails. Reject any exercise with an ambiguous answer, an answer that depends on outside knowledge, or a mismatch between the question and solution.

## Keep evidence traceable without interrupting reading

Do not append `[Alt revision N]` or `[파일명, p. N]` citations to normal body sentences. Put provenance in the collapsed `근거 지도` instead. Map each broad chapter, worked example, formula or exact value, and assessment announcement to:

- an Alt revision plus timestamp when available; otherwise a deterministic transcript chunk or paragraph range and a short opening anchor
- the exact sanitized PDF filename and verified page range when applicable
- `교육적 재구성` for a generated analogy, derivation, recap, or exercise, with the input source units it uses
- any source conflict, deterministic STT correction, or excluded weight-2 unit and its reason

Never guess a timestamp or page number. A missing verified location must say that the location could not be verified. Keep the main body natural and uninterrupted; `근거 지도` is the audit path, not a second copy of the note.

## Update the cumulative course workbook

After a class workbook changes, update the mapped course root's managed child page `AI 과목 교재` in the same successful run. Do not append a date-ordered pile of summaries. Rebuild it from current, non-deleted `AI 학습 교재` children around a stable concept registry and concept graph. Merge each new lesson as a new concept, a deeper treatment, a correction, or a connection to existing concepts.

The cumulative workbook contains a one-screen concept map, integrated concept chapters with representative worked examples, cumulative misconceptions and boundary conditions, a deduplicated mixed problem bank with a collapsed answer key, a linked class-page index, and collapsed course-level evidence and unresolved points. It must be detailed enough for exam-period review while allowing the reader to follow a class-page link for the full lecture treatment.

Do not copy every class exercise into the course problem bank. Select problems by distinct learning objective, mix concepts across lectures, and remove redundant variants. After every rebuild, perform a regression audit so no previously supported concept, correction, policy, or class-page link disappears without a deletion or source replacement. Preserve the protected `내 과목 정리` child, the course root's `수업별 회차` heading and linked view, and every block outside `AI 과목 교재`.

After a deletion marker, remove every class-workbook claim managed solely from the deleted source, rebuild a material-only workbook only when current PDFs still support it, and rebuild the course workbook from all remaining current sources. Preserve the deletion marker. Never recover deleted facts from an older generated workbook.

## Quality gate and publication

Score the staged class workbook before publishing:

| Category | Points | Passing evidence |
|---|---:|---|
| Factual grounding | 25 | No unsupported factual claim; values, formulas, and units rechecked; conflicts and corrections exposed; evidence locations valid |
| Source coverage | 20 | 100% critical and at least 92% weighted coverage; every PDF page read; instructor corrections, Q&A, and essential visuals represented |
| Teaching depth | 20 | At least 85% applicable concept-dimension coverage; mechanisms, worked reasoning, boundary cases, and concept transitions are clear |
| Exercises and answers | 15 | Required range and mix; core objectives tested; every problem is self-contained; every answer matches and teaches |
| Flow and readability | 10 | Three to seven broad chapters; limited bullets; no repetitive fragments; visuals sit inside the reading flow |
| Preservation and integration | 10 | Parent pages, protected children, and sources untouched; managed child pages identified; course workbook updated without regression; writes are idempotent |

Publish only at 90 points or higher with at least 80 percent of the available points in every category. Independently reread the staged result against the sources and check source-to-note coverage, note-to-source grounding, calculations, question-to-answer alignment, heading and bullet fragmentation, image placement, managed boundaries, and cumulative-course regression. Repair and rescore up to three times.

Treat any of these as a hard failure regardless of score: an unsupported important fact, formula, deadline, or assessment policy; an unread current PDF page; modification of user-owned content; a hidden source conflict; an unsolvable question or wrong answer; a missing or false evidence map; loss of preserved source material; duplicate managed blocks or images; or a changed class workbook without its required course-workbook update.

Stage extraction, rendering, uploads, the complete child workbook, its answer key, evidence map, and the affected course-child rebuild before visible replacement. Only after both child pages and reread verification succeed may the class child's `자동화 정보` advance the source revision, material fingerprint, state, child and managed block identifiers, reviewed/selected slide counts, layout `workbook-v3`, coverage score, QA score, and reflection date. If the quality gate or any read, render, upload, or write step fails, preserve the prior published child workbooks, images, sources, and fingerprints; record an incomplete attempt only where it cannot be mistaken for completion and retry later.

Make every mutation idempotent. A repeated run with the same source revision, material fingerprint, and `workbook-v3` layout must not create duplicate sections, images, exercises, answers, evidence rows, or markers. Report only actionable permission, connection, damaged-source, or repeated quality failures; otherwise finish quietly when nothing changed.
