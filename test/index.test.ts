import { describe, expect, it, vi } from "vitest";
import {
  SyncCoordinator,
  canonicalSourceSectionHeadings,
  chooseClassCandidate,
  collectFullAltNoteInventory,
  deletionMarkerNeeded,
  deletedNoteState,
  deletedSourceToggleChildBlocks,
  fullInventoryQueryPath,
  inspectSourceHeadingLayout,
  koreaDayBounds,
  missingInventoryDeletionEvents,
  notionAutoNoteEnabled,
  operationalErrorCode,
  purgeUnmatchedBeforeDeletedSourceSync,
  publicSyncStatus,
  reconcileEventForNote,
  shouldProcessRevision,
  shouldProcessStoredRevision,
  shouldRetryMissingAltContent,
  skippedAutoNoteState,
  sourceReplacementAnchor,
  sourceToggleChildBlocks,
  summaryMarkdownToBlocks,
  timeZoneDayBounds,
  verifyAltSignature,
  type AltNote,
  type ClassCandidate,
  type FullInventoryTrackedRow,
  type FullInventoryUnmatchedRow,
} from "../src/index";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function blockText(block: { type: string; [key: string]: unknown }): string {
  const value = block[block.type] as {
    rich_text?: Array<{ text?: { content?: string } }>;
  };
  return value.rich_text?.[0]?.text?.content ?? "";
}

function headingBlock(
  type: "heading_1" | "heading_2" | "heading_3",
  id: string,
  text: string,
): { id: string; type: string; [key: string]: unknown } {
  return {
    id,
    type,
    [type]: { rich_text: [{ plain_text: text }] },
  };
}

describe("Alt webhook verification", () => {
  it("accepts a current valid Standard Webhooks signature", async () => {
    const secretBytes = new Uint8Array([1, 3, 5, 7, 9, 11, 13, 15]);
    const secret = `whsec_${encodeBase64Url(secretBytes)}`;
    const body = JSON.stringify({ event_id: "evt_1" });
    const timestamp = "1788825600";
    const message = `msg_1.${timestamp}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
    );
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,invalid v1,${encodeBase64(digest)}`,
    });

    await expect(
      verifyAltSignature(headers, body, secret, Number(timestamp) * 1000),
    ).resolves.toBe(true);
  });

  it("rejects stale signatures", async () => {
    const secretBytes = new Uint8Array([1, 2, 3]);
    const secret = `whsec_${encodeBase64Url(secretBytes)}`;
    const body = "{}";
    const timestamp = "100";
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`msg_1.${timestamp}.${body}`),
      ),
    );
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${encodeBase64(digest)}`,
    });

    await expect(
      verifyAltSignature(headers, body, secret, Number(timestamp) * 1000),
    ).resolves.toBe(true);
    await expect(
      verifyAltSignature(
        headers,
        body,
        secret,
        Number(timestamp) * 1000 + 5 * 60_000 + 1,
      ),
    ).resolves.toBe(false);
  });
});

describe("public health response", () => {
  it("replaces raw incremental and full reconciliation errors with booleans", () => {
    expect(
      publicSyncStatus({
        pendingEvents: 1,
        lastReconcileError: "sensitive note title: API failed",
        lastFullReconcileError: "another sensitive error",
      }),
    ).toEqual({
      pendingEvents: 1,
      hasReconcileError: true,
      hasFullReconcileError: true,
    });
    expect(publicSyncStatus({ lastReconcileError: null })).toEqual({
      hasReconcileError: false,
      hasFullReconcileError: false,
    });
  });
});

describe("operational error privacy", () => {
  it("reduces sensitive failure messages to categorical codes", () => {
    const noteId = "alt-note-private-987654321";
    const pageId = "notion-page-private-123456789";
    const providerMessage =
      "provider said user@example.com cannot access a private resource";

    const results = [
      operationalErrorCode(
        new Error(`Alt note ${noteId} has no ready transcript or summary`),
      ),
      operationalErrorCode(
        new Error(`Could not create note container on ${pageId}`),
      ),
      operationalErrorCode(new Error(providerMessage)),
    ];

    expect(results).toEqual([
      "alt_content_not_ready",
      "notion_note_container_failed",
      "internal_error",
    ]);
    expect(JSON.stringify(results)).not.toContain(noteId);
    expect(JSON.stringify(results)).not.toContain(pageId);
    expect(JSON.stringify(results)).not.toContain(providerMessage);
  });

  it("uses safe transport categories without including error text", () => {
    const timeout = new Error("request included a private URL");
    timeout.name = "TimeoutError";

    expect(operationalErrorCode(timeout)).toBe("provider_timeout");
    expect(
      operationalErrorCode(new TypeError("fetch leaked a private URL")),
    ).toBe("provider_network_error");
  });

  it("stores and logs only the safe code when event processing fails", async () => {
    const now = Date.parse("2030-01-15T06:00:00.000Z");
    const future = now + 60 * 60_000;
    const eventId = "event-private-24680";
    const noteId = "note-private-13579";
    const pageId = "page-private-11223";
    const providerBody = JSON.stringify({
      error: `Alt ${noteId} cannot update Notion ${pageId}`,
    });
    const syncState = new Map<string, string>([
      ["next_reconcile_at", String(future)],
      ["next_full_reconcile_at", String(future)],
    ]);
    let storedLastError: string | null = null;
    let legacyRedaction: string | null = null;
    const sql = {
      exec(query: string, ...bindings: unknown[]): unknown[] {
        if (query.includes("SELECT value FROM sync_state WHERE key = ?")) {
          const value = syncState.get(String(bindings[0]));
          return value == null ? [] : [{ value }];
        }
        if (query.includes("INSERT INTO sync_state (key, value) VALUES (?, ?)")) {
          syncState.set(String(bindings[0]), String(bindings[1]));
          return [];
        }
        if (
          query.includes("SELECT event_id, event_json, attempts") &&
          query.includes("FROM events")
        ) {
          return [
            {
              event_id: eventId,
              event_json: JSON.stringify({
                event_id: eventId,
                event_type: "note.updated",
                occurred_at: "2030-01-15T05:59:00.000Z",
                data: { note_id: noteId, revision: 1 },
              }),
              attempts: 0,
            },
          ];
        }
        if (query.includes("SET attempts = ?, available_at = ?, last_error = ?")) {
          storedLastError = String(bindings[2]);
          return [];
        }
        if (
          query.includes("SET last_error = ?") &&
          query.includes("WHERE last_error IS NOT NULL")
        ) {
          legacyRedaction = String(bindings[0]);
          return [];
        }
        if (query.includes("SELECT MIN(available_at) AS available_at")) {
          return [{ available_at: null }];
        }
        return [];
      },
    };
    const durableObjectState = {
      storage: {
        sql,
        getAlarm: async () => null,
        setAlarm: async (_scheduledTime: number) => undefined,
      },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
      waitUntil: (_promise: Promise<unknown>) => undefined,
    } as unknown as ConstructorParameters<typeof SyncCoordinator>[0];
    const env = {
      ALT_API_KEY: "test-alt-api-key",
      NOTION_API_TOKEN: "notion_test",
    } as unknown as ConstructorParameters<typeof SyncCoordinator>[1];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(providerBody, { status: 400 }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const coordinator = new SyncCoordinator(durableObjectState, env);
      await coordinator.alarm();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(legacyRedaction).toBe("legacy_error_redacted");
      expect(storedLastError).toBe("provider_request_rejected");
      const logged = JSON.stringify(consoleSpy.mock.calls);
      expect(logged).toContain("provider_request_rejected");
      expect(logged).not.toContain(eventId);
      expect(logged).not.toContain(noteId);
      expect(logged).not.toContain(pageId);
      expect(logged).not.toContain(providerBody);
    } finally {
      nowSpy.mockRestore();
      consoleSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe("deleted-note privacy", () => {
  it("purges unmatched Alt metadata before a Notion cleanup retry can fail", async () => {
    const operations: string[] = [];
    const storage = {
      sql: {
        exec(query: string, noteId: string) {
          operations.push(`${query}:${noteId}`);
          return [];
        },
      },
    } as unknown as DurableObjectStorage;

    await expect(
      purgeUnmatchedBeforeDeletedSourceSync(storage, "note-private", async () => {
        operations.push("notion-cleanup");
        throw new Error("temporary Notion failure");
      }),
    ).rejects.toThrow("temporary Notion failure");

    expect(operations).toEqual([
      "DELETE FROM unmatched WHERE note_id = ?:note-private",
      "notion-cleanup",
    ]);
  });
});

describe("class matching", () => {
  const candidates: ClassCandidate[] = [
    {
      pageId: "course-alpha",
      url: "https://notion.example/course-alpha",
      title: "Course Alpha",
      course: "Course Alpha",
      start: "2030-01-15T02:00:00.000Z",
      end: "2030-01-15T03:15:00.000Z",
      autoNoteEnabled: true,
    },
    {
      pageId: "course-beta",
      url: "https://notion.example/course-beta",
      title: "Course Beta",
      course: "Course Beta",
      start: "2030-01-15T03:30:00.000Z",
      end: "2030-01-15T04:45:00.000Z",
      autoNoteEnabled: true,
    },
  ];

  it("uses course title and lecture time together", () => {
    const result = chooseClassCandidate(
      { title: "Course Alpha 1주차", ended_at: "2030-01-15T03:17:00.000Z" },
      { segments: [{ speaker: "Speaker", start_ms: 0, end_ms: 4_500_000, text: "" }] },
      candidates,
    );
    expect(result.candidate?.pageId).toBe("course-alpha");
  });

  it("matches a generic phone recording title when the class time is unique", () => {
    const result = chooseClassCandidate(
      { title: "New Note", ended_at: "2030-01-15T04:47:00.000Z" },
      { segments: [{ speaker: null, start_ms: 0, end_ms: 4_400_000, text: "" }] },
      candidates,
    );
    expect(result.candidate?.pageId).toBe("course-beta");
  });

  it("uses the default recording duration when a ready transcript has no segments", () => {
    const note = { title: "New Note", ended_at: "2030-01-15T03:17:00.000Z" };
    const result = chooseClassCandidate(
      note,
      { segments: [] },
      candidates,
    );
    expect(result).toEqual(chooseClassCandidate(note, null, candidates));
  });

  it("refuses a lone time-only candidate when the recording does not overlap it", () => {
    const result = chooseClassCandidate(
      { title: "New Note", ended_at: "2030-01-15T03:45:00.000Z" },
      {
        segments: [
          { speaker: null, start_ms: 0, end_ms: 15 * 60_000, text: "" },
        ],
      },
      [candidates[0]],
    );
    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("ambiguous_class_match");
  });

  it("refuses an ambiguous time-only match", () => {
    const overlapping = [
      candidates[0],
      { ...candidates[0], pageId: "other", title: "Course Gamma", course: "Course Gamma" },
    ];
    const result = chooseClassCandidate(
      { title: "New Note", ended_at: "2030-01-15T03:15:00.000Z" },
      null,
      overlapping,
    );
    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("ambiguous_class_match");
  });
});

describe("Notion output", () => {
  it("defaults to Korean day boundaries and returns UTC ISO timestamps", () => {
    expect(koreaDayBounds(new Date("2030-01-15T15:30:00.000Z"))).toEqual({
      start: "2030-01-15T15:00:00.000Z",
      end: "2030-01-16T15:00:00.000Z",
    });
  });

  it("uses the configured IANA time zone across a spring DST transition", () => {
    const bounds = timeZoneDayBounds(
      new Date("2026-03-08T16:00:00.000Z"),
      "America/New_York",
    );

    expect(bounds).toEqual({
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    });
    expect(Date.parse(bounds.end) - Date.parse(bounds.start)).toBe(23 * 60 * 60 * 1000);
  });

  it("uses the configured IANA time zone across a fall DST transition", () => {
    const bounds = timeZoneDayBounds(
      new Date("2026-11-01T17:00:00.000Z"),
      "America/New_York",
    );

    expect(bounds).toEqual({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    });
    expect(Date.parse(bounds.end) - Date.parse(bounds.start)).toBe(25 * 60 * 60 * 1000);
  });

  it("rejects invalid IANA time zones", () => {
    expect(() =>
      timeZoneDayBounds(new Date("2030-01-15T15:30:00.000Z"), "Not/A_Zone"),
    ).toThrow("Invalid IANA time zone");
  });

  it("turns summary markdown into readable blocks without checkboxes", () => {
    const blocks = summaryMarkdownToBlocks(
      "# 핵심 개념\n\n- [ ] 복습하기\n- **정규화** 이해\n\n> 시험 범위",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_2",
      "bulleted_list_item",
      "bulleted_list_item",
      "quote",
    ]);
  });

  it("builds one consistent source section and omits a missing summary", () => {
    const withoutSummary = sourceToggleChildBlocks(7, null);
    expect(withoutSummary.map((block) => block.type)).toEqual([
      "paragraph",
      "toggle",
    ]);
    expect(blockText(withoutSummary[0])).toBe("Alt · revision 7");
    expect(blockText(withoutSummary[1])).toBe("전체 녹취");

    const withSummary = sourceToggleChildBlocks(8, "# 핵심 개념\n\n핵심 내용");
    expect(withSummary.map((block) => block.type)).toEqual([
      "paragraph",
      "heading_3",
      "heading_3",
      "paragraph",
      "toggle",
    ]);
    expect(blockText(withSummary[1])).toBe("Alt 요약");
    expect(blockText(withSummary[2])).toBe("핵심 개념");
  });

  it.each(["heading_1", "heading_2", "heading_3"] as const)(
    "recognizes an existing %s source heading",
    (type) => {
      const layout = inspectSourceHeadingLayout([
        headingBlock(type, "source-heading", "원본 동기화"),
      ]);

      expect(layout.sourceHeading).toMatchObject({
        id: "source-heading",
        type,
      });
    },
  );

  it("creates new manual and source headings in canonical H2 form", () => {
    const headings = canonicalSourceSectionHeadings(true);

    expect(headings.map((block) => block.type)).toEqual([
      "heading_2",
      "heading_2",
    ]);
    expect(headings.map(blockText)).toEqual(["직접 필기", "원본 동기화"]);
  });

  it("places a new H2 source section after all nested content of a manual section", () => {
    const layout = inspectSourceHeadingLayout([
      headingBlock("heading_1", "manual", "직접 필기"),
      { id: "intro", type: "paragraph", paragraph: { rich_text: [] } },
      headingBlock("heading_2", "manual-subsection", "세부 필기"),
      { id: "last-manual", type: "paragraph", paragraph: { rich_text: [] } },
      headingBlock("heading_1", "next-section", "다른 섹션"),
    ]);

    expect(layout.manualHeading).toMatchObject({
      id: "manual",
      type: "heading_1",
    });
    expect(layout.manualInsertionAnchorId).toBe("last-manual");
  });

  it("distinguishes empty and non-empty legacy sections across heading levels", () => {
    const empty = inspectSourceHeadingLayout([
      headingBlock("heading_3", "legacy", "AI 수업 노트"),
      headingBlock("heading_2", "next-section", "다른 섹션"),
    ]);
    const nonEmpty = inspectSourceHeadingLayout([
      headingBlock("heading_1", "legacy", "AI 수업 노트"),
      headingBlock("heading_2", "legacy-subsection", "기존 내용"),
      headingBlock("heading_1", "next-section", "다른 섹션"),
    ]);

    expect(empty.legacyHeading).toMatchObject({
      id: "legacy",
      type: "heading_3",
    });
    expect(empty.legacySectionIsEmpty).toBe(true);
    expect(nonEmpty.legacySectionIsEmpty).toBe(false);
  });

  it("defaults automatic notes on only when no checkbox is configured", () => {
    expect(notionAutoNoteEnabled({}, undefined)).toBe(true);
    expect(
      notionAutoNoteEnabled({ "AI 자동 노트": { checkbox: true } }, "AI 자동 노트"),
    ).toBe(true);
    expect(
      notionAutoNoteEnabled({ "AI 자동 노트": { checkbox: false } }, "AI 자동 노트"),
    ).toBe(false);
    expect(notionAutoNoteEnabled({}, "AI 자동 노트")).toBe(false);
  });

  it("advances a skipped note without losing its existing source toggle", () => {
    const next = skippedAutoNoteState(
      9,
      "new-match",
      {
        pageId: "existing-page",
        headingId: "ai-heading",
        containerId: "source-toggle",
        stagedContainerId: null,
        stagedRevision: null,
        revision: 8,
        sourceLayoutVersion: 1,
        summaryIncluded: false,
        deleted: false,
        updatedAt: "before",
      },
      "after",
    );
    expect(next).toMatchObject({
      pageId: "existing-page",
      headingId: "ai-heading",
      containerId: "source-toggle",
      revision: 9,
      sourceLayoutVersion: 1,
      updatedAt: "after",
    });
  });

  it("tracks only the replacement marker for a deleted note", () => {
    const deleted = deletedNoteState(
      10,
      {
        pageId: "class-page",
        headingId: "ai-heading",
        containerId: "source-toggle",
        stagedContainerId: "staged-source-toggle",
        stagedRevision: 10,
        revision: 9,
        sourceLayoutVersion: 2,
        summaryIncluded: true,
        deleted: false,
        updatedAt: "before",
      },
      "deletion-marker",
      "after",
    );
    expect(deleted).toEqual({
      pageId: "class-page",
      headingId: "ai-heading",
      containerId: "deletion-marker",
      stagedContainerId: null,
      stagedRevision: null,
      revision: 10,
      sourceLayoutVersion: 4,
      summaryIncluded: false,
      deleted: true,
      updatedAt: "after",
    });
  });

  it("builds a minimal deletion marker without source identifiers or content", () => {
    const blocks = deletedSourceToggleChildBlocks(10);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blockText(blocks[0]!)).toBe("Alt · 삭제됨 · revision 10");
    expect(JSON.stringify(blocks)).not.toContain("note_");
    expect(JSON.stringify(blocks)).not.toContain("강의 제목");
  });

  it("creates deletion markers only for a prior source or a marker retry", () => {
    expect(
      deletionMarkerNeeded({
        pageId: "class-page",
        containerId: "source-toggle",
        stagedContainerId: null,
        deleted: false,
      }),
    ).toBe(true);
    expect(
      deletionMarkerNeeded({
        pageId: "class-page",
        containerId: null,
        stagedContainerId: null,
        deleted: true,
      }),
    ).toBe(true);
    expect(
      deletionMarkerNeeded({
        pageId: "class-page",
        containerId: null,
        stagedContainerId: null,
        deleted: false,
      }),
    ).toBe(false);
    expect(deletionMarkerNeeded(null)).toBe(false);
  });

  it("does not turn a skipped note into a marker on a duplicate deletion", () => {
    const skippedDeletion = deletedNoteState(
      10,
      {
        pageId: "class-page",
        headingId: null,
        containerId: null,
        stagedContainerId: null,
        stagedRevision: null,
        revision: 9,
        sourceLayoutVersion: 4,
        summaryIncluded: false,
        deleted: false,
        updatedAt: "before",
      },
      null,
      "after",
    );
    expect(skippedDeletion.pageId).toBeNull();
    expect(skippedDeletion.headingId).toBeNull();
    expect(deletionMarkerNeeded(skippedDeletion)).toBe(false);
  });

  it("replaces the source toggle at its existing sibling position", () => {
    expect(
      sourceReplacementAnchor(
        ["title", "ai-heading", "codex-summary", "source-toggle", "user-note"],
        "source-toggle",
        "ai-heading",
      ),
    ).toBe("codex-summary");
    expect(
      sourceReplacementAnchor(
        ["title", "ai-heading", "user-note"],
        "missing-toggle",
        "ai-heading",
      ),
    ).toBe("ai-heading");
  });
});

describe("missed-event reconciliation", () => {
  const readyNote: AltNote = {
    id: "note-example",
    revision: 7,
    title: "Course Beta",
    status: "ended",
    transcript_status: "ready",
    summary_status: "ready",
    ended_at: "2030-01-15T04:45:00.000Z",
    updated_at: "2030-01-15T04:46:00.000Z",
    deleted_at: null,
  };

  it("builds a full-list request without an incremental cutoff", () => {
    const url = new URL(fullInventoryQueryPath("next page"), "https://alt.test");
    expect(url.pathname).toBe("/notes");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("include_deleted")).toBe("true");
    expect(url.searchParams.get("cursor")).toBe("next page");
    expect(url.searchParams.has("updated_after")).toBe(false);
  });

  it("finishes cursor pagination before returning the full inventory", async () => {
    const pendingNote: AltNote = {
      ...readyNote,
      id: "pending-but-visible",
      revision: 1,
      status: "pending",
      transcript_status: "pending",
      summary_status: "pending",
    };
    const cursors: Array<string | null> = [];
    const notes = await collectFullAltNoteInventory(async (cursor) => {
      cursors.push(cursor);
      return cursor == null
        ? { notes: [pendingNote], has_more: true, next_cursor: "page-2" }
        : { notes: [readyNote], has_more: false, next_cursor: null };
    }, 2);

    expect(cursors).toEqual([null, "page-2"]);
    expect(notes.map((note) => note.id)).toEqual([
      "pending-but-visible",
      "note-example",
    ]);
  });

  it("rejects an inventory that still has more pages at the safety limit", async () => {
    let page = 0;
    await expect(
      collectFullAltNoteInventory(async () => {
        page += 1;
        return {
          notes: [readyNote],
          has_more: true,
          next_cursor: `page-${page + 1}`,
        };
      }, 2),
    ).rejects.toThrow("pagination safety limit");
    expect(page).toBe(2);
  });

  it("rejects a repeated full-inventory cursor", async () => {
    await expect(
      collectFullAltNoteInventory(async (cursor) => ({
        notes: [readyNote],
        has_more: true,
        next_cursor: cursor ?? "same-cursor",
      }), 2),
    ).rejects.toThrow("repeated a cursor");
  });

  it("creates deterministic access-loss events only for old missing records", () => {
    const tracked: FullInventoryTrackedRow[] = [
      {
        note_id: "missing-tracked",
        revision: 7,
        deleted: 0,
        container_id: "missing-source-toggle",
        source_layout_version: 3,
        updated_at: "2030-01-15T05:00:00.000Z",
      },
      {
        note_id: "still-visible",
        revision: 3,
        deleted: 0,
        container_id: "visible-source-toggle",
        source_layout_version: 3,
        updated_at: "2030-01-15T05:00:00.000Z",
      },
      {
        note_id: "already-deleted",
        revision: 9,
        deleted: 1,
        container_id: "deletion-marker",
        source_layout_version: 4,
        updated_at: "2030-01-15T05:00:00.000Z",
      },
      {
        note_id: "legacy-deleted-source",
        revision: 5,
        deleted: 1,
        container_id: "legacy-source-toggle",
        source_layout_version: 2,
        updated_at: "2030-01-15T05:00:00.000Z",
      },
      {
        note_id: "created-during-scan",
        revision: 1,
        deleted: 0,
        container_id: "new-source-toggle",
        source_layout_version: 3,
        updated_at: "2030-01-15T06:00:00.001Z",
      },
    ];
    const unmatched: FullInventoryUnmatchedRow[] = [
      {
        note_id: "missing-unmatched",
        payload: JSON.stringify({ revision: 4 }),
        updated_at: "2030-01-15T05:30:00.000Z",
      },
      {
        note_id: "still-visible-unmatched",
        payload: JSON.stringify({ revision: 2 }),
        updated_at: "2030-01-15T05:30:00.000Z",
      },
    ];
    const arguments_: Parameters<typeof missingInventoryDeletionEvents> = [
      "scan-stable",
      "2030-01-15T06:00:00.000Z",
      "2030-01-15T06:01:00.000Z",
      new Set(["still-visible", "still-visible-unmatched"]),
      tracked,
      unmatched,
    ];

    const events = missingInventoryDeletionEvents(...arguments_);
    expect(events.map((event) => [
      event.data.note_id,
      event.data.revision,
      event.data.reason,
    ])).toEqual([
      ["missing-tracked", 7, "access_lost"],
      ["legacy-deleted-source", 5, "access_lost"],
      ["missing-unmatched", 4, "access_lost"],
    ]);
    expect(missingInventoryDeletionEvents(...arguments_)).toEqual(events);
  });

  it("turns a summary-ready note into a deterministic summary event", () => {
    expect(reconcileEventForNote(readyNote)).toEqual({
      event_id: "reconcile:v4:note-example:7:note.summary.generated",
      event_type: "note.summary.generated",
      occurred_at: readyNote.updated_at,
      data: {
        note_id: readyNote.id,
        revision: 7,
        transcript_status: "ready",
        summary_status: "ready",
        source_layout_version: 4,
        reason: null,
      },
    });
  });

  it.each(["pending", "missing", "failed"] as const)(
    "reconciles a transcript-ready note when its summary is %s",
    (summaryStatus) => {
      expect(
        reconcileEventForNote({ ...readyNote, summary_status: summaryStatus })
          ?.event_type,
      ).toBe("note.updated");
    },
  );

  it("waits when neither transcript nor summary is ready", () => {
    expect(
      reconcileEventForNote({
        ...readyNote,
        transcript_status: "pending",
        summary_status: "pending",
      }),
    ).toBeNull();
  });

  it("migrates an equal revision to layout v4 once", () => {
    expect(shouldProcessRevision(7, 3, 7, "note.updated", 4)).toBe(true);
    expect(shouldProcessRevision(7, 4, 7, "note.updated", 4)).toBe(false);
  });

  it("reprocesses an active note at the same revision after a deletion marker", () => {
    expect(
      shouldProcessStoredRevision(true, 7, 4, 7, "note.updated", 4, false),
    ).toBe(true);
    expect(
      shouldProcessStoredRevision(false, 7, 4, 7, "note.updated", 4, false),
    ).toBe(false);
    expect(
      shouldProcessStoredRevision(true, 7, 4, 6, "note.updated", 4, false),
    ).toBe(false);
  });

  it("adds a same-revision summary once and then deduplicates it", () => {
    expect(
      shouldProcessRevision(7, 4, 7, "note.summary.generated", 4, false),
    ).toBe(true);
    expect(
      shouldProcessRevision(7, 4, 7, "note.summary.generated", 4, true),
    ).toBe(false);
  });

  it("retries a v4 migration when Alt detail data is transiently behind", () => {
    const pendingDetail = {
      transcript_status: "pending" as const,
      summary_status: "pending" as const,
    };
    expect(
      shouldRetryMissingAltContent(pendingDetail, {
        event_type: "note.updated",
        data: { source_layout_version: 4 },
      }),
    ).toBe(true);
    expect(
      shouldRetryMissingAltContent(pendingDetail, {
        event_type: "note.updated",
        data: { transcript_status: "ready" },
      }),
    ).toBe(true);
    expect(
      shouldRetryMissingAltContent(pendingDetail, {
        event_type: "note.updated",
        data: {},
      }),
    ).toBe(false);
  });

  it("turns a deleted note into a deterministic deletion event", () => {
    const event = reconcileEventForNote({
      ...readyNote,
      status: "deleted",
      summary_status: "missing",
      deleted_at: "2030-01-15T05:00:00.000Z",
      revision: 8,
    });
    expect(event?.event_type).toBe("note.deleted");
    expect(event?.data.reason).toBe("deleted");
  });

  it("forces a requested reconciliation ahead of a later retry", async () => {
    const now = Date.parse("2030-01-15T06:00:00.000Z");
    const retryAt = now + 5 * 60_000;
    const syncState = new Map<string, string>([
      ["next_reconcile_at", String(retryAt)],
    ]);
    const alarms: number[] = [];
    const sql = {
      exec(query: string, ...bindings: unknown[]): unknown[] {
        if (query.includes("SELECT value FROM sync_state WHERE key = ?")) {
          const value = syncState.get(String(bindings[0]));
          return value == null ? [] : [{ value }];
        }
        if (query.includes("INSERT INTO sync_state (key, value) VALUES (?, ?)")) {
          syncState.set(String(bindings[0]), String(bindings[1]));
          return [];
        }
        if (query.includes("SELECT MIN(available_at) AS available_at")) {
          return [{ available_at: null }];
        }
        return [];
      },
    };
    const durableObjectState = {
      storage: {
        sql,
        getAlarm: async () => retryAt,
        setAlarm: async (scheduledTime: number) => {
          alarms.push(scheduledTime);
        },
      },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
      waitUntil: (_promise: Promise<unknown>) => undefined,
    } as unknown as ConstructorParameters<typeof SyncCoordinator>[0];
    const env = {
      ALT_API_KEY: "test-alt-api-key",
      NOTION_API_TOKEN: "notion_test",
    } as unknown as ConstructorParameters<typeof SyncCoordinator>[1];
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const coordinator = new SyncCoordinator(durableObjectState, env);
      const response = await coordinator.fetch(
        new Request("https://sync-coordinator.internal/start-reconcile", {
          method: "POST",
        }),
      );

      expect(response.status).toBe(202);
      expect(syncState.get("next_reconcile_at")).toBe(String(now));
      expect(alarms).toEqual([now]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
