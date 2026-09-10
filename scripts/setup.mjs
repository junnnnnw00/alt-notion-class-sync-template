#!/usr/bin/env node

import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const DEFAULT_OUTPUT = "wrangler.local.jsonc";

function usage() {
  return `Usage:
  npm run setup
  npm run setup -- --check
  npm run setup -- --worker NAME --data-source-id UUID [--force]

Options:
  --worker NAME                 Cloudflare Worker name
  --data-source-id UUID         Notion data source ID (not a database/view ID)
  --date-property NAME          Date property (default: 일시)
  --category-property NAME      Category select property (default: 구분)
  --course-property NAME        Course select/text property (default: 과목)
  --title-property NAME         Title property (default: 이름)
  --auto-note-property NAME     Checkbox property (default: AI 자동 노트)
  --class-category NAME         Select value for classes (default: 수업)
  --time-zone IANA              Timetable time zone (default: Asia/Seoul)
  --output PATH                 Local Wrangler config path
  --force                       Replace an existing output file
  --check                       Validate an existing local config
  --help                        Show this help`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unknown argument: ${item}`);
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    if (["force", "check", "help"].includes(rawKey)) {
      options[rawKey] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    options[rawKey] = value;
    if (inlineValue == null) index += 1;
  }
  return options;
}

function normalizeUuid(value) {
  const compact = String(value).trim().replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error(
      "Notion data source ID must be a 32-character hexadecimal UUID. " +
        "Copy it from Manage data sources in Notion; a database URL or view ID is not sufficient.",
    );
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function validateWorkerName(value) {
  const name = String(value).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error(
      "Worker name must use lowercase letters, numbers, and dashes, with at most 63 characters.",
    );
  }
  return name;
}

function validateTimeZone(value) {
  const timeZone = String(value).trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseConfig(text) {
  return JSON.parse(
    text
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([}\]])/g, "$1"),
  );
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Config must be an object.");
  validateWorkerName(config.name);
  normalizeUuid(config.vars?.NOTION_DATA_SOURCE_ID);
  validateTimeZone(config.vars?.TIME_ZONE || "Asia/Seoul");
  for (const key of [
    "NOTION_DATE_PROPERTY",
    "NOTION_CATEGORY_PROPERTY",
    "NOTION_COURSE_PROPERTY",
    "NOTION_TITLE_PROPERTY",
    "CLASS_CATEGORY",
  ]) {
    if (typeof config.vars?.[key] !== "string" || !config.vars[key].trim()) {
      throw new Error(`Missing non-empty vars.${key}`);
    }
  }
  const binding = config.durable_objects?.bindings?.find(
    (item) => item.name === "SYNC_COORDINATOR" && item.class_name === "SyncCoordinator",
  );
  if (!binding) throw new Error("Missing SYNC_COORDINATOR Durable Object binding.");
}

async function checkConfig(outputPath) {
  const config = parseConfig(await readFile(outputPath, "utf8"));
  validateConfig(config);
  console.log(`Configuration is valid: ${outputPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const outputPath = path.resolve(options.output || DEFAULT_OUTPUT);
  if (options.check) {
    await checkConfig(outputPath);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const terminal = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = async (label, fallback, key) => {
    const provided = options[key];
    if (provided != null) return String(provided).trim();
    if (!terminal) {
      if (fallback != null) return fallback;
      throw new Error(`--${key} is required in non-interactive mode.`);
    }
    const answer = (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback;
  };

  try {
    if ((await exists(outputPath)) && !options.force) {
      if (!terminal) throw new Error(`${outputPath} already exists. Pass --force to replace it.`);
      const answer = (await terminal.question(`${outputPath} already exists. Replace it? [y/N]: `))
        .trim()
        .toLowerCase();
      if (!new Set(["y", "yes"]).has(answer)) {
        console.log("No changes made.");
        return;
      }
    }

    const workerName = validateWorkerName(
      await ask("Cloudflare Worker name", "alt-notion-class-sync", "worker"),
    );
    const dataSourceId = normalizeUuid(
      await ask("Notion data source ID", null, "data-source-id"),
    );
    const dateProperty = await ask("Date property", "일시", "date-property");
    const categoryProperty = await ask("Category property", "구분", "category-property");
    const courseProperty = await ask("Course property", "과목", "course-property");
    const titleProperty = await ask("Title property", "이름", "title-property");
    const autoNoteProperty = await ask(
      "AI auto-note checkbox property",
      "AI 자동 노트",
      "auto-note-property",
    );
    const classCategory = await ask("Class category value", "수업", "class-category");
    const timeZone = validateTimeZone(
      await ask("Timetable IANA time zone", "Asia/Seoul", "time-zone"),
    );

    const config = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: workerName,
      main: "src/index.ts",
      compatibility_date: "2026-09-08",
      workers_dev: true,
      keep_vars: true,
      vars: {
        NOTION_DATA_SOURCE_ID: dataSourceId,
        NOTION_DATE_PROPERTY: dateProperty,
        NOTION_CATEGORY_PROPERTY: categoryProperty,
        NOTION_COURSE_PROPERTY: courseProperty,
        NOTION_TITLE_PROPERTY: titleProperty,
        NOTION_AUTO_NOTE_PROPERTY: autoNoteProperty,
        CLASS_CATEGORY: classCategory,
        TIME_ZONE: timeZone,
        MATCH_WINDOW_MINUTES: "90",
        RECONCILE_LOOKBACK_HOURS: "48",
        RECONCILE_INTERVAL_MINUTES: "15",
        FULL_RECONCILE_INTERVAL_HOURS: "24",
      },
      durable_objects: {
        bindings: [{ name: "SYNC_COORDINATOR", class_name: "SyncCoordinator" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SyncCoordinator"] }],
    };
    validateConfig(config);
    await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(outputPath, 0o600);

    const relativeConfig = path.relative(process.cwd(), outputPath) || DEFAULT_OUTPUT;
    const quotedConfig = JSON.stringify(relativeConfig);
    const usesDefaultOutput = path.resolve(outputPath) === path.resolve(DEFAULT_OUTPUT);
    console.log(`\nCreated ${relativeConfig}. It contains no API keys.`);
    console.log(
      usesDefaultOutput
        ? "This default local config is ignored by Git."
        : "If this is a project-local path, add it to .gitignore before entering account IDs.",
    );
    console.log("Next:");
    console.log("  npx wrangler login");
    console.log(`  npx wrangler secret put ALT_API_KEY --config ${quotedConfig}`);
    console.log(`  npx wrangler secret put NOTION_API_TOKEN --config ${quotedConfig}`);
    console.log(
      usesDefaultOutput
        ? "  npm run deploy"
        : `  npx wrangler deploy --config ${quotedConfig}`,
    );
    console.log("Then register the deployed /webhooks/alt URL in Alt and run:");
    console.log(`  npx wrangler secret put ALT_WEBHOOK_SECRET --config ${quotedConfig}`);
  } finally {
    terminal?.close();
  }
}

main().catch((error) => {
  console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
