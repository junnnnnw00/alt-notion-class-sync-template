#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INVENTORY_SCHEMA_VERSION = 1;
const DEFAULT_DATABASE_DIRECTORY = path.join(
  homedir(),
  "Library",
  "Application Support",
  "alt",
  "data",
  "database",
);
const MAX_SQLITE_OUTPUT_BYTES = 32 * 1024 * 1024;

const REQUIRED_COLUMNS = {
  lecture_notes: [
    "id",
    "title",
    "lecture_date",
    "status",
    "type",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  note_components: [
    "id",
    "note_id",
    "component_type",
    "title",
    "content_text",
    "display_order",
    "file_inode",
    "file_ref_id",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  file_metadata: [
    "inode",
    "file_path",
    "file_name",
    "file_size",
    "mime_type",
    "hash_sha256",
  ],
  file_refs: [
    "id",
    "original_name",
    "mime_type",
    "size_bytes",
    "deleted_at",
  ],
  file_ref_local_files: ["file_ref_id", "file_inode", "local_cache_path"],
};

const INVENTORY_QUERY = `
SELECT
  n.id AS noteId,
  n.title AS noteTitle,
  n.lecture_date AS lectureDate,
  n.status AS noteStatus,
  n.type AS noteType,
  n.created_at AS noteCreatedAt,
  n.updated_at AS noteUpdatedAt,
  c.id AS componentId,
  c.component_type AS componentType,
  c.title AS componentTitle,
  c.display_order AS displayOrder,
  c.created_at AS componentCreatedAt,
  c.updated_at AS componentUpdatedAt,
  CASE
    WHEN c.content_text IS NULL OR length(c.content_text) = 0 THEN 0
    ELSE 1
  END AS hasText,
  COALESCE(length(CAST(c.content_text AS BLOB)), 0) AS textBytes,
  c.file_ref_id AS fileRefId,
  fm.file_path AS filePath,
  fm.file_name AS fileName,
  fm.file_size AS fileSize,
  fm.mime_type AS fileMimeType,
  fm.hash_sha256 AS storedSha256,
  fl.local_cache_path AS localCachePath,
  fr.original_name AS originalName,
  fr.mime_type AS refMimeType,
  fr.size_bytes AS refSize
FROM lecture_notes AS n
LEFT JOIN note_components AS c
  ON c.note_id = n.id
 AND c.deleted_at IS NULL
LEFT JOIN file_ref_local_files AS fl
  ON fl.file_ref_id = c.file_ref_id
LEFT JOIN file_metadata AS fm
  ON fm.inode = COALESCE(c.file_inode, fl.file_inode)
LEFT JOIN file_refs AS fr
  ON fr.id = c.file_ref_id
 AND fr.deleted_at IS NULL
WHERE n.deleted_at IS NULL
ORDER BY n.updated_at DESC, n.id, c.display_order, c.created_at, c.id;
`;

const HELP = `Usage: node scripts/inspect-local-alt.mjs [options]

Read Alt Desktop's local macOS database without modifying it and list active notes,
component metadata, and locally available slide PDFs. Text bodies are never output.

Options:
  --database <path>  Inspect one database instead of auto-discovery. Repeatable.
  --title <text>     Keep notes whose title contains this text (case-insensitive).
  --date <YYYY-MM-DD> Keep notes with this lecture date.
  --json             Print the complete sanitized JSON inventory.
  -h, --help         Show this help.

Without --json, a compact human-readable inventory is printed. The tool is
experimental, macOS-only, and depends on the sqlite3 command-line program.`;

export function parseArguments(argv) {
  const options = {
    databases: [],
    title: null,
    date: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--database": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--database requires a path.");
        }
        options.databases.push(expandHome(value));
        index += 1;
        break;
      }
      case "--title": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--title requires text.");
        }
        options.title = value;
        index += 1;
        break;
      }
      case "--date": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--date requires YYYY-MM-DD.");
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new Error("--date must use YYYY-MM-DD.");
        }
        options.date = value;
        index += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function isPathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function runSqlite(databasePath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "sqlite3",
      ["-readonly", "-json", databasePath, sql],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let killedForSize = false;

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SQLITE_OUTPUT_BYTES) {
        killedForSize = true;
        child.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "sqlite3 was not found. Install the macOS Command Line Tools or sqlite3, then retry.",
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (killedForSize) {
        reject(new Error("sqlite3 output exceeded the 32 MiB safety limit."));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            detail
              ? `sqlite3 could not read ${databasePath}: ${detail}`
              : `sqlite3 exited with status ${code} while reading ${databasePath}.`,
          ),
        );
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      if (!text) {
        resolve([]);
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(Array.isArray(value) ? value : [value]);
      } catch (error) {
        reject(
          new Error(
            `sqlite3 returned invalid JSON for ${databasePath}: ${error.message}`,
          ),
        );
      }
    });
  });
}

async function validateSchema(databasePath) {
  const missing = [];
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const rows = await runSqlite(
      databasePath,
      `SELECT name FROM pragma_table_info('${tableName}');`,
    );
    if (rows.length === 0) {
      missing.push(`${tableName} (table)`);
      continue;
    }
    const columns = new Set(rows.map((row) => row.name));
    for (const columnName of requiredColumns) {
      if (!columns.has(columnName)) {
        missing.push(`${tableName}.${columnName}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Unsupported Alt database schema in ${databasePath}. Missing: ${missing.join(
        ", ",
      )}. Alt's private schema may have changed.`,
    );
  }
}

async function discoverDatabases(explicitDatabases) {
  if (explicitDatabases.length > 0) {
    const resolved = [...new Set(explicitDatabases.map((item) => path.resolve(item)))];
    for (const databasePath of resolved) {
      let details;
      try {
        details = await stat(databasePath);
      } catch (error) {
        throw new Error(`Alt database does not exist: ${databasePath}`, { cause: error });
      }
      if (!details.isFile()) {
        throw new Error(`Alt database is not a regular file: ${databasePath}`);
      }
    }
    return resolved.sort();
  }

  let entries;
  try {
    entries = await readdir(DEFAULT_DATABASE_DIRECTORY, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `No Alt database directory was found at ${DEFAULT_DATABASE_DIRECTORY}. ` +
          "Install and sign in to Alt Desktop, or pass --database.",
      );
    }
    throw error;
  }

  const databases = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("powersync-store.account-") &&
        entry.name.endsWith(".db"),
    )
    .map((entry) => path.join(DEFAULT_DATABASE_DIRECTORY, entry.name))
    .sort();

  if (databases.length === 0) {
    throw new Error(
      `No powersync-store.account-*.db files were found in ${DEFAULT_DATABASE_DIRECTORY}.`,
    );
  }
  return databases;
}

function inferStorageRoot(databasePath) {
  const databaseDirectory = path.dirname(databasePath);
  if (path.basename(databaseDirectory) === "database") {
    return path.join(path.dirname(databaseDirectory), "storage");
  }
  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "alt",
    "data",
    "storage",
  );
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function looksLikePdf(row) {
  return (
    row.fileMimeType === "application/pdf" ||
    row.refMimeType === "application/pdf" ||
    [row.fileName, row.originalName, row.filePath, row.localCachePath].some(
      (value) => typeof value === "string" && value.toLowerCase().endsWith(".pdf"),
    )
  );
}

export function groupMetadataRows(rows, filters = {}) {
  const notes = [];
  let current = null;

  for (const row of rows) {
    if (!current || current.id !== row.noteId) {
      current = {
        id: row.noteId,
        title: row.noteTitle || "Untitled",
        lectureDate: row.lectureDate || null,
        status: row.noteStatus || null,
        type: row.noteType || null,
        createdAt: row.noteCreatedAt || null,
        updatedAt: row.noteUpdatedAt || null,
        components: [],
      };
      notes.push(current);
    }

    if (!row.componentId) continue;
    const mimeType = row.fileMimeType || row.refMimeType || null;
    const sizeBytes = nullableNumber(row.fileSize ?? row.refSize);
    current.components.push({
      id: row.componentId,
      type: row.componentType || null,
      title: row.componentTitle || null,
      displayOrder: nullableNumber(row.displayOrder) ?? 0,
      createdAt: row.componentCreatedAt || null,
      updatedAt: row.componentUpdatedAt || null,
      text: {
        present: Boolean(Number(row.hasText)),
        bytes: nullableNumber(row.textBytes) ?? 0,
        bodyIncluded: false,
      },
      file:
        row.fileRefId || row.filePath || row.localCachePath
          ? {
              originalName: row.originalName || row.fileName || null,
              mimeType,
              sizeBytes,
              localPathIncluded: false,
            }
          : null,
      pdf: looksLikePdf(row)
        ? {
            candidatePaths: [row.filePath, row.localCachePath].filter(Boolean),
            candidateNames: [row.originalName, row.fileName].filter(Boolean),
            storedSha256: row.storedSha256 || null,
            declaredSizeBytes: sizeBytes,
          }
        : null,
    });
  }

  const titleNeedle = filters.title?.toLocaleLowerCase();
  return notes.filter((note) => {
    if (filters.date && note.lectureDate !== filters.date) return false;
    if (titleNeedle && !note.title.toLocaleLowerCase().includes(titleNeedle)) {
      return false;
    }
    return true;
  });
}

export function sanitizeNotesForOutput(notes) {
  return notes.map(({ id: _noteId, components, ...note }) => ({
    ...note,
    components: components.map(({ id: _componentId, ...component }) => component),
  }));
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkPdfFiles(directory, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return output;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkPdfFiles(fullPath, output);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      output.push(fullPath);
    }
  }
  return output;
}

function candidatePathVariants(candidate, storageRoot) {
  if (!candidate) return [];
  if (path.isAbsolute(candidate)) return [path.normalize(candidate)];
  return [path.resolve(storageRoot, candidate)];
}

async function resolveExistingPdf(pdf, storageRoot, getFallbackIndex) {
  let canonicalStorageRoot;
  const declaredStorageRoot = path.resolve(storageRoot);
  try {
    canonicalStorageRoot = await realpath(storageRoot);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        exists: false,
        path: null,
        fileName: pdf.candidateNames[0] || null,
        sizeBytes: pdf.declaredSizeBytes,
        sha256: null,
        storedSha256: pdf.storedSha256,
        hashMatchesStored: null,
        status: "storage_not_found",
      };
    }
    throw error;
  }

  const candidates = [];
  for (const candidate of pdf.candidatePaths) {
    candidates.push(...candidatePathVariants(candidate, storageRoot));
  }

  let sawRejectedPath = false;
  for (const candidate of [...new Set(candidates)]) {
    if (!isPathWithin(candidate, declaredStorageRoot)) {
      sawRejectedPath = true;
      continue;
    }
    try {
      const candidateDetails = await lstat(candidate);
      if (!candidateDetails.isFile() || candidateDetails.isSymbolicLink()) continue;
      const canonicalCandidate = await realpath(candidate);
      if (!isPathWithin(canonicalCandidate, canonicalStorageRoot)) {
        sawRejectedPath = true;
        continue;
      }
      return await describePdf(
        canonicalCandidate,
        candidateDetails,
        pdf.storedSha256,
        "database_path",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const fallbackIndex = await getFallbackIndex();
  let sawUnverifiedFallback = false;
  for (const name of pdf.candidateNames) {
    const matches = fallbackIndex.get(path.basename(name).toLocaleLowerCase()) || [];
    if (matches.length !== 1) continue;
    const candidate = matches[0];
    const details = await lstat(candidate);
    const canonicalCandidate = await realpath(candidate);
    if (!isPathWithin(canonicalCandidate, canonicalStorageRoot)) continue;
    const described = await describePdf(
      canonicalCandidate,
      details,
      pdf.storedSha256,
      "storage_name_lookup",
    );
    if (!isVerifiedFallbackMatch(pdf, described)) {
      sawUnverifiedFallback = true;
      continue;
    }
    return described;
  }

  return {
    exists: false,
    path: null,
    fileName: pdf.candidateNames[0] || null,
    sizeBytes: pdf.declaredSizeBytes,
    sha256: null,
    storedSha256: pdf.storedSha256,
    hashMatchesStored: null,
    status: sawRejectedPath
      ? "path_outside_alt_storage"
      : sawUnverifiedFallback
        ? "unverified_name_match"
        : "file_not_found",
  };
}

async function describePdf(
  filePath,
  details,
  storedSha256,
  resolutionMethod,
) {
  const computedSha256 = await hashFile(filePath);
  return {
    exists: true,
    path: filePath,
    fileName: path.basename(filePath),
    sizeBytes: details.size,
    sha256: computedSha256,
    storedSha256: storedSha256 || null,
    hashMatchesStored: storedSha256
      ? computedSha256.toLowerCase() === String(storedSha256).toLowerCase()
      : null,
    status: "ready",
    resolutionMethod,
  };
}

export function isVerifiedFallbackMatch(pdf, described) {
  if (!pdf.storedSha256 || !described.sha256) return false;
  if (
    String(pdf.storedSha256).toLowerCase() !==
    String(described.sha256).toLowerCase()
  ) {
    return false;
  }
  return (
    pdf.declaredSizeBytes == null ||
    Number(pdf.declaredSizeBytes) === Number(described.sizeBytes)
  );
}

async function enrichPdfs(notes, storageRoot) {
  let fallbackIndexPromise;
  const getFallbackIndex = async () => {
    if (!fallbackIndexPromise) {
      fallbackIndexPromise = (async () => {
        const files = await walkPdfFiles(storageRoot);
        const index = new Map();
        for (const filePath of files) {
          const key = path.basename(filePath).toLocaleLowerCase();
          const matches = index.get(key) || [];
          matches.push(filePath);
          index.set(key, matches);
        }
        return index;
      })();
    }
    return fallbackIndexPromise;
  };

  for (const note of notes) {
    for (const component of note.components) {
      if (!component.pdf) continue;
      const resolved = await resolveExistingPdf(
        component.pdf,
        storageRoot,
        getFallbackIndex,
      );
      component.pdf = resolved;
      if (component.file) {
        component.file.localPathIncluded = resolved.exists;
      }
    }
  }
}

async function inspectDatabase(databasePath, filters, databaseIndex) {
  await validateSchema(databasePath);
  const rows = await runSqlite(databasePath, INVENTORY_QUERY);
  const notes = groupMetadataRows(rows, filters);
  const storageRoot = inferStorageRoot(databasePath);
  await enrichPdfs(notes, storageRoot);

  return {
    databaseLabel: `database-${databaseIndex + 1}`,
    notes: sanitizeNotesForOutput(notes),
  };
}

function summarize(databases) {
  const totals = {
    databases: databases.length,
    notes: 0,
    components: 0,
    pdfs: 0,
    readyPdfs: 0,
    missingPdfs: 0,
    pdfBytes: 0,
  };

  for (const database of databases) {
    totals.notes += database.notes.length;
    for (const note of database.notes) {
      totals.components += note.components.length;
      for (const component of note.components) {
        if (!component.pdf) continue;
        totals.pdfs += 1;
        if (component.pdf.exists) {
          totals.readyPdfs += 1;
          totals.pdfBytes += component.pdf.sizeBytes || 0;
        } else {
          totals.missingPdfs += 1;
        }
      }
    }
  }
  return totals;
}

function safeTerminalText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function printHuman(inventory) {
  console.log("Alt local inventory (read-only; text bodies excluded)");
  for (const database of inventory.databases) {
    console.log(`\nDatabase: ${safeTerminalText(database.databaseLabel)}`);
    if (database.notes.length === 0) {
      console.log("  No matching active notes.");
      continue;
    }
    for (const note of database.notes) {
      console.log(
        `  ${safeTerminalText(note.lectureDate || "no-date")}  ${safeTerminalText(
          note.title,
        )}  [${safeTerminalText(note.status || "unknown")}/${safeTerminalText(
          note.type || "unknown",
        )}]`,
      );
      const componentTypes = note.components.map((component) => component.type).filter(Boolean);
      console.log(`    components: ${componentTypes.join(", ") || "none"}`);
      for (const component of note.components) {
        if (!component.pdf) continue;
        if (component.pdf.exists) {
          console.log(`    PDF: ${safeTerminalText(component.pdf.path)}`);
          console.log(`         sha256 ${component.pdf.sha256}`);
        } else {
          console.log(
            `    PDF: ${safeTerminalText(component.pdf.fileName || "unknown")} (${component.pdf.status})`,
          );
        }
      }
    }
  }
  console.log(
    `\nTotals: ${inventory.totals.notes} notes, ${inventory.totals.components} components, ` +
      `${inventory.totals.readyPdfs}/${inventory.totals.pdfs} PDFs ready`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (process.platform !== "darwin") {
    throw new Error(
      `Unsupported platform: ${process.platform}. Local Alt inspection currently supports macOS only.`,
    );
  }

  const databasePaths = await discoverDatabases(options.databases);
  const databases = [];
  for (const [databaseIndex, databasePath] of databasePaths.entries()) {
    databases.push(
      await inspectDatabase(databasePath, {
        title: options.title,
        date: options.date,
      }, databaseIndex),
    );
  }

  const inventory = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "Alt Desktop local PowerSync database (unofficial, read-only)",
    mode: "metadata-and-pdf-paths-only",
    privacy: {
      textBodiesIncluded: false,
      userAndChannelIdentifiersIncluded: false,
      recordingPathsIncluded: false,
      serverTokensAccessed: false,
      accountDatabasePathsIncluded: false,
      absolutePdfPathsIncluded: true,
      noteAndComponentIdentifiersIncluded: false,
    },
    filters: {
      title: options.title,
      date: options.date,
    },
    databases,
    totals: summarize(databases),
  };

  if (options.json) {
    console.log(JSON.stringify(inventory, null, 2));
  } else {
    printHuman(inventory);
  }
  return 0;
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(`Alt inspection failed: ${error.message}`);
    process.exitCode = 1;
  });
}
