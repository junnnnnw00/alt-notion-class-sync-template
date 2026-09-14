import { describe, expect, it } from "vitest";

import {
  groupMetadataRows,
  isVerifiedFallbackMatch,
  isPathWithin,
  parseArguments,
  sanitizeNotesForOutput,
} from "../scripts/inspect-local-alt.mjs";

describe("local Alt inspector", () => {
  it("parses repeatable databases and metadata filters", () => {
    const options = parseArguments([
      "--database",
      "/tmp/account one.db",
      "--database",
      "/tmp/account two.db",
      "--title",
      "File Organization",
      "--date",
      "2026-09-07",
      "--json",
    ]);

    expect(options.databases).toEqual([
      "/tmp/account one.db",
      "/tmp/account two.db",
    ]);
    expect(options.title).toBe("File Organization");
    expect(options.date).toBe("2026-09-07");
    expect(options.json).toBe(true);
  });

  it("rejects malformed dates and unknown options", () => {
    expect(() => parseArguments(["--date", "09/07/2026"])).toThrow(
      "--date must use YYYY-MM-DD",
    );
    expect(() => parseArguments(["--include-text"])).toThrow(
      "Unknown option: --include-text",
    );
  });

  it("keeps text bodies out while retaining useful component metadata", () => {
    const notes = groupMetadataRows(
      [
        {
          noteId: "note-1",
          noteTitle: "Database Systems",
          lectureDate: "2026-09-07",
          noteStatus: "draft",
          noteType: "slide",
          noteCreatedAt: "2026-09-07T09:00:00Z",
          noteUpdatedAt: "2026-09-07T10:00:00Z",
          componentId: "component-1",
          componentType: "memo",
          componentTitle: "Memo",
          displayOrder: 0,
          componentCreatedAt: "2026-09-07T09:10:00Z",
          componentUpdatedAt: "2026-09-07T10:00:00Z",
          hasText: 1,
          textBytes: 73524,
          fileRefId: null,
          filePath: null,
          localCachePath: null,
        },
      ],
      { title: "database", date: "2026-09-07" },
    );

    expect(notes).toHaveLength(1);
    expect(notes[0].components[0].text).toEqual({
      present: true,
      bytes: 73524,
      bodyIncluded: false,
    });
    expect(JSON.stringify(notes)).not.toContain("contentText");
  });

  it("does not treat a non-PDF recording as a PDF merely because it is a slide component", () => {
    const notes = groupMetadataRows([
      {
        noteId: "note-1",
        noteTitle: "Database Systems",
        componentId: "component-1",
        componentType: "slides",
        fileRefId: "file-1",
        filePath: "recordings/private.m4a",
        fileName: "private.m4a",
        fileMimeType: "audio/mp4",
      },
    ]);

    expect(notes[0].components[0].pdf).toBeNull();
  });

  it("removes note and component identifiers from the printable inventory", () => {
    const notes = sanitizeNotesForOutput([
      {
        id: "private-note-id",
        title: "Database Systems",
        components: [
          { id: "private-component-id", type: "slides", pdf: null },
        ],
      },
    ]);

    expect(notes).toEqual([
      {
        title: "Database Systems",
        components: [{ type: "slides", pdf: null }],
      },
    ]);
    expect(JSON.stringify(notes)).not.toContain("private-note-id");
    expect(JSON.stringify(notes)).not.toContain("private-component-id");
  });

  it("requires a stored hash and matching size for storage-wide filename fallback", () => {
    const described = { sha256: "a".repeat(64), sizeBytes: 1024 };

    expect(
      isVerifiedFallbackMatch(
        { storedSha256: "A".repeat(64), declaredSizeBytes: 1024 },
        described,
      ),
    ).toBe(true);
    expect(
      isVerifiedFallbackMatch(
        { storedSha256: null, declaredSizeBytes: 1024 },
        described,
      ),
    ).toBe(false);
    expect(
      isVerifiedFallbackMatch(
        { storedSha256: "b".repeat(64), declaredSizeBytes: 1024 },
        described,
      ),
    ).toBe(false);
    expect(
      isVerifiedFallbackMatch(
        { storedSha256: "a".repeat(64), declaredSizeBytes: 2048 },
        described,
      ),
    ).toBe(false);
  });

  it("recognizes only paths contained by the Alt storage root", () => {
    expect(isPathWithin("/tmp/alt/storage/slides/a.pdf", "/tmp/alt/storage")).toBe(
      true,
    );
    expect(isPathWithin("/tmp/alt/secrets/a.pdf", "/tmp/alt/storage")).toBe(false);
  });
});
