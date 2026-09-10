---
name: alt-notion-note-curator
description: Curate Alt-synced Notion lecture sources and optional class-page PDFs into consistent Korean class notes and cumulative course summaries. Use for manual or scheduled processing of new Alt revisions or changed course materials; do not use for ingesting recordings or configuring the Cloudflare Worker.
---

# Alt Notion Note Curator

Require a Notion class data source and an exact course-name-to-summary-page mapping. If either is unavailable, request only the missing private configuration; never invent an ID or destination.

Before processing the requested time window, find Worker deletion markers in the class data source. A deletion marker is a `원본 자료` toggle whose first line is `Alt · 삭제됨 · revision N`; it contains no transcript or summary. Process these markers before ordinary notes regardless of class date or auto-note checkbox. Never treat an absent or incomplete source as a deletion unless this explicit marker exists.

For ordinary Alt processing, query class rows in the requested source-revision time window whose configured auto-note checkbox is on. In each page's `AI 수업 노트` section, read the Worker's active `원본 자료` toggle (or legacy `Alt 자동 기록`) and its source revision.

Material changes are not limited by the class-date window: a user may attach a PDF weeks after recording. Across the configured semester data source, inspect every auto-note-enabled class whose `수업 자료` Files property is non-empty or whose managed `자동화 정보` already contains a material fingerprint. The Files property is the guaranteed full-semester discovery path. A PDF block placed only in the page body is supplemental: inspect it when another trigger already made that page a candidate, but do not assume it independently triggers the default semester-wide scan. Compare the source revision and material fingerprint with the managed state. If there is no newer active revision, unprocessed deletion marker, or changed material fingerprint, make no change.

When course materials exist, read [references/materials.md](references/materials.md) and follow it. For every current PDF, maintain the idempotent managed `슬라이드 미리보기` described there. Alt's public API does not expose its raw slide attachments. An Alt-generated summary may indirectly contain slide-derived content, but never present that as direct PDF analysis. For direct page-level analysis, use only material actually available on the Notion class page. As observed in Alt desktop 0.10.1, its slide import path accepts PDF rather than PPT/PPTX; later versions may differ.

When a revision or material fingerprint is new, ground the note only in the preserved Alt summary, transcript, and successfully read current course materials. Write or replace only the managed curation blocks, using this Korean structure:

1. `핵심 요약`: 3–5 concise bullets
2. `핵심 개념`: each item as definition followed by meaning or consequence
3. `상세 정리`: coherent detail suitable for later review
4. `시험·과제 포인트`: include only requirements or emphasis actually stated in the source
5. `확인할 것`: include only genuinely unresolved points

Do not add emojis, checklists, completion states, or duplicate course, professor, room, or time metadata. Preserve the entire source toggle, transcript, Alt summary, page properties, professor field, user-authored blocks, and unrelated managed content. If the auto-note checkbox is off or the source is incomplete, skip ordinary processing without deleting prior work. A deletion marker is the only exception: remove every class-summary block managed from the deleted source, rebuild any remaining class summary only from still-active source toggles, and record the deletion revision in `자동화 정보`. Preserve the deletion marker and all user-authored content. Never recover deleted facts from an older managed summary.

After a successful class-note update, record the processed source revision, material fingerprint, and state (`active` or `deleted`) in `자동화 정보`. Then update only the `통합 요약` section of the mapped course page. For active revisions or material changes, rebuild the affected course section from processed class notes so additions, replacements, and confirmed removals are reflected. After a deletion, rebuild that course's section from all remaining non-deleted processed class notes so removed facts cannot survive in cumulative prose. Use `한눈에`, `핵심 개념`, `시험 대비`, `회차별 흐름`, and, only when needed, `아직 불명확한 점`. Link each included class page. Preserve linked database views and all content outside `통합 요약`.

Make mutations idempotent: do not create a second managed summary, preview toggle, or marker for the same page. If reading, rendering, uploading, or writing a material fails, preserve the prior class note, slide previews, course summary, and material fingerprint; do not advance either the revision or material marker. Report actionable errors; otherwise finish quietly when nothing changed.
