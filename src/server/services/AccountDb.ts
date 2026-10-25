import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { AccountIsolationError, DatabaseError } from "../../shared/errors";
import type { FilterThread } from "../../shared/schemas";
import type { CompiledFilter } from "./BooleanFilter";

export interface ThreadRecord extends FilterThread {
  readonly snippet?: string;
  readonly lastMessageAt?: number;
  readonly deliveredToAlias?: string | null;
  readonly ghostLabels?: ReadonlyArray<string>;
  readonly aiStatus?: "pending" | "processed" | "skipped" | "error";
}

export interface AccountDbService {
  readonly accountId: string;
  readonly upsertThread: (thread: ThreadRecord) => Effect.Effect<void, DatabaseError>;
  readonly getThread: (id: string) => Effect.Effect<FilterThread | null, DatabaseError>;
  readonly queryThreads: (filter: CompiledFilter) => Effect.Effect<ReadonlyArray<FilterThread>, DatabaseError>;
}

export class AccountDb extends Context.Service<AccountDb, AccountDbService>()(
  "zeroeffect/AccountDb",
) {}

interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  last_message_at: number;
  is_unread: number;
  is_starred: number;
  is_archived: number;
  sender_summary: string;
  delivered_to_alias: string | null;
  labels_json: string;
  ghost_labels_json: string;
  ai_status: "pending" | "processed" | "skipped" | "error";
}

const initialize = (database: Database): void => {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('system', 'user')),
      color_bg TEXT,
      color_text TEXT
    );
    CREATE TABLE IF NOT EXISTS send_as_aliases (
      send_as_email TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      reply_to_address TEXT,
      signature_html TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      verification_status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      last_message_at INTEGER NOT NULL DEFAULT 0,
      is_unread INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      sender_summary TEXT NOT NULL DEFAULT '',
      delivered_to_alias TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json)),
      ghost_labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ghost_labels_json)),
      ai_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (ai_status IN ('pending', 'processed', 'skipped', 'error'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      from_address TEXT NOT NULL,
      to_addresses_json TEXT NOT NULL,
      cc_addresses_json TEXT NOT NULL,
      delivered_to TEXT,
      date_ts INTEGER NOT NULL,
      body_markdown TEXT NOT NULL,
      body_html_sanitized TEXT NOT NULL,
      raw_headers_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      thread_id UNINDEXED, subject, from_address, body_markdown
    );
    CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      filter_ast_json TEXT NOT NULL,
      dsl_string TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      dry_run INTEGER NOT NULL DEFAULT 0,
      min_confidence REAL NOT NULL DEFAULT 0.8,
      precondition_ast_json TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      llm_endpoint_id TEXT NOT NULL,
      api_mode_override TEXT CHECK (api_mode_override IN ('responses', 'chat_completions'))
    );
    CREATE TABLE IF NOT EXISTS ai_audit_logs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      rule_id TEXT REFERENCES ai_rules(id) ON DELETE SET NULL,
      endpoint_id TEXT NOT NULL,
      api_mode_used TEXT NOT NULL,
      model_used TEXT NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT NOT NULL,
      actions_applied_json TEXT NOT NULL,
      reverted INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
};

const toFilterThread = (row: Pick<ThreadRow, "id" | "subject" | "sender_summary" | "labels_json" | "is_unread" | "is_starred" | "is_archived">): FilterThread => ({
  id: row.id,
  subject: row.subject,
  senderSummary: row.sender_summary,
  labels: JSON.parse(row.labels_json) as string[],
  isUnread: row.is_unread === 1,
  isStarred: row.is_starred === 1,
  isArchived: row.is_archived === 1,
});

const makeService = (accountId: string, database: Database): AccountDbService => ({
  accountId,
  upsertThread: (thread) =>
    Effect.try({
      try: () => {
        database.prepare(`
          INSERT INTO threads (
            id, subject, snippet, last_message_at, is_unread, is_starred, is_archived,
            sender_summary, delivered_to_alias, labels_json, ghost_labels_json, ai_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            subject = excluded.subject,
            snippet = excluded.snippet,
            last_message_at = excluded.last_message_at,
            is_unread = excluded.is_unread,
            is_starred = excluded.is_starred,
            is_archived = excluded.is_archived,
            sender_summary = excluded.sender_summary,
            delivered_to_alias = excluded.delivered_to_alias,
            labels_json = excluded.labels_json,
            ghost_labels_json = excluded.ghost_labels_json,
            ai_status = excluded.ai_status
        `).run(
          thread.id,
          thread.subject,
          thread.snippet ?? "",
          thread.lastMessageAt ?? 0,
          Number(thread.isUnread),
          Number(thread.isStarred),
          Number(thread.isArchived),
          thread.senderSummary,
          thread.deliveredToAlias ?? null,
          JSON.stringify(thread.labels),
          JSON.stringify(thread.ghostLabels ?? []),
          thread.aiStatus ?? "pending",
        );
      },
      catch: (cause) => new DatabaseError({ message: "Failed to upsert thread.", operation: "upsertThread", cause }),
    }).pipe(Effect.asVoid),
  getThread: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
        return row ? toFilterThread(row) : null;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load thread.", operation: "getThread", cause }),
    }),
  queryThreads: (filter) =>
    Effect.try({
      try: () => {
        const rows = database
          .prepare(`SELECT threads.* FROM threads WHERE ${filter.sql} ORDER BY last_message_at DESC`)
          .all(...filter.params) as ThreadRow[];
        return rows.map(toFilterThread);
      },
      catch: (cause) => new DatabaseError({ message: "Failed to query threads.", operation: "queryThreads", cause }),
    }),
});

const validateAccountId = (accountId: string): Effect.Effect<void, AccountIsolationError> =>
  /^[a-zA-Z0-9_-]+$/.test(accountId)
    ? Effect.void
    : Effect.fail(new AccountIsolationError({ accountId, reason: "Account IDs may only contain letters, digits, '_' and '-'." }));

export const AccountDbLive = (
  accountId: string,
  dataDirectory = "./data/accounts",
): Layer.Layer<AccountDb, AccountIsolationError | DatabaseError> =>
  Layer.effect(
    AccountDb,
    Effect.gen(function* () {
      yield* validateAccountId(accountId);
      yield* Effect.tryPromise({
        try: () => mkdir(dataDirectory, { recursive: true }),
        catch: (cause) => new DatabaseError({ message: "Failed to create account database directory.", operation: "mkdir", cause }),
      });
      const database = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Database(join(dataDirectory, `${accountId}.sqlite`)),
          catch: (cause) => new DatabaseError({ message: "Failed to open account database.", operation: "openAccountDatabase", cause }),
        }),
        (db) => Effect.sync(() => db.close()),
      );
      yield* Effect.try({
        try: () => initialize(database),
        catch: (cause) => new DatabaseError({ message: "Failed to initialize account database.", operation: "initializeAccountDatabase", cause }),
      });
      return makeService(accountId, database);
    }),
  );

/** Test layer accepts its own in-memory handle so tests never touch disk. */
export const AccountDbTest = (
  accountId: string,
  database: Database,
): Layer.Layer<AccountDb, AccountIsolationError | DatabaseError> =>
  Layer.effect(
    AccountDb,
    Effect.gen(function* () {
      yield* validateAccountId(accountId);
      yield* Effect.try({
        try: () => initialize(database),
        catch: (cause) => new DatabaseError({ message: "Failed to initialize test account database.", operation: "initializeTestAccountDatabase", cause }),
      });
      return makeService(accountId, database);
    }),
  );
