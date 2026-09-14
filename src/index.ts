import { DurableObject } from "cloudflare:workers";

interface Env {
  ALT_API_KEY: string;
  ALT_WEBHOOK_SECRET: string;
  NOTION_API_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
  NOTION_DATE_PROPERTY: string;
  NOTION_CATEGORY_PROPERTY: string;
  NOTION_COURSE_PROPERTY: string;
  NOTION_TITLE_PROPERTY: string;
  NOTION_AUTO_NOTE_PROPERTY?: string;
  CLASS_CATEGORY: string;
  MATCH_WINDOW_MINUTES: string;
  RECONCILE_LOOKBACK_HOURS?: string;
  RECONCILE_INTERVAL_MINUTES?: string;
  FULL_RECONCILE_INTERVAL_HOURS?: string;
  TIME_ZONE?: string;
  COURSE_ALIASES_JSON?: string;
  SYNC_COORDINATOR: DurableObjectNamespace;
}

type AltEventType =
  | "note.ended"
  | "note.summary.generated"
  | "note.updated"
  | "note.deleted"
  | "endpoint.verification"
  | "endpoint.test";

interface AltWebhookEvent {
  event_id: string;
  event_type: AltEventType;
  occurred_at: string;
  data: {
    note_id?: string;
    revision?: number;
    endpoint_id?: string;
    reason?: "deleted" | "access_lost" | null;
    transcript_status?: string;
    summary_status?: string;
    source_layout_version?: number;
  };
}

export interface AltNote {
  id: string;
  revision: number;
  title: string | null;
  status: "pending" | "ended" | "deleted";
  transcript_status: "pending" | "ready" | "empty" | "failed";
  summary_status: "pending" | "ready" | "missing" | "failed";
  ended_at?: string | null;
  updated_at: string;
  deleted_at?: string | null;
}

interface AltTranscriptSegment {
  speaker: string | null;
  start_ms: number;
  end_ms: number;
  text: string;
}

interface AltTranscript {
  note_id: string;
  revision: number;
  text: string;
  segments: AltTranscriptSegment[];
}

interface AltSummary {
  note_id: string;
  revision: number;
  status: "pending" | "ready" | "missing" | "failed";
  markdown: string | null;
}

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name?: string } | null;
  checkbox?: boolean;
  date?: { start: string; end: string | null; time_zone?: string | null } | null;
}

interface NotionRichText {
  type?: string;
  plain_text?: string;
  text?: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
}

interface NotionBlock {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface ClassCandidate {
  pageId: string;
  url: string;
  title: string;
  course: string;
  start: string;
  end: string;
  autoNoteEnabled: boolean;
}

export interface MatchResult {
  candidate: ClassCandidate | null;
  confidence: number;
  reason: string;
}

interface NoteState {
  pageId: string | null;
  headingId: string | null;
  containerId: string | null;
  stagedContainerId: string | null;
  stagedRevision: number | null;
  revision: number;
  sourceLayoutVersion: number;
  summaryIncluded: boolean;
  deleted: boolean;
  updatedAt: string;
}

type PendingEventRow = Record<string, SqlStorageValue> & {
  event_id: string;
  event_json: string;
  attempts: number;
};

type NoteStateRow = Record<string, SqlStorageValue> & {
  note_id: string;
  page_id: string | null;
  heading_id: string | null;
  container_id: string | null;
  staged_container_id: string | null;
  staged_revision: number | null;
  revision: number;
  source_layout_version: number;
  summary_included: number;
  deleted: number;
  updated_at: string;
};

type RetiredContainerRow = Record<string, SqlStorageValue> & {
  block_id: string;
};

type MinAvailableRow = Record<string, SqlStorageValue> & {
  available_at: number | null;
};

type CountRow = Record<string, SqlStorageValue> & {
  count: number;
};

type ValueRow = Record<string, SqlStorageValue> & {
  value: string;
};

export interface FullInventoryTrackedRow
  extends Record<string, SqlStorageValue> {
  note_id: string;
  revision: number;
  deleted: number;
  container_id: string | null;
  source_layout_version: number;
  updated_at: string;
}

export interface FullInventoryUnmatchedRow
  extends Record<string, SqlStorageValue> {
  note_id: string;
  payload: string;
  updated_at: string;
}

interface AltNoteList {
  notes: AltNote[];
  has_more: boolean;
  next_cursor?: string | null;
}

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Provider request failed with ${status}`);
  }
}

const ALT_API_BASE = "https://public-api.altalt.io/v1";
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const KOREA_TIME_ZONE = "Asia/Seoul";
const DAY_BOUND_SEARCH_STEP_MS = 6 * 60 * 60 * 1000;
const MAX_DAY_BOUND_SEARCH_MS = 8 * 24 * 60 * 60 * 1000;
const PROCESSED_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;
const NOTION_PACE_MS = 360;
const DEFAULT_CLASS_DURATION_MS = 75 * 60 * 1000;
const MAX_NOTION_BATCH_BLOCKS = 100;
const MAX_NOTION_BATCH_BYTES = 400_000;
const MAX_EVENTS_PER_ALARM = 1;
const API_REQUEST_TIMEOUT_MS = 15_000;
const RECONCILE_OVERLAP_MS = 10 * 60 * 1000;
const DEFAULT_RECONCILE_LOOKBACK_HOURS = 48;
const DEFAULT_RECONCILE_INTERVAL_MINUTES = 15;
const DEFAULT_FULL_RECONCILE_INTERVAL_HOURS = 24;
const RECONCILE_FAILURE_RETRY_MS = 5 * 60 * 1000;
const MAX_RECONCILE_PAGES = 25;
const MAX_FULL_RECONCILE_PAGES = 25;
const SOURCE_LAYOUT_VERSION = 4;
const MANUAL_NOTES_HEADING = "직접 필기";
const SOURCE_SYNC_HEADING = "원본 동기화";
const LEGACY_AI_NOTES_HEADING = "AI 수업 노트";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      let sync: unknown = null;
      try {
        const id = env.SYNC_COORDINATOR.idFromName(env.NOTION_DATA_SOURCE_ID);
        const response = await env.SYNC_COORDINATOR.get(id).fetch(
          "https://sync-coordinator.internal/status",
        );
        if (response.ok) sync = publicSyncStatus(await response.json());
      } catch {
        sync = { status: "unavailable" };
      }
      return jsonResponse({
        ok: true,
        configured: {
          altApi: Boolean(env.ALT_API_KEY),
          altWebhook: Boolean(env.ALT_WEBHOOK_SECRET),
          notion: Boolean(env.NOTION_API_TOKEN),
          coordinator: Boolean(env.SYNC_COORDINATOR),
        },
        sync,
      });
    }

    if (url.pathname !== "/webhooks/alt") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!env.ALT_WEBHOOK_SECRET) {
      return new Response("Webhook secret is not configured", { status: 503 });
    }

    const rawBody = await request.text();
    if (rawBody.length > 64_000) {
      return new Response("Payload too large", { status: 413 });
    }
    const valid = await verifyAltSignature(
      request.headers,
      rawBody,
      env.ALT_WEBHOOK_SECRET,
    );
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    let event: AltWebhookEvent;
    try {
      event = JSON.parse(rawBody) as AltWebhookEvent;
      validateWebhookEvent(event);
    } catch {
      return new Response("Invalid event", { status: 400 });
    }

    if (
      event.event_type === "endpoint.verification" ||
      event.event_type === "endpoint.test"
    ) {
      const id = env.SYNC_COORDINATOR.idFromName(env.NOTION_DATA_SOURCE_ID);
      ctx.waitUntil(
        env.SYNC_COORDINATOR.get(id).fetch(
          "https://sync-coordinator.internal/start-reconcile",
          { method: "POST" },
        ),
      );
      return new Response(null, { status: 204 });
    }

    const id = env.SYNC_COORDINATOR.idFromName(env.NOTION_DATA_SOURCE_ID);
    const coordinator = env.SYNC_COORDINATOR.get(id);
    return coordinator.fetch("https://sync-coordinator.internal/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });
  },
} satisfies ExportedHandler<Env>;

export class SyncCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          event_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          processed_at INTEGER,
          last_error TEXT
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS events_due
        ON events(status, available_at, created_at)
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          note_id TEXT PRIMARY KEY,
          page_id TEXT,
          heading_id TEXT,
          container_id TEXT,
          staged_container_id TEXT,
          staged_revision INTEGER,
          revision INTEGER NOT NULL DEFAULT -1,
          source_layout_version INTEGER NOT NULL DEFAULT 1,
          summary_included INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        )
      `);
      const noteColumns = Array.from(
        sql.exec<Record<string, SqlStorageValue> & { name: string }>(
          `PRAGMA table_info(notes)`,
        ),
      );
      if (!noteColumns.some((column) => column.name === "source_layout_version")) {
        sql.exec(
          `ALTER TABLE notes
           ADD COLUMN source_layout_version INTEGER NOT NULL DEFAULT 1`,
        );
      }
      if (!noteColumns.some((column) => column.name === "summary_included")) {
        sql.exec(
          `ALTER TABLE notes
           ADD COLUMN summary_included INTEGER NOT NULL DEFAULT 0`,
        );
      }
      sql.exec(`
        CREATE TABLE IF NOT EXISTS unmatched (
          note_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS retired_containers (
          block_id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      const errorRedactionVersion = Array.from(
        sql.exec<ValueRow>(
          `SELECT value FROM sync_state WHERE key = ?`,
          "error_redaction_version",
        ),
      )[0]?.value;
      if (errorRedactionVersion !== "1") {
        sql.exec(
          `UPDATE events
           SET last_error = ?
           WHERE last_error IS NOT NULL`,
          "legacy_error_redacted",
        );
        sql.exec(
          `INSERT INTO sync_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          "error_redaction_version",
          "1",
        );
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/status") {
      const pendingEvents = Array.from(
        this.ctx.storage.sql.exec<CountRow>(
          `SELECT COUNT(*) AS count FROM events WHERE status = 'pending'`,
        ),
      )[0]?.count ?? 0;
      const unmatchedNotes = Array.from(
        this.ctx.storage.sql.exec<CountRow>(
          `SELECT COUNT(*) AS count FROM unmatched`,
        ),
      )[0]?.count ?? 0;
      const lastReconciledAt = Array.from(
        this.ctx.storage.sql.exec<ValueRow>(
          `SELECT value FROM sync_state WHERE key = 'last_reconciled_at'`,
        ),
      )[0]?.value ?? null;
      const nextReconcileAt = this.getSyncState("next_reconcile_at");
      const lastReconcileError = this.getSyncState("last_reconcile_error");
      const nextFullReconcileAt = this.getSyncState("next_full_reconcile_at");
      const lastFullReconciledAt = this.getSyncState("last_full_reconciled_at");
      const lastFullReconcileError = this.getSyncState(
        "last_full_reconcile_error",
      );
      const fullScanId = this.getSyncState("full_scan_id");
      const sourceLayoutVersion = this.getSyncState("source_layout_version");
      return jsonResponse({
        pendingEvents,
        unmatchedNotes,
        lastReconciledAt,
        nextReconcileAt:
          nextReconcileAt && Number.isFinite(Number(nextReconcileAt))
            ? new Date(Number(nextReconcileAt)).toISOString()
            : null,
        nextFullReconcileAt:
          nextFullReconcileAt && Number.isFinite(Number(nextFullReconcileAt))
            ? new Date(Number(nextFullReconcileAt)).toISOString()
            : null,
        lastFullReconciledAt,
        fullScanInProgress: Boolean(fullScanId),
        lastReconcileError,
        lastFullReconcileError,
        sourceLayoutVersion: sourceLayoutVersion
          ? Number(sourceLayoutVersion)
          : null,
      });
    }

    if (request.method === "POST" && url.pathname === "/start-reconcile") {
      if (!this.env.ALT_API_KEY || !this.env.NOTION_API_TOKEN) {
        return new Response("Sync credentials are not configured", { status: 503 });
      }
      const now = Date.now();
      this.setSyncState("next_reconcile_at", String(now));
      this.ensureFullReconcileSchedule(now);
      await this.scheduleNextAlarm(now);
      return new Response(null, { status: 202 });
    }

    if (request.method === "POST" && url.pathname === "/reconcile") {
      if (!this.env.ALT_API_KEY || !this.env.NOTION_API_TOKEN) {
        return new Response("Sync credentials are not configured", { status: 503 });
      }
      const result = await reconcileAltNotes(this.env, this.ctx.storage);
      this.enqueueEvents(result.events);
      this.ctx.storage.sql.exec(
        `INSERT INTO sync_state (key, value) VALUES ('last_reconciled_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        result.checkpoint,
      );
      this.setSyncState(
        "source_layout_version",
        String(result.sourceLayoutVersion),
      );
      this.setSyncState(
        "next_reconcile_at",
        String(Date.now() + this.reconcileIntervalMs()),
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM sync_state WHERE key = 'last_reconcile_error'`,
      );
      this.ensureFullReconcileSchedule(Date.now());
      await this.scheduleNextAlarm();
      return jsonResponse({ queued: result.events.length, scanned: result.scanned });
    }

    if (request.method !== "POST" || url.pathname !== "/enqueue") {
      return new Response("Not found", { status: 404 });
    }

    let event: AltWebhookEvent;
    try {
      event = (await request.json()) as AltWebhookEvent;
      validateWebhookEvent(event);
    } catch {
      return new Response("Invalid event", { status: 400 });
    }

    const now = Date.now();
    this.ensureReconcileSchedule(now);
    this.enqueueEvents([event], now);
    return new Response(null, { status: 204 });
  }

  private enqueueEvents(events: AltWebhookEvent[], now = Date.now()): void {
    if (events.length === 0) return;
    insertPendingEvents(this.ctx.storage, events, now);
    this.ctx.waitUntil(this.scheduleNextAlarm(now));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ensureReconcileSchedule(now);
    await this.reconcileIfDue(now);
    await this.fullReconcileIfDue(now);
    const rows = Array.from(
      this.ctx.storage.sql.exec<PendingEventRow>(
        `SELECT event_id, event_json, attempts
         FROM events
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY available_at ASC, created_at ASC
         LIMIT ?`,
        now,
        MAX_EVENTS_PER_ALARM,
      ),
    );

    for (const row of rows) {
      try {
        const event = JSON.parse(row.event_json) as AltWebhookEvent;
        await processAltEvent(event, this.env, this.ctx.storage);
        this.ctx.storage.sql.exec(
          `UPDATE events
           SET status = 'processed', processed_at = ?, last_error = NULL
           WHERE event_id = ?`,
          Date.now(),
          row.event_id,
        );
      } catch (error) {
        const attempts = row.attempts + 1;
        const retryAt = Date.now() + retryDelayMs(attempts);
        const errorCode = operationalErrorCode(error);
        this.ctx.storage.sql.exec(
          `UPDATE events
           SET attempts = ?, available_at = ?, last_error = ?
           WHERE event_id = ?`,
          attempts,
          retryAt,
          errorCode,
          row.event_id,
        );
        console.error("Alt event processing failed", {
          attempts,
          retryAt,
          errorCode,
        });
      }
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM events
       WHERE status = 'processed' AND processed_at < ?`,
      Date.now() - PROCESSED_EVENT_TTL_MS,
    );
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(atMost?: number): Promise<void> {
    const nextEvent = Array.from(
      this.ctx.storage.sql.exec<MinAvailableRow>(
        `SELECT MIN(available_at) AS available_at
         FROM events WHERE status = 'pending'`,
      ),
    )[0]?.available_at;
    const nextReconcileValue = this.getSyncState("next_reconcile_at");
    const nextReconcile = nextReconcileValue ? Number(nextReconcileValue) : null;
    const nextFullReconcileValue = this.getSyncState("next_full_reconcile_at");
    const nextFullReconcile = nextFullReconcileValue
      ? Number(nextFullReconcileValue)
      : null;
    const candidates = [nextEvent, nextReconcile, nextFullReconcile, atMost].filter(
      (value): value is number => value != null && Number.isFinite(value),
    );
    if (candidates.length === 0) return;

    const scheduledFor = Math.max(Date.now(), Math.min(...candidates));
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current <= Date.now() || scheduledFor < current) {
      await this.ctx.storage.setAlarm(scheduledFor);
    }
  }

  private getSyncState(key: string): string | null {
    return (
      Array.from(
        this.ctx.storage.sql.exec<ValueRow>(
          `SELECT value FROM sync_state WHERE key = ?`,
          key,
        ),
      )[0]?.value ?? null
    );
  }

  private setSyncState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private ensureReconcileSchedule(at: number): void {
    const current = Number(this.getSyncState("next_reconcile_at"));
    if (!Number.isFinite(current) || current <= 0) {
      this.setSyncState("next_reconcile_at", String(at));
    }
    this.ensureFullReconcileSchedule(at);
  }

  private ensureFullReconcileSchedule(at: number): void {
    const current = Number(this.getSyncState("next_full_reconcile_at"));
    if (!Number.isFinite(current) || current <= 0) {
      this.setSyncState("next_full_reconcile_at", String(at));
    }
  }

  private reconcileIntervalMs(): number {
    const configured = Number(this.env.RECONCILE_INTERVAL_MINUTES);
    const minutes =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_RECONCILE_INTERVAL_MINUTES;
    return minutes * 60 * 1000;
  }

  private fullReconcileIntervalMs(): number {
    const configured = Number(this.env.FULL_RECONCILE_INTERVAL_HOURS);
    const hours =
      Number.isFinite(configured) && configured >= 1
        ? configured
        : DEFAULT_FULL_RECONCILE_INTERVAL_HOURS;
    return hours * 60 * 60 * 1000;
  }

  private async reconcileIfDue(now: number): Promise<void> {
    const next = Number(this.getSyncState("next_reconcile_at"));
    if (!Number.isFinite(next) || next > now) return;
    try {
      const result = await reconcileAltNotes(this.env, this.ctx.storage);
      this.enqueueEvents(result.events, now);
      this.setSyncState("last_reconciled_at", result.checkpoint);
      this.setSyncState(
        "source_layout_version",
        String(result.sourceLayoutVersion),
      );
      this.setSyncState(
        "next_reconcile_at",
        String(Date.now() + this.reconcileIntervalMs()),
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM sync_state WHERE key = 'last_reconcile_error'`,
      );
    } catch (error) {
      const label = operationalErrorCode(error);
      this.setSyncState("last_reconcile_error", label);
      this.setSyncState(
        "next_reconcile_at",
        String(Date.now() + RECONCILE_FAILURE_RETRY_MS),
      );
      console.error("Alt reconciliation failed", { error: label });
    }
  }

  private async fullReconcileIfDue(now: number): Promise<void> {
    const next = Number(this.getSyncState("next_full_reconcile_at"));
    if (!Number.isFinite(next) || next > now) return;

    let scanId = this.getSyncState("full_scan_id");
    let scanStartedAt = this.getSyncState("full_scan_started_at");
    if (!scanId || !scanStartedAt || !Number.isFinite(Date.parse(scanStartedAt))) {
      scanId = crypto.randomUUID();
      scanStartedAt = new Date(now).toISOString();
      this.setSyncState("full_scan_id", scanId);
      this.setSyncState("full_scan_started_at", scanStartedAt);
    }

    try {
      const result = await reconcileFullAltInventory(
        this.env,
        this.ctx.storage,
        scanId,
        scanStartedAt,
      );
      this.ctx.storage.transactionSync(() => {
        insertPendingEvents(this.ctx.storage, result.events, now);
        this.setSyncState("last_full_reconciled_at", result.completedAt);
        this.setSyncState(
          "next_full_reconcile_at",
          String(Date.now() + this.fullReconcileIntervalMs()),
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM sync_state
           WHERE key IN ('full_scan_id', 'full_scan_started_at',
                         'last_full_reconcile_error')`,
        );
      });
      if (result.events.length) {
        this.ctx.waitUntil(this.scheduleNextAlarm(now));
      }
    } catch (error) {
      const label = operationalErrorCode(error);
      this.setSyncState("last_full_reconcile_error", label);
      this.setSyncState(
        "next_full_reconcile_at",
        String(Date.now() + RECONCILE_FAILURE_RETRY_MS),
      );
      console.error("Alt full reconciliation failed", { error: label });
    }
  }
}

function insertPendingEvents(
  storage: DurableObjectStorage,
  events: AltWebhookEvent[],
  now: number,
): void {
  for (const event of events) {
    storage.sql.exec(
      `INSERT OR IGNORE INTO events
       (event_id, event_json, status, attempts, available_at, created_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
      event.event_id,
      JSON.stringify(event),
      now,
      now,
    );
  }
}

async function reconcileAltNotes(
  env: Env,
  storage: DurableObjectStorage,
): Promise<{
  events: AltWebhookEvent[];
  checkpoint: string;
  scanned: number;
  sourceLayoutVersion: number;
}> {
  const startedAt = new Date();
  const storedCheckpoint = Array.from(
    storage.sql.exec<ValueRow>(
      `SELECT value FROM sync_state WHERE key = 'last_reconciled_at'`,
    ),
  )[0]?.value;
  const configuredHours = Number(env.RECONCILE_LOOKBACK_HOURS);
  const lookbackHours =
    Number.isFinite(configuredHours) && configuredHours > 0
      ? configuredHours
      : DEFAULT_RECONCILE_LOOKBACK_HOURS;
  const storedTime = storedCheckpoint ? Date.parse(storedCheckpoint) : Number.NaN;
  const storedLayoutVersion = Number(
    Array.from(
      storage.sql.exec<ValueRow>(
        `SELECT value FROM sync_state WHERE key = 'source_layout_version'`,
      ),
    )[0]?.value,
  );
  const requiresLayoutMigration =
    !Number.isFinite(storedLayoutVersion) ||
    storedLayoutVersion < SOURCE_LAYOUT_VERSION;
  const baseline = Number.isFinite(storedTime) && !requiresLayoutMigration
    ? storedTime
    : startedAt.getTime() - lookbackHours * 60 * 60 * 1000;
  const updatedAfter = new Date(baseline - RECONCILE_OVERLAP_MS).toISOString();

  const events: AltWebhookEvent[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_RECONCILE_PAGES; pageNumber += 1) {
    const params = new URLSearchParams({
      limit: "100",
      include_deleted: "true",
      updated_after: updatedAfter,
    });
    if (cursor) params.set("cursor", cursor);
    const page = await altGet<AltNoteList>(`/notes?${params.toString()}`, env);
    if (!Array.isArray(page.notes) || typeof page.has_more !== "boolean") {
      throw new Error("Alt note list response is invalid");
    }
    if (!page.notes.every(isValidAltNote)) {
      throw new Error("Alt note list contains an invalid note");
    }
    scanned += page.notes.length;
    for (const note of page.notes) {
      const event = reconcileEventForNote(note);
      if (event) events.push(event);
    }
    if (!page.has_more) {
      return {
        events,
        checkpoint: startedAt.toISOString(),
        scanned,
        sourceLayoutVersion: SOURCE_LAYOUT_VERSION,
      };
    }
    if (typeof page.next_cursor !== "string" || !page.next_cursor) {
      throw new Error("Alt note list is missing its next cursor");
    }
    cursor = page.next_cursor;
  }
  throw new Error("Alt reconciliation exceeded the pagination safety limit");
}

export function fullInventoryQueryPath(cursor: string | null): string {
  const params = new URLSearchParams({
    limit: "100",
    include_deleted: "true",
  });
  if (cursor) params.set("cursor", cursor);
  return `/notes?${params.toString()}`;
}

export async function collectFullAltNoteInventory(
  fetchPage: (cursor: string | null) => Promise<AltNoteList>,
  maxPages = MAX_FULL_RECONCILE_PAGES,
): Promise<AltNote[]> {
  const notes: AltNote[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page.notes) || typeof page.has_more !== "boolean") {
      throw new Error("Alt full note list response is invalid");
    }
    if (!page.notes.every(isValidAltNote)) {
      throw new Error("Alt full note list contains an invalid note");
    }
    notes.push(...page.notes);
    if (!page.has_more) return notes;
    if (typeof page.next_cursor !== "string" || !page.next_cursor) {
      throw new Error("Alt full note list is missing its next cursor");
    }
    if (page.next_cursor === cursor || cursors.has(page.next_cursor)) {
      throw new Error("Alt full note list repeated a cursor");
    }
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }

  throw new Error("Alt full reconciliation exceeded the pagination safety limit");
}

export function missingInventoryDeletionEvents(
  scanId: string,
  scanStartedAt: string,
  completedAt: string,
  seenNoteIds: ReadonlySet<string>,
  trackedRows: FullInventoryTrackedRow[],
  unmatchedRows: FullInventoryUnmatchedRow[],
): AltWebhookEvent[] {
  const cutoff = Date.parse(scanStartedAt);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid full scan start time");

  const missing = new Map<string, number>();
  for (const row of trackedRows) {
    const updatedAt = Date.parse(row.updated_at);
    const needsDeletedSourceMigration =
      Boolean(row.deleted) &&
      Boolean(row.container_id) &&
      (row.source_layout_version ?? 1) < SOURCE_LAYOUT_VERSION;
    if (
      (row.deleted && !needsDeletedSourceMigration) ||
      !Number.isFinite(updatedAt) ||
      updatedAt > cutoff ||
      seenNoteIds.has(row.note_id)
    ) {
      continue;
    }
    missing.set(row.note_id, Math.max(0, row.revision));
  }
  for (const row of unmatchedRows) {
    const updatedAt = Date.parse(row.updated_at);
    if (
      !Number.isFinite(updatedAt) ||
      updatedAt > cutoff ||
      seenNoteIds.has(row.note_id) ||
      missing.has(row.note_id)
    ) {
      continue;
    }
    let revision = 0;
    try {
      const payload = JSON.parse(row.payload) as { revision?: unknown };
      if (Number.isSafeInteger(payload.revision) && Number(payload.revision) >= 0) {
        revision = Number(payload.revision);
      }
    } catch {
      // A malformed diagnostic payload must not retain an inaccessible note forever.
    }
    missing.set(row.note_id, revision);
  }

  return Array.from(missing, ([noteId, revision]) => ({
    event_id: `reconcile:full:${scanId}:${noteId}:${revision}:access_lost`,
    event_type: "note.deleted" as const,
    occurred_at: completedAt,
    data: {
      note_id: noteId,
      revision,
      reason: "access_lost" as const,
      source_layout_version: SOURCE_LAYOUT_VERSION,
    },
  }));
}

async function reconcileFullAltInventory(
  env: Env,
  storage: DurableObjectStorage,
  scanId: string,
  scanStartedAt: string,
): Promise<{ events: AltWebhookEvent[]; scanned: number; completedAt: string }> {
  const trackedRows = Array.from(
    storage.sql.exec<NoteStateRow>(
      `SELECT note_id, page_id, heading_id, container_id,
              staged_container_id, staged_revision, revision,
              source_layout_version, summary_included, deleted, updated_at
       FROM notes`,
    ),
  );
  const unmatchedRows = Array.from(
    storage.sql.exec<FullInventoryUnmatchedRow>(
      `SELECT note_id, payload, updated_at FROM unmatched`,
    ),
  );
  const trackedById = new Map(trackedRows.map((row) => [row.note_id, row]));
  const unmatchedIds = new Set(unmatchedRows.map((row) => row.note_id));

  const notes = await collectFullAltNoteInventory((cursor) =>
    altGet<AltNoteList>(fullInventoryQueryPath(cursor), env),
  );
  const seenNoteIds = new Set(notes.map((note) => note.id));
  const events: AltWebhookEvent[] = [];

  for (const note of notes) {
    const storedRow = trackedById.get(note.id);
    const isUnmatched = unmatchedIds.has(note.id);
    if (!storedRow && !isUnmatched) continue;
    const event = reconcileEventForNote(note);
    if (!event) continue;

    if (!storedRow) {
      if (note.status === "deleted") events.push(event);
      continue;
    }
    const stored = noteStateFromRow(storedRow);
    if (note.status === "deleted") {
      if (
        !stored.deleted ||
        note.revision > stored.revision ||
        isUnmatched ||
        (Boolean(stored.containerId) &&
          stored.sourceLayoutVersion < SOURCE_LAYOUT_VERSION)
      ) {
        events.push(event);
      }
      continue;
    }
    if (
      stored.deleted ||
      shouldProcessRevision(
        stored.revision,
        stored.sourceLayoutVersion,
        note.revision,
        event.event_type,
        SOURCE_LAYOUT_VERSION,
        stored.summaryIncluded,
      )
    ) {
      events.push(event);
    }
  }

  const completedAt = new Date().toISOString();
  events.push(
    ...missingInventoryDeletionEvents(
      scanId,
      scanStartedAt,
      completedAt,
      seenNoteIds,
      trackedRows,
      unmatchedRows,
    ),
  );
  return { events, scanned: notes.length, completedAt };
}

export function reconcileEventForNote(note: AltNote): AltWebhookEvent | null {
  let eventType: AltEventType;
  if (note.status === "deleted") {
    eventType = "note.deleted";
  } else if (note.status === "ended" && note.summary_status === "ready") {
    eventType = "note.summary.generated";
  } else if (note.status === "ended" && note.transcript_status === "ready") {
    eventType = "note.updated";
  } else {
    return null;
  }
  return {
    event_id:
      `reconcile:v${SOURCE_LAYOUT_VERSION}:${note.id}:${note.revision}:${eventType}`,
    event_type: eventType,
    occurred_at: note.updated_at,
    data: {
      note_id: note.id,
      revision: note.revision,
      transcript_status: note.transcript_status,
      summary_status: note.summary_status,
      source_layout_version: SOURCE_LAYOUT_VERSION,
      reason: note.status === "deleted" ? "deleted" : null,
    },
  };
}

function isValidAltNote(note: unknown): note is AltNote {
  if (!note || typeof note !== "object") return false;
  const value = note as Partial<AltNote>;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (typeof value.title === "string" || value.title === null) &&
    ["pending", "ended", "deleted"].includes(String(value.status)) &&
    ["pending", "ready", "empty", "failed"].includes(
      String(value.transcript_status),
    ) &&
    ["pending", "ready", "missing", "failed"].includes(
      String(value.summary_status),
    ) &&
    typeof value.updated_at === "string" &&
    Number.isFinite(Date.parse(value.updated_at)) &&
    (value.ended_at == null || Number.isFinite(Date.parse(value.ended_at))) &&
    (value.deleted_at == null || Number.isFinite(Date.parse(value.deleted_at)))
  );
}

export function operationalErrorCode(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "provider_authentication_failed";
    }
    if (error.status === 404) return "provider_resource_not_found";
    if (error.status === 409) return "provider_conflict";
    if (error.status === 413) return "provider_payload_too_large";
    if (error.status === 429) return "provider_rate_limited";
    if (error.status >= 500) return "provider_unavailable";
    if (error.status >= 400) return "provider_request_rejected";
    return "provider_request_failed";
  }
  if (error instanceof UnmatchedNoteError) {
    return "class_match_requires_review";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "provider_timeout";
    }
    if (error instanceof TypeError) return "provider_network_error";

    const message = error.message;
    if (/Alt (full )?note list (response|contains)/.test(message)) {
      return "alt_inventory_response_invalid";
    }
    if (/Alt (full )?note list .*cursor/.test(message)) {
      return "alt_inventory_cursor_invalid";
    }
    if (/Alt (full )?reconciliation exceeded/.test(message)) {
      return "alt_inventory_limit_reached";
    }
    if (message === "Invalid full scan start time") {
      return "full_scan_state_invalid";
    }
    if (/has no ended_at timestamp$/.test(message)) {
      return "alt_note_not_ended";
    }
    if (/is not ready yet$|has no ready transcript or summary$/.test(message)) {
      return "alt_content_not_ready";
    }
    if (/is not on revision \d+$/.test(message)) {
      return "alt_revision_mismatch";
    }
    if (/Could not (create|write) deletion marker on /.test(message)) {
      return "notion_deletion_marker_failed";
    }
    if (/Could not create note container on /.test(message)) {
      return "notion_note_container_failed";
    }
    if (/Could not create AI notes heading on /.test(message)) {
      return "notion_ai_heading_failed";
    }
    if (/^(Missing|Invalid) (event|revision|source layout version)/.test(message)) {
      return "stored_event_invalid";
    }
    if (error.name === "SyntaxError") return "provider_response_invalid";
  }
  return "internal_error";
}

function retryDelayMs(attempts: number): number {
  const exponential = Math.min(
    6 * 60 * 60_000,
    30_000 * 2 ** Math.min(attempts - 1, 10),
  );
  return exponential + Math.floor(Math.random() * 1_000);
}

function validateWebhookEvent(event: AltWebhookEvent): void {
  if (!event || typeof event !== "object") throw new Error("Missing event");
  if (typeof event.event_id !== "string" || !event.event_id) {
    throw new Error("Missing event id");
  }
  const allowedTypes: AltEventType[] = [
    "note.ended",
    "note.summary.generated",
    "note.updated",
    "note.deleted",
    "endpoint.verification",
    "endpoint.test",
  ];
  if (!allowedTypes.includes(event.event_type)) {
    throw new Error("Missing event type");
  }
  if (
    typeof event.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(event.occurred_at))
  ) {
    throw new Error("Invalid event timestamp");
  }
  if (!event.data || typeof event.data !== "object") {
    throw new Error("Missing event data");
  }
  if (
    event.event_type === "endpoint.verification" ||
    event.event_type === "endpoint.test"
  ) {
    if (typeof event.data.endpoint_id !== "string" || !event.data.endpoint_id) {
      throw new Error("Missing endpoint id");
    }
  } else {
    if (typeof event.data.note_id !== "string" || !event.data.note_id) {
      throw new Error("Missing note id");
    }
    if (
      !Number.isSafeInteger(event.data.revision) ||
      Number(event.data.revision) < 0
    ) {
      throw new Error("Missing revision");
    }
    if (
      event.data.source_layout_version != null &&
      (!Number.isSafeInteger(event.data.source_layout_version) ||
        event.data.source_layout_version < 1)
    ) {
      throw new Error("Invalid source layout version");
    }
  }
}

export async function verifyAltSignature(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const webhookId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!webhookId || !timestamp || !signatureHeader) return false;
  if (!signingSecret.startsWith("whsec_")) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(nowMs - timestampSeconds * 1000) > MAX_WEBHOOK_AGE_MS) {
    return false;
  }

  let secretBytes: Uint8Array;
  try {
    secretBytes = decodeBase64Url(signingSecret.slice("whsec_".length));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent)),
  );

  for (const part of signatureHeader.split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    try {
      const supplied = decodeBase64(part.slice(comma + 1));
      if (constantTimeEqual(digest, supplied)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function decodeBase64Url(value: string): Uint8Array {
  return decodeBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function decodeBase64(value: string): Uint8Array {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

class UnmatchedNoteError extends Error {}

export async function purgeUnmatchedBeforeDeletedSourceSync(
  storage: DurableObjectStorage,
  noteId: string,
  syncDeletedSource: () => Promise<void>,
): Promise<void> {
  storage.sql.exec(`DELETE FROM unmatched WHERE note_id = ?`, noteId);
  await syncDeletedSource();
}

export function publicSyncStatus(sync: unknown): unknown {
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) return sync;
  const { lastReconcileError, lastFullReconcileError, ...safe } = sync as Record<
    string,
    unknown
  >;
  return {
    ...safe,
    hasReconcileError: Boolean(lastReconcileError),
    hasFullReconcileError: Boolean(lastFullReconcileError),
  };
}

async function processAltEvent(
  event: AltWebhookEvent,
  env: Env,
  storage: DurableObjectStorage,
): Promise<void> {
  const noteId = event.data.note_id!;
  const incomingRevision = event.data.revision!;
  let existing = getNoteState(noteId, storage);

  if (event.event_type === "note.deleted") {
    if (existing && incomingRevision < existing.revision) return;
    await purgeUnmatchedBeforeDeletedSourceSync(
      storage,
      noteId,
      () =>
        syncDeletedSourceMarker(
          noteId,
          incomingRevision,
          existing,
          env,
          storage,
        ),
    );
    return;
  }

  await cleanupRetiredContainers(noteId, env, storage);
  existing = getNoteState(noteId, storage);
  if (existing?.stagedContainerId) {
    await deleteNotionBlock(existing.stagedContainerId, env);
    storage.sql.exec(
      `UPDATE notes
       SET staged_container_id = NULL, staged_revision = NULL, updated_at = ?
       WHERE note_id = ?`,
      new Date().toISOString(),
      noteId,
    );
    existing = getNoteState(noteId, storage);
  }

  if (
    existing &&
    !shouldProcessStoredRevision(
      existing.deleted,
      existing.revision,
      existing.sourceLayoutVersion,
      incomingRevision,
      event.event_type,
      event.data.source_layout_version,
      existing.summaryIncluded,
    )
  ) {
    return;
  }

  if (
    event.event_type !== "note.ended" &&
    event.event_type !== "note.summary.generated" &&
    event.event_type !== "note.updated"
  ) {
    return;
  }

  const note = await altGet<AltNote>(`/notes/${encodeURIComponent(noteId)}`, env);
  if (note.status === "deleted") {
    const deletedRevision = Math.max(incomingRevision, note.revision);
    await purgeUnmatchedBeforeDeletedSourceSync(
      storage,
      noteId,
      () =>
        syncDeletedSourceMarker(
          noteId,
          deletedRevision,
          existing,
          env,
          storage,
        ),
    );
    return;
  }
  if (!note.ended_at) {
    throw new Error(`Alt note ${noteId} has no ended_at timestamp`);
  }
  if (
    existing &&
    !shouldProcessStoredRevision(
      existing.deleted,
      existing.revision,
      existing.sourceLayoutVersion,
      note.revision,
      event.event_type,
      event.data.source_layout_version,
      existing.summaryIncluded,
    )
  ) {
    return;
  }

  const [summary, transcript] = await Promise.all([
    note.summary_status === "ready"
      ? altGet<AltSummary>(`/notes/${encodeURIComponent(noteId)}/summary`, env)
      : Promise.resolve<AltSummary | null>(null),
    note.transcript_status === "ready"
      ? altGet<AltTranscript>(`/notes/${encodeURIComponent(noteId)}/transcript`, env)
      : Promise.resolve<AltTranscript | null>(null),
  ]);
  if (summary && summary.status !== "ready") {
    throw new Error(`Alt summary ${noteId} is not ready yet`);
  }
  if (
    summary &&
    (summary.note_id !== noteId || summary.revision !== note.revision)
  ) {
    throw new Error(`Alt summary ${noteId} is not on revision ${note.revision}`);
  }
  if (
    transcript &&
    (transcript.note_id !== noteId || transcript.revision !== note.revision)
  ) {
    throw new Error(`Alt transcript ${noteId} is not on revision ${note.revision}`);
  }
  const summaryMarkdown = summary?.markdown?.trim() || null;
  if (!summaryMarkdown && !transcript) {
    if (shouldRetryMissingAltContent(note, event)) {
      throw new Error(`Alt note ${noteId} has no ready transcript or summary`);
    }
    return;
  }

  const candidates = await queryClassCandidates(note.ended_at, env);
  const match = chooseClassCandidate(
    note,
    transcript,
    candidates,
    Number(env.MATCH_WINDOW_MINUTES || "90"),
    parseAliases(env.COURSE_ALIASES_JSON),
  );
  if (!match.candidate) {
    recordUnmatched(
      noteId,
      {
        noteId,
        revision: note.revision,
        title: note.title,
        endedAt: note.ended_at,
        reason: match.reason,
        candidatePages: candidates.map((candidate) => ({
          pageId: candidate.pageId,
          course: candidate.course,
          start: candidate.start,
          end: candidate.end,
        })),
        updatedAt: new Date().toISOString(),
      },
      storage,
    );
    throw new UnmatchedNoteError(`Alt note ${noteId}: ${match.reason}`);
  }
  if (!match.candidate.autoNoteEnabled) {
    upsertNoteState(
      noteId,
      skippedAutoNoteState(note.revision, match.candidate.pageId, existing),
      storage,
    );
    storage.sql.exec(`DELETE FROM unmatched WHERE note_id = ?`, noteId);
    return;
  }
  if (
    existing?.pageId &&
    existing.containerId &&
    existing.pageId !== match.candidate.pageId
  ) {
    recordUnmatched(
      noteId,
      {
        noteId,
        revision: note.revision,
        title: note.title,
        endedAt: note.ended_at,
        reason: "page_changed_requires_review",
        previousPageId: existing.pageId,
        candidatePageId: match.candidate.pageId,
        updatedAt: new Date().toISOString(),
      },
      storage,
    );
    throw new UnmatchedNoteError(`Alt note ${noteId}: page match changed`);
  }

  await syncLecturePage(
    note,
    summaryMarkdown,
    transcript,
    match.candidate,
    existing,
    env,
    storage,
  );
  storage.sql.exec(`DELETE FROM unmatched WHERE note_id = ?`, noteId);
}

export function shouldRetryMissingAltContent(
  note: Pick<AltNote, "summary_status" | "transcript_status">,
  event: Pick<AltWebhookEvent, "event_type" | "data">,
): boolean {
  return (
    note.summary_status === "ready" ||
    note.transcript_status === "ready" ||
    event.event_type === "note.summary.generated" ||
    event.data.source_layout_version != null ||
    event.data.summary_status === "ready" ||
    event.data.transcript_status === "ready"
  );
}

export function deletedNoteState(
  revision: number,
  previousState: NoteState | null,
  markerContainerId: string | null,
  updatedAt = new Date().toISOString(),
): NoteState {
  const keepLocation = deletionMarkerNeeded(previousState);
  return {
    pageId: keepLocation ? previousState?.pageId ?? null : null,
    headingId: keepLocation ? previousState?.headingId ?? null : null,
    containerId: markerContainerId,
    stagedContainerId: null,
    stagedRevision: null,
    revision: Math.max(revision, previousState?.revision ?? revision),
    sourceLayoutVersion: SOURCE_LAYOUT_VERSION,
    summaryIncluded: false,
    deleted: true,
    updatedAt,
  };
}

export function shouldProcessRevision(
  storedRevision: number,
  storedLayoutVersion: number,
  incomingRevision: number,
  eventType: AltEventType,
  requestedLayoutVersion?: number,
  summaryIncluded = false,
): boolean {
  if (incomingRevision > storedRevision) return true;
  if (incomingRevision < storedRevision) return false;
  if (requestedLayoutVersion != null && requestedLayoutVersion > storedLayoutVersion) {
    return true;
  }
  return eventType === "note.summary.generated" && !summaryIncluded;
}

export function shouldProcessStoredRevision(
  storedDeleted: boolean,
  storedRevision: number,
  storedLayoutVersion: number,
  incomingRevision: number,
  eventType: AltEventType,
  requestedLayoutVersion?: number,
  summaryIncluded = false,
): boolean {
  if (storedDeleted) return incomingRevision >= storedRevision;
  return shouldProcessRevision(
    storedRevision,
    storedLayoutVersion,
    incomingRevision,
    eventType,
    requestedLayoutVersion,
    summaryIncluded,
  );
}

export function skippedAutoNoteState(
  revision: number,
  matchedPageId: string,
  previousState: NoteState | null,
  updatedAt = new Date().toISOString(),
): NoteState {
  return {
    pageId: previousState?.pageId ?? matchedPageId,
    headingId: previousState?.headingId ?? null,
    containerId: previousState?.containerId ?? null,
    stagedContainerId: null,
    stagedRevision: null,
    revision: Math.max(revision, previousState?.revision ?? revision),
    sourceLayoutVersion:
      previousState?.sourceLayoutVersion ?? SOURCE_LAYOUT_VERSION,
    summaryIncluded: previousState?.summaryIncluded ?? false,
    deleted: false,
    updatedAt,
  };
}

function getNoteState(
  noteId: string,
  storage: DurableObjectStorage,
): NoteState | null {
  const row = Array.from(
    storage.sql.exec<NoteStateRow>(
      `SELECT note_id, page_id, heading_id, container_id,
              staged_container_id, staged_revision, revision,
              source_layout_version, summary_included, deleted, updated_at
       FROM notes WHERE note_id = ?`,
      noteId,
    ),
  )[0];
  if (!row) return null;
  return noteStateFromRow(row);
}

function noteStateFromRow(row: NoteStateRow): NoteState {
  return {
    pageId: row.page_id,
    headingId: row.heading_id,
    containerId: row.container_id,
    stagedContainerId: row.staged_container_id,
    stagedRevision: row.staged_revision,
    revision: row.revision,
    sourceLayoutVersion: row.source_layout_version,
    summaryIncluded: Boolean(row.summary_included),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

function upsertNoteState(
  noteId: string,
  state: NoteState,
  storage: DurableObjectStorage,
): void {
  storage.sql.exec(
    `INSERT INTO notes
      (note_id, page_id, heading_id, container_id, staged_container_id,
       staged_revision, revision, source_layout_version, summary_included,
       deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET
       page_id = excluded.page_id,
       heading_id = excluded.heading_id,
       container_id = excluded.container_id,
       staged_container_id = excluded.staged_container_id,
       staged_revision = excluded.staged_revision,
       revision = excluded.revision,
       source_layout_version = excluded.source_layout_version,
       summary_included = excluded.summary_included,
       deleted = excluded.deleted,
       updated_at = excluded.updated_at`,
    noteId,
    state.pageId,
    state.headingId,
    state.containerId,
    state.stagedContainerId,
    state.stagedRevision,
    state.revision,
    state.sourceLayoutVersion,
    state.summaryIncluded ? 1 : 0,
    state.deleted ? 1 : 0,
    state.updatedAt,
  );
}

function recordUnmatched(
  noteId: string,
  payload: unknown,
  storage: DurableObjectStorage,
): void {
  storage.sql.exec(
    `INSERT INTO unmatched(note_id, payload, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET
       payload = excluded.payload, updated_at = excluded.updated_at`,
    noteId,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

async function deleteNotionBlock(blockId: string, env: Env): Promise<void> {
  try {
    await notionRequest(`/blocks/${blockId}`, env, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  await sleep(NOTION_PACE_MS);
}

async function deleteCurrentContainer(
  state: NoteState | null,
  env: Env,
): Promise<void> {
  if (state?.stagedContainerId) await deleteNotionBlock(state.stagedContainerId, env);
  if (state?.containerId) await deleteNotionBlock(state.containerId, env);
}

async function deleteAllKnownSourceContainers(
  noteId: string,
  state: NoteState | null,
  env: Env,
  storage: DurableObjectStorage,
): Promise<void> {
  const retiredRows = Array.from(
    storage.sql.exec<RetiredContainerRow>(
      `SELECT block_id FROM retired_containers
       WHERE note_id = ? ORDER BY created_at ASC`,
      noteId,
    ),
  );
  const candidates = new Map<string, boolean>();
  if (state?.stagedContainerId) candidates.set(state.stagedContainerId, false);
  if (state?.containerId) candidates.set(state.containerId, false);
  for (const row of retiredRows) candidates.set(row.block_id, true);

  let firstError: unknown = null;
  for (const [blockId, isRetired] of candidates) {
    try {
      await deleteNotionBlock(blockId, env);
      if (isRetired) {
        storage.sql.exec(
          `DELETE FROM retired_containers WHERE block_id = ?`,
          blockId,
        );
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function syncDeletedSourceMarker(
  noteId: string,
  revision: number,
  previousState: NoteState | null,
  env: Env,
  storage: DurableObjectStorage,
): Promise<void> {
  const markerNeeded = deletionMarkerNeeded(previousState);
  await deleteAllKnownSourceContainers(noteId, previousState, env, storage);
  const deletedState = deletedNoteState(revision, previousState, null);
  upsertNoteState(noteId, deletedState, storage);
  if (!markerNeeded || !deletedState.pageId) return;

  const pageId = deletedState.pageId;
  const headingId = await findOrCreateSourceHeading(pageId, env);
  deletedState.headingId = headingId;
  deletedState.updatedAt = new Date().toISOString();
  upsertNoteState(noteId, deletedState, storage);

  const createdContainerIds = await appendTopLevelBlocks(
    pageId,
    headingId,
    [makeToggleBlock("원본 자료")],
    env,
  );
  const [markerContainerId] = createdContainerIds;
  if (!markerContainerId) {
    throw new Error(`Could not create deletion marker on ${pageId}`);
  }

  const stagedState: NoteState = {
    ...deletedState,
    stagedContainerId: markerContainerId,
    stagedRevision: deletedState.revision,
    updatedAt: new Date().toISOString(),
  };
  upsertNoteState(noteId, stagedState, storage);
  const markerChildIds = await appendChildBlocks(
    markerContainerId,
    deletedSourceToggleChildBlocks(deletedState.revision),
    env,
  );
  if (markerChildIds.length !== 1) {
    throw new Error(`Could not write deletion marker on ${pageId}`);
  }

  upsertNoteState(
    noteId,
    deletedNoteState(
      deletedState.revision,
      stagedState,
      markerContainerId,
    ),
    storage,
  );
}

export function deletionMarkerNeeded(
  state: Pick<
    NoteState,
    "pageId" | "containerId" | "stagedContainerId" | "deleted"
  > | null,
): boolean {
  return Boolean(
    state?.pageId &&
      (state.containerId || state.stagedContainerId || state.deleted),
  );
}

async function cleanupRetiredContainers(
  noteId: string,
  env: Env,
  storage: DurableObjectStorage,
): Promise<void> {
  const rows = Array.from(
    storage.sql.exec<RetiredContainerRow>(
      `SELECT block_id FROM retired_containers
       WHERE note_id = ? ORDER BY created_at ASC`,
      noteId,
    ),
  );
  for (const row of rows) {
    await deleteNotionBlock(row.block_id, env);
    storage.sql.exec(`DELETE FROM retired_containers WHERE block_id = ?`, row.block_id);
  }
}

async function syncLecturePage(
  note: AltNote,
  summaryMarkdown: string | null,
  transcript: AltTranscript | null,
  candidate: ClassCandidate,
  previousState: NoteState | null,
  env: Env,
  storage: DurableObjectStorage,
): Promise<void> {
  const headingId = await findOrCreateSourceHeading(candidate.pageId, env);
  const insertionAnchorId = await findSourceReplacementAnchor(
    candidate.pageId,
    headingId,
    previousState?.sourceLayoutVersion === SOURCE_LAYOUT_VERSION
      ? previousState.containerId
      : null,
    env,
  );
  const stagedState: NoteState = {
    pageId: candidate.pageId,
    headingId,
    containerId: previousState?.containerId ?? null,
    stagedContainerId: null,
    stagedRevision: note.revision,
    revision: previousState?.revision ?? -1,
    sourceLayoutVersion: previousState?.sourceLayoutVersion ?? 1,
    summaryIncluded: previousState?.summaryIncluded ?? false,
    deleted: previousState?.deleted ?? false,
    updatedAt: new Date().toISOString(),
  };
  upsertNoteState(note.id, stagedState, storage);

  let createdContainerIds: string[];
  try {
    createdContainerIds = await appendTopLevelBlocks(
      candidate.pageId,
      insertionAnchorId,
      [makeToggleBlock("원본 자료")],
      env,
    );
  } catch (error) {
    if (
      insertionAnchorId === headingId ||
      !(error instanceof ApiError) ||
      ![400, 404].includes(error.status)
    ) {
      throw error;
    }
    createdContainerIds = await appendTopLevelBlocks(
      candidate.pageId,
      headingId,
      [makeToggleBlock("원본 자료")],
      env,
    );
  }
  const [containerId] = createdContainerIds;
  if (!containerId) throw new Error(`Could not create note container on ${candidate.pageId}`);
  stagedState.stagedContainerId = containerId;
  stagedState.updatedAt = new Date().toISOString();
  upsertNoteState(note.id, stagedState, storage);

  const sourceChildIds = await appendChildBlocks(
    containerId,
    sourceToggleChildBlocks(note.revision, summaryMarkdown),
    env,
  );
  const transcriptToggleId = sourceChildIds.at(-1);
  if (transcriptToggleId) {
    const transcriptBlocks = transcriptToBlocks(transcript);
    if (transcriptBlocks.length) {
      await appendChildBlocks(transcriptToggleId, transcriptBlocks, env);
    }
  }

  const oldContainerId = previousState?.containerId ?? null;
  const committedAt = new Date().toISOString();
  storage.transactionSync(() => {
    upsertNoteState(
      note.id,
      {
        pageId: candidate.pageId,
        headingId,
        containerId,
        stagedContainerId: null,
        stagedRevision: null,
        revision: note.revision,
        sourceLayoutVersion: SOURCE_LAYOUT_VERSION,
        summaryIncluded: Boolean(summaryMarkdown),
        deleted: false,
        updatedAt: committedAt,
      },
      storage,
    );
    if (oldContainerId && oldContainerId !== containerId) {
      storage.sql.exec(
        `INSERT OR IGNORE INTO retired_containers(block_id, note_id, created_at)
         VALUES (?, ?, ?)`,
        oldContainerId,
        note.id,
        Date.now(),
      );
    }
  });
  await cleanupRetiredContainers(note.id, env, storage);
}

async function findSourceReplacementAnchor(
  pageId: string,
  fallbackHeadingId: string,
  currentContainerId: string | null,
  env: Env,
): Promise<string> {
  if (!currentContainerId) return fallbackHeadingId;
  const topLevelIds: string[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const response = await notionRequest<{
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/blocks/${pageId}/children?${query.toString()}`, env);
    topLevelIds.push(
      ...response.results.flatMap((block) => (block.id ? [block.id] : [])),
    );
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return sourceReplacementAnchor(
    topLevelIds,
    currentContainerId,
    fallbackHeadingId,
  );
}

export function sourceReplacementAnchor(
  topLevelBlockIds: string[],
  currentContainerId: string | null,
  fallbackHeadingId: string,
): string {
  if (!currentContainerId) return fallbackHeadingId;
  const currentIndex = topLevelBlockIds.indexOf(currentContainerId);
  if (currentIndex <= 0) return fallbackHeadingId;
  return topLevelBlockIds[currentIndex - 1] ?? fallbackHeadingId;
}

export function sourceToggleChildBlocks(
  revision: number,
  summaryMarkdown: string | null,
): NotionBlock[] {
  const blocks: NotionBlock[] = [
    makeTextBlock("paragraph", `Alt · revision ${revision}`),
  ];
  if (summaryMarkdown?.trim()) {
    blocks.push(
      makeTextBlock("heading_3", "Alt 요약"),
      ...nestedSummaryBlocks(summaryMarkdown),
    );
  }
  blocks.push(makeToggleBlock("전체 녹취"));
  return blocks;
}

export function deletedSourceToggleChildBlocks(revision: number): NotionBlock[] {
  return [makeTextBlock("paragraph", `Alt · 삭제됨 · revision ${revision}`)];
}

function nestedSummaryBlocks(markdown: string): NotionBlock[] {
  return summaryMarkdownToBlocks(markdown).map((block) => {
    if (block.type !== "heading_2") return block;
    return {
      type: "heading_3",
      heading_3: block.heading_2,
    };
  });
}

type NotionHeadingType = "heading_1" | "heading_2" | "heading_3";

interface SourcePageHeading {
  id: string;
  type: NotionHeadingType;
  index: number;
  level: number;
}

export function inspectSourceHeadingLayout(
  topLevelBlocks: NotionBlock[],
): {
  sourceHeading: SourcePageHeading | null;
  manualHeading: SourcePageHeading | null;
  manualInsertionAnchorId: string | null;
  legacyHeading: SourcePageHeading | null;
  legacySectionIsEmpty: boolean;
} {
  const headings = topLevelBlocks.flatMap((block, index) => {
    if (!block.id || !/^heading_[123]$/.test(block.type)) return [];
    const type = block.type as NotionHeadingType;
    const value = block[type] as { rich_text?: NotionRichText[] } | undefined;
    return [{
      id: block.id,
      type,
      index,
      level: Number(type.at(-1)),
      text: plainText(value?.rich_text),
    }];
  });
  const sourceHeading =
    headings.find(({ text }) => text === SOURCE_SYNC_HEADING) ?? null;
  const manualHeading =
    headings.find(({ text }) => text === MANUAL_NOTES_HEADING) ?? null;
  const legacyHeading =
    headings.find(({ text }) => text === LEGACY_AI_NOTES_HEADING) ?? null;

  const sectionEnd = (heading: (typeof headings)[number]): number =>
    headings.find(
      ({ index, level }) => index > heading.index && level <= heading.level,
    )?.index ?? topLevelBlocks.length;
  const manualSectionEnd = manualHeading ? sectionEnd(manualHeading) : null;
  const manualInsertionIndex =
    manualSectionEnd == null ? null : manualSectionEnd - 1;
  const manualInsertionAnchorId =
    manualInsertionIndex == null
      ? null
      : topLevelBlocks[manualInsertionIndex]?.id ?? manualHeading?.id ?? null;
  const legacySectionIsEmpty = Boolean(
    legacyHeading && sectionEnd(legacyHeading) - 1 === legacyHeading.index,
  );

  return {
    sourceHeading,
    manualHeading,
    manualInsertionAnchorId,
    legacyHeading,
    legacySectionIsEmpty,
  };
}

export function canonicalSourceSectionHeadings(
  includeManualHeading: boolean,
): NotionBlock[] {
  const titles = includeManualHeading
    ? [MANUAL_NOTES_HEADING, SOURCE_SYNC_HEADING]
    : [SOURCE_SYNC_HEADING];
  return titles.map((title) => makeTextBlock("heading_2", title));
}

async function findOrCreateSourceHeading(
  pageId: string,
  env: Env,
): Promise<string> {
  const topLevelBlocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const response = await notionRequest<{
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/blocks/${pageId}/children?${query.toString()}`, env);
    topLevelBlocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  const layout = inspectSourceHeadingLayout(topLevelBlocks);
  const sourceHeading = layout.sourceHeading;
  if (sourceHeading) return sourceHeading.id;

  const manualHeading = layout.manualHeading;
  if (manualHeading) {
    const insertionAnchor = layout.manualInsertionAnchorId ?? manualHeading.id;
    const created = await appendTopLevelBlocks(
      pageId,
      insertionAnchor,
      canonicalSourceSectionHeadings(false),
      env,
    );
    const headingId = created[0];
    if (!headingId) throw new Error(`Could not create source heading on ${pageId}`);
    return headingId;
  }

  const legacyHeading = layout.legacyHeading;

  if (legacyHeading && layout.legacySectionIsEmpty) {
    const replacementHeading = makeTextBlock(
      legacyHeading.type,
      MANUAL_NOTES_HEADING,
    );
    await notionRequest(`/blocks/${legacyHeading.id}`, env, {
      method: "PATCH",
      body: JSON.stringify({
        [legacyHeading.type]: replacementHeading[legacyHeading.type],
      }),
    });
    const created = await appendTopLevelBlocks(
      pageId,
      legacyHeading.id,
      canonicalSourceSectionHeadings(false),
      env,
    );
    const headingId = created[0];
    if (!headingId) throw new Error(`Could not create source heading on ${pageId}`);
    return headingId;
  }

  const created = await appendChildBlocks(
    pageId,
    canonicalSourceSectionHeadings(true),
    env,
  );
  const headingId = created[1];
  if (!headingId) throw new Error(`Could not create source heading on ${pageId}`);
  return headingId;
}

async function appendTopLevelBlocks(
  pageId: string,
  afterBlockId: string,
  blocks: NotionBlock[],
  env: Env,
): Promise<string[]> {
  const createdIds: string[] = [];
  let positionAfter = afterBlockId;
  for (const batch of notionBlockBatches(blocks)) {
    const response = await notionRequest<{ results: NotionBlock[] }>(
      `/blocks/${pageId}/children`,
      env,
      {
        method: "PATCH",
        body: JSON.stringify({
          children: batch,
          position: {
            type: "after_block",
            after_block: { id: positionAfter },
          },
        }),
      },
      "rate-limit-only",
    );
    const ids = response.results.flatMap((block) => (block.id ? [block.id] : []));
    createdIds.push(...ids);
    if (ids.length) positionAfter = ids.at(-1)!;
    await sleep(NOTION_PACE_MS);
  }
  return createdIds;
}

async function appendChildBlocks(
  parentId: string,
  blocks: NotionBlock[],
  env: Env,
): Promise<string[]> {
  const createdIds: string[] = [];
  for (const batch of notionBlockBatches(blocks)) {
    const response = await notionRequest<{ results: NotionBlock[] }>(
      `/blocks/${parentId}/children`,
      env,
      {
        method: "PATCH",
        body: JSON.stringify({ children: batch, position: { type: "end" } }),
      },
      "rate-limit-only",
    );
    createdIds.push(
      ...response.results.flatMap((block) => (block.id ? [block.id] : [])),
    );
    await sleep(NOTION_PACE_MS);
  }
  return createdIds;
}

function notionBlockBatches(blocks: NotionBlock[]): NotionBlock[][] {
  const encoder = new TextEncoder();
  const batches: NotionBlock[][] = [];
  let current: NotionBlock[] = [];

  for (const block of blocks) {
    const candidate = [...current, block];
    const bytes = encoder.encode(JSON.stringify({ children: candidate })).byteLength;
    if (
      current.length > 0 &&
      (candidate.length > MAX_NOTION_BATCH_BLOCKS || bytes > MAX_NOTION_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [block];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

async function queryClassCandidates(
  endedAt: string,
  env: Env,
): Promise<ClassCandidate[]> {
  const bounds = timeZoneDayBounds(new Date(endedAt), env.TIME_ZONE);
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const response = await notionRequest<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`, env, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: env.NOTION_DATE_PROPERTY,
              date: { on_or_after: bounds.start },
            },
            {
              property: env.NOTION_DATE_PROPERTY,
              date: { before: bounds.end },
            },
            {
              property: env.NOTION_CATEGORY_PROPERTY,
              select: { equals: env.CLASS_CATEGORY },
            },
          ],
        },
        sorts: [{ property: env.NOTION_DATE_PROPERTY, direction: "ascending" }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages.flatMap((page) => {
    const date = page.properties[env.NOTION_DATE_PROPERTY]?.date;
    if (!date?.start) return [];
    const start = date.start;
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs)) return [];
    const end = date.end ?? new Date(startMs + DEFAULT_CLASS_DURATION_MS).toISOString();
    const title = propertyText(page.properties[env.NOTION_TITLE_PROPERTY]);
    const course = propertyText(page.properties[env.NOTION_COURSE_PROPERTY]) || title;
    return [
      {
        pageId: page.id,
        url: page.url,
        title,
        course,
        start,
        end,
        autoNoteEnabled: notionAutoNoteEnabled(
          page.properties,
          env.NOTION_AUTO_NOTE_PROPERTY,
        ),
      },
    ];
  });
}

export function notionAutoNoteEnabled(
  properties: Record<string, { checkbox?: boolean }>,
  propertyName?: string,
): boolean {
  const configuredName = propertyName?.trim();
  if (!configuredName) return true;
  return properties[configuredName]?.checkbox === true;
}

export function chooseClassCandidate(
  note: Pick<AltNote, "title" | "ended_at">,
  transcript: Pick<AltTranscript, "segments"> | null,
  candidates: ClassCandidate[],
  matchWindowMinutes = 90,
  aliases: Record<string, string[]> = {},
): MatchResult {
  if (!note.ended_at) {
    return { candidate: null, confidence: 0, reason: "missing_note_end_time" };
  }
  const noteEnd = new Date(note.ended_at).getTime();
  if (!Number.isFinite(noteEnd)) {
    return { candidate: null, confidence: 0, reason: "invalid_note_end_time" };
  }
  const measuredDurationMs = transcript?.segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.end_ms || 0),
    0,
  );
  const durationMs = measuredDurationMs && measuredDurationMs > 0
    ? Math.max(15 * 60_000, measuredDurationMs)
    : DEFAULT_CLASS_DURATION_MS;
  const noteStart = noteEnd - durationMs;
  const windowMs = matchWindowMinutes * 60_000;

  const scored = candidates
    .map((candidate) => {
      const classStart = new Date(candidate.start).getTime();
      const classEnd = new Date(candidate.end).getTime();
      if (!Number.isFinite(classStart) || !Number.isFinite(classEnd)) return null;
      const classDuration = Math.max(15 * 60_000, classEnd - classStart);
      const overlap = Math.max(
        0,
        Math.min(noteEnd, classEnd) - Math.max(noteStart, classStart),
      );
      const overlapRatio = Math.min(1, overlap / classDuration);
      const endDeltaMs = Math.abs(noteEnd - classEnd);
      const endCloseness = Math.max(0, 1 - endDeltaMs / windowMs);
      const timeScore = 0.7 * overlapRatio + 0.3 * endCloseness;
      const titleScore = courseTitleScore(note.title ?? "", candidate.course, aliases);
      const score = titleScore > 0
        ? 0.58 * titleScore + 0.42 * timeScore
        : timeScore;
      return {
        candidate,
        score,
        titleScore,
        timeScore,
        endDeltaMs,
        overlapRatio,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.endDeltaMs <= windowMs || item.overlapRatio > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length) {
    return { candidate: null, confidence: 0, reason: "no_class_in_time_window" };
  }

  const best = scored[0];
  const second = scored[1];
  const scoreMargin = second ? best.score - second.score : 1;
  const endMarginMs = second ? second.endDeltaMs - best.endDeltaMs : windowMs;
  const hasOverlap = best.overlapRatio >= 0.2;
  const strongTitle =
    best.titleScore >= 0.72 &&
    best.timeScore >= 0.25 &&
    (!second || scoreMargin >= 0.05 || endMarginMs >= 10 * 60_000);
  const uniqueTime =
    hasOverlap &&
    best.endDeltaMs <= 35 * 60_000 &&
    (!second || endMarginMs >= 25 * 60_000);
  const onlyPlausible =
    hasOverlap && scored.length === 1 && best.endDeltaMs <= 45 * 60_000;
  const clearCombined =
    hasOverlap && best.titleScore > 0 && best.score >= 0.68 && scoreMargin >= 0.1;

  if (!(strongTitle || uniqueTime || onlyPlausible || clearCombined)) {
    return {
      candidate: null,
      confidence: Number(best.score.toFixed(3)),
      reason: "ambiguous_class_match",
    };
  }

  return {
    candidate: best.candidate,
    confidence: Number(best.score.toFixed(3)),
    reason: strongTitle ? "course_and_time" : "unique_class_time",
  };
}

function courseTitleScore(
  noteTitle: string,
  course: string,
  aliases: Record<string, string[]>,
): number {
  const normalizedNote = normalizeTitle(noteTitle);
  if (!normalizedNote || isGenericTitle(normalizedNote)) return 0;
  const names = [course, ...(aliases[course] ?? [])].map(normalizeTitle).filter(Boolean);
  let best = 0;
  for (const name of names) {
    if (normalizedNote.includes(name) || name.includes(normalizedNote)) {
      best = Math.max(best, Math.min(normalizedNote.length, name.length) >= 3 ? 1 : 0);
      continue;
    }
    best = Math.max(best, diceCoefficient(normalizedNote, name));
  }
  return best;
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:제?\s*\d+\s*주차|week\s*\d+|lecture\s*\d+)/giu, "")
    .replace(/[^a-z0-9가-힣]/giu, "");
}

function isGenericTitle(value: string): boolean {
  return new Set([
    "untitled",
    "newnote",
    "새노트",
    "제목없음",
    "recording",
    "녹음",
  ]).has(value);
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * intersection) / (left.length + right.length - 2);
}

export function timeZoneDayBounds(
  date: Date,
  configuredTimeZone?: string,
): { start: string; end: string } {
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("Cannot calculate calendar-day bounds for an invalid date");
  }

  const timeZone = configuredTimeZone?.trim() || KOREA_TIME_ZONE;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }

  const localDateKey = (instant: number): string => {
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(instant))) {
      if (part.type === "year" || part.type === "month" || part.type === "day") {
        values[part.type] = part.value;
      }
    }
    return `${values.year}-${values.month}-${values.day}`;
  };

  const targetDate = localDateKey(timestamp);

  const findStart = (): number => {
    let inside = timestamp;
    for (
      let distance = DAY_BOUND_SEARCH_STEP_MS;
      distance <= MAX_DAY_BOUND_SEARCH_MS;
      distance += DAY_BOUND_SEARCH_STEP_MS
    ) {
      const outside = timestamp - distance;
      if (localDateKey(outside) === targetDate) {
        inside = outside;
        continue;
      }

      let low = outside;
      let high = inside;
      while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (localDateKey(middle) === targetDate) high = middle;
        else low = middle;
      }
      return high;
    }
    throw new RangeError(`Could not find the start of a calendar day in ${timeZone}`);
  };

  const findEnd = (): number => {
    let inside = timestamp;
    for (
      let distance = DAY_BOUND_SEARCH_STEP_MS;
      distance <= MAX_DAY_BOUND_SEARCH_MS;
      distance += DAY_BOUND_SEARCH_STEP_MS
    ) {
      const outside = timestamp + distance;
      if (localDateKey(outside) === targetDate) {
        inside = outside;
        continue;
      }

      let low = inside;
      let high = outside;
      while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (localDateKey(middle) === targetDate) low = middle;
        else high = middle;
      }
      return high;
    }
    throw new RangeError(`Could not find the end of a calendar day in ${timeZone}`);
  };

  return {
    start: new Date(findStart()).toISOString(),
    end: new Date(findEnd()).toISOString(),
  };
}

export function koreaDayBounds(date: Date): { start: string; end: string } {
  return timeZoneDayBounds(date, KOREA_TIME_ZONE);
}

export function summaryMarkdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraphLines: string[] = [];
  let codeLines: string[] | null = null;

  const pushRichTextBlocks = (type: string, text: string) => {
    for (const chunk of chunkText(text)) {
      blocks.push(makeRichTextBlock(type, richTextFromMarkdown(chunk)));
    }
  };

  const flushParagraph = () => {
    const text = paragraphLines.join("\n").trim();
    paragraphLines = [];
    if (!text) return;
    pushRichTextBlocks("paragraph", text);
  };

  const flushCode = () => {
    if (!codeLines) return;
    const text = codeLines.join("\n");
    for (const chunk of chunkText(text || " ")) {
      blocks.push({
        type: "code",
        code: {
          rich_text: [textRichText(chunk)],
          language: "plain text",
        },
      });
    }
    codeLines = null;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (codeLines) flushCode();
      else {
        flushParagraph();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const type = heading[1].length <= 2 ? "heading_2" : "heading_3";
      pushRichTextBlocks(type, heading[2]);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ type: "divider", divider: {} });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      pushRichTextBlocks("bulleted_list_item", bullet[1]);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      flushParagraph();
      pushRichTextBlocks("numbered_list_item", numbered[1]);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      pushRichTextBlocks("quote", quote[1]);
      continue;
    }
    paragraphLines.push(line);
  }
  flushParagraph();
  flushCode();

  return blocks.length
    ? blocks
    : [makeRichTextBlock("paragraph", [textRichText("요약 내용이 없습니다.")])];
}

function transcriptToBlocks(transcript: AltTranscript | null): NotionBlock[] {
  if (!transcript) {
    return [makeRichTextBlock("paragraph", [textRichText("녹취가 없습니다.")])];
  }

  const turns: Array<{ speaker: string | null; text: string }> = [];
  for (const segment of transcript.segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.speaker === segment.speaker) last.text += ` ${text}`;
    else turns.push({ speaker: segment.speaker, text });
  }

  if (!turns.length && transcript.text.trim()) {
    return chunkText(transcript.text.trim()).map((chunk) =>
      makeRichTextBlock("paragraph", [textRichText(chunk)]),
    );
  }

  const blocks: NotionBlock[] = [];
  for (const turn of turns) {
    const chunks = chunkText(turn.text);
    for (let index = 0; index < chunks.length; index += 1) {
      const richText: NotionRichText[] = [];
      if (index === 0 && turn.speaker?.trim()) {
        richText.push(
          textRichText(`${turn.speaker.trim()}: `, {
            bold: true,
          }),
        );
      }
      richText.push(textRichText(chunks[index]));
      blocks.push(makeRichTextBlock("paragraph", richText));
    }
  }
  return blocks.length
    ? blocks
    : [makeRichTextBlock("paragraph", [textRichText("녹취가 없습니다.")])];
}

function makeToggleBlock(title: string): NotionBlock {
  return {
    type: "toggle",
    toggle: { rich_text: [textRichText(title)], color: "default" },
  };
}

function makeTextBlock(type: string, text: string): NotionBlock {
  return makeRichTextBlock(type, [textRichText(text)]);
}

function makeRichTextBlock(type: string, richText: NotionRichText[]): NotionBlock {
  return {
    type,
    [type]: { rich_text: richText, color: "default" },
  };
}

function textRichText(
  content: string,
  annotations: NotionRichText["annotations"] = {},
  url?: string,
): NotionRichText {
  return {
    type: "text",
    text: { content, link: url ? { url } : null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
      ...annotations,
    },
  };
}

function richTextFromMarkdown(text: string): NotionRichText[] {
  const output: NotionRichText[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) output.push(textRichText(text.slice(cursor, index)));
    const token = match[0];
    if (token.startsWith("**")) {
      output.push(textRichText(token.slice(2, -2), { bold: true }));
    } else if (token.startsWith("`")) {
      output.push(textRichText(token.slice(1, -1), { code: true }));
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token);
      if (link) output.push(textRichText(link[1], {}, link[2]));
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) output.push(textRichText(text.slice(cursor)));
  if (output.length > 100) return [textRichText(text)];
  return output.length ? output : [textRichText(text)];
}

function chunkText(text: string, maxLength = 1800): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remainder = text;
  while (remainder.length > maxLength) {
    let split = remainder.lastIndexOf("\n", maxLength);
    if (split < maxLength * 0.5) split = remainder.lastIndexOf(" ", maxLength);
    if (split < maxLength * 0.5) split = maxLength;
    chunks.push(remainder.slice(0, split).trim());
    remainder = remainder.slice(split).trim();
  }
  if (remainder) chunks.push(remainder);
  return chunks.filter(Boolean);
}

function propertyText(property: NotionProperty | undefined): string {
  if (!property) return "";
  if (property.select?.name) return property.select.name;
  return plainText(property.title ?? property.rich_text);
}

function plainText(richText: NotionRichText[] | undefined): string {
  if (!richText) return "";
  return richText
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("")
    .trim();
}

function parseAliases(value: string | undefined): Record<string, string[]> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([course, aliases]) =>
        Array.isArray(aliases) && aliases.every((alias) => typeof alias === "string")
          ? [[course, aliases as string[]]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

async function altGet<T>(path: string, env: Env): Promise<T> {
  return requestJson<T>(`${ALT_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.ALT_API_KEY}` },
  });
}

async function notionRequest<T = unknown>(
  path: string,
  env: Env,
  init: RequestInit = {},
  retryPolicy: "safe" | "rate-limit-only" = "safe",
): Promise<T> {
  return requestJson<T>(
    `${NOTION_API_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env.NOTION_API_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    retryPolicy,
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  retryPolicy: "safe" | "rate-limit-only" = "safe",
): Promise<T> {
  let lastError: ApiError | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (retryPolicy !== "safe" || attempt === 4) throw error;
      await sleep(
        Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250),
      );
      continue;
    }
    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    await response.text();
    const error = new ApiError(response.status);
    lastError = error;
    const retryable = response.status === 429 ||
      (retryPolicy === "safe" && [500, 502, 503, 504, 529].includes(response.status));
    if (!retryable) throw error;
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await sleep(delay);
  }
  throw lastError ?? new Error("Request failed");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
