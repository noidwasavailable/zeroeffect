import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { AccountIsolationError, DatabaseError } from "../../shared/errors";
import type { FilterExpr, FilterThread } from "../../shared/schemas";
import type { CompiledFilter } from "./BooleanFilter";

export interface ThreadRecord extends FilterThread {
  readonly snippet?: string;
  readonly lastMessageAt?: number;
  readonly deliveredToAlias?: string | null;
  readonly ghostLabels?: ReadonlyArray<string>;
  readonly aiStatus?: "pending" | "processed" | "skipped" | "error";
}

export interface SendAsAliasRecord {
  readonly sendAsEmail: string;
  readonly displayName: string;
  readonly replyToAddress: string | null;
  readonly signatureHtml: string | null;
  readonly isPrimary: boolean;
  readonly isDefault: boolean;
  readonly verificationStatus: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly fromAddress: string;
  readonly toAddresses: ReadonlyArray<string>;
  readonly ccAddresses: ReadonlyArray<string>;
  readonly deliveredTo: string | null;
  readonly dateTs: number;
  readonly bodyMarkdown: string;
  readonly bodyHtmlSanitized: string;
  readonly rawHeaders: Readonly<Record<string, string>>;
}

export interface AiRuleRecord {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly dryRun: boolean;
  readonly minConfidence: number;
  readonly precondition: FilterExpr;
  readonly systemPrompt: string;
  readonly actions: unknown;
  readonly llmEndpointId: string;
  readonly apiModeOverride: "responses" | "chat_completions" | null;
}

export interface AiThreadContext {
  readonly thread: FilterThread;
  readonly subject: string;
  readonly snippet: string;
  readonly ghostLabels: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<Pick<MessageRecord, "id" | "fromAddress" | "bodyMarkdown">>;
}

export interface AiAppliedAction {
  readonly labelsBefore: ReadonlyArray<string>;
  readonly labelsAdded: ReadonlyArray<string>;
  readonly labelsRemoved: ReadonlyArray<string>;
  readonly archivedBefore: boolean;
  readonly archivedAfter: boolean;
  readonly ghostLabelsBefore: ReadonlyArray<string>;
  readonly ghostLabelsAfter: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly gmailMessageIds: ReadonlyArray<string>;
}

export interface AiAuditRecord {
  readonly id: string;
  readonly threadId: string;
  readonly ruleId: string | null;
  readonly endpointId: string;
  readonly apiModeUsed: "responses" | "chat_completions";
  readonly modelUsed: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly actionsApplied: AiAppliedAction;
  readonly latencyMs: number;
  readonly createdAt: number;
}

export interface AccountDbService {
  readonly accountId: string;
  readonly upsertThread: (thread: ThreadRecord) => Effect.Effect<void, DatabaseError>;
  readonly getThread: (id: string) => Effect.Effect<FilterThread | null, DatabaseError>;
  readonly listPersistedThreadIds: () => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  readonly markThreadHydrated: (id: string) => Effect.Effect<void, DatabaseError>;
  readonly queryThreads: (filter: CompiledFilter) => Effect.Effect<ReadonlyArray<FilterThread>, DatabaseError>;
  readonly upsertMessage: (message: MessageRecord) => Effect.Effect<void, DatabaseError>;
  readonly deleteMessage: (id: string) => Effect.Effect<void, DatabaseError>;
  readonly replaceSendAsAliases: (aliases: ReadonlyArray<SendAsAliasRecord>) => Effect.Effect<void, DatabaseError>;
  readonly listSendAsAliases: () => Effect.Effect<ReadonlyArray<SendAsAliasRecord>, DatabaseError>;
  readonly getHistoryId: () => Effect.Effect<string | null, DatabaseError>;
  readonly setHistoryId: (historyId: string) => Effect.Effect<void, DatabaseError>;
  readonly listEnabledAiRules: () => Effect.Effect<ReadonlyArray<AiRuleRecord>, DatabaseError>;
  readonly getAiThreadContext: (id: string) => Effect.Effect<AiThreadContext | null, DatabaseError>;
  readonly updateAiThread: (id: string, update: { readonly labels: ReadonlyArray<string>; readonly ghostLabels: ReadonlyArray<string>; readonly isArchived: boolean; readonly aiStatus: "processed" | "skipped" | "error" }) => Effect.Effect<void, DatabaseError>;
  readonly insertAiAudit: (audit: AiAuditRecord) => Effect.Effect<void, DatabaseError>;
  readonly getLatestUndoableAiAudit: () => Effect.Effect<AiAuditRecord | null, DatabaseError>;
  readonly markAiAuditReverted: (id: string) => Effect.Effect<void, DatabaseError>;
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
    CREATE TABLE IF NOT EXISTS gmail_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      history_id TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS gmail_hydrated_threads (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY
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

  const migrationId = "gmail-hydrated-threads-v1";
  const migrationExists = database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migrationId);
  if (!migrationExists) {
    database.transaction(() => {
      // Existing rows were written only after each thread's messages had been
      // processed by the pre-marker importer. Preserve them as resumable cache.
      database.prepare(`
        INSERT OR IGNORE INTO gmail_hydrated_threads (thread_id)
        SELECT threads.id FROM threads
        WHERE EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)
      `).run();
      database.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)").run(migrationId);
    })();
  }
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
  listPersistedThreadIds: () =>
    Effect.try({
      try: () => (database.prepare(`
        SELECT thread_id AS id FROM gmail_hydrated_threads
      `).all() as Array<{ id: string }>).map((row) => row.id),
      catch: (cause) => new DatabaseError({ message: "Failed to list persisted Gmail conversations.", operation: "listPersistedThreadIds", cause }),
    }),
  markThreadHydrated: (id) =>
    Effect.try({
      try: () => database.prepare(`
        INSERT INTO gmail_hydrated_threads (thread_id) VALUES (?)
        ON CONFLICT(thread_id) DO NOTHING
      `).run(id),
      catch: (cause) => new DatabaseError({ message: "Failed to mark Gmail conversation as complete.", operation: "markThreadHydrated", cause }),
    }).pipe(Effect.asVoid),
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
  upsertMessage: (message) =>
    Effect.try({
      try: () => {
        database.transaction(() => {
          database.prepare(`
            INSERT INTO messages (
              id, thread_id, from_address, to_addresses_json, cc_addresses_json,
              delivered_to, date_ts, body_markdown, body_html_sanitized, raw_headers_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              thread_id = excluded.thread_id,
              from_address = excluded.from_address,
              to_addresses_json = excluded.to_addresses_json,
              cc_addresses_json = excluded.cc_addresses_json,
              delivered_to = excluded.delivered_to,
              date_ts = excluded.date_ts,
              body_markdown = excluded.body_markdown,
              body_html_sanitized = excluded.body_html_sanitized,
              raw_headers_json = excluded.raw_headers_json
          `).run(
            message.id,
            message.threadId,
            message.fromAddress,
            JSON.stringify(message.toAddresses),
            JSON.stringify(message.ccAddresses),
            message.deliveredTo,
            message.dateTs,
            message.bodyMarkdown,
            message.bodyHtmlSanitized,
            JSON.stringify(message.rawHeaders),
          );
          database.prepare("DELETE FROM messages_fts WHERE thread_id = ?").run(message.threadId);
          database.prepare(`
            INSERT INTO messages_fts (thread_id, subject, from_address, body_markdown)
            SELECT messages.thread_id, threads.subject, messages.from_address, messages.body_markdown
            FROM messages JOIN threads ON threads.id = messages.thread_id
            WHERE messages.thread_id = ?
          `).run(message.threadId);
        })();
      },
      catch: (cause) => new DatabaseError({ message: "Failed to save message.", operation: "upsertMessage", cause }),
    }).pipe(Effect.asVoid),
  deleteMessage: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT thread_id FROM messages WHERE id = ?").get(id) as { thread_id: string } | null;
        database.prepare("DELETE FROM messages WHERE id = ?").run(id);
        if (row) {
          database.prepare("DELETE FROM messages_fts WHERE thread_id = ?").run(row.thread_id);
          database.prepare(`
            INSERT INTO messages_fts (thread_id, subject, from_address, body_markdown)
            SELECT messages.thread_id, threads.subject, messages.from_address, messages.body_markdown
            FROM messages JOIN threads ON threads.id = messages.thread_id
            WHERE messages.thread_id = ?
          `).run(row.thread_id);
        }
      },
      catch: (cause) => new DatabaseError({ message: "Failed to delete message.", operation: "deleteMessage", cause }),
    }).pipe(Effect.asVoid),
  replaceSendAsAliases: (aliases) =>
    Effect.try({
      try: () => {
        database.transaction(() => {
          database.prepare("DELETE FROM send_as_aliases").run();
          const insert = database.prepare(`
            INSERT INTO send_as_aliases (
              send_as_email, display_name, reply_to_address, signature_html,
              is_primary, is_default, verification_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const alias of aliases) {
            insert.run(
              alias.sendAsEmail,
              alias.displayName,
              alias.replyToAddress,
              alias.signatureHtml,
              Number(alias.isPrimary),
              Number(alias.isDefault),
              alias.verificationStatus,
            );
          }
        })();
      },
      catch: (cause) => new DatabaseError({ message: "Failed to replace Send As aliases.", operation: "replaceSendAsAliases", cause }),
    }).pipe(Effect.asVoid),
  listSendAsAliases: () =>
    Effect.try({
      try: () => (database.prepare(`
        SELECT send_as_email AS sendAsEmail, display_name AS displayName,
          reply_to_address AS replyToAddress, signature_html AS signatureHtml,
          is_primary AS isPrimary, is_default AS isDefault,
          verification_status AS verificationStatus
        FROM send_as_aliases ORDER BY is_default DESC, is_primary DESC, send_as_email
      `).all() as Array<Omit<SendAsAliasRecord, "isPrimary" | "isDefault"> & { isPrimary: number; isDefault: number }>).map((row) => ({
        ...row,
        isPrimary: row.isPrimary === 1,
        isDefault: row.isDefault === 1,
      })),
      catch: (cause) => new DatabaseError({ message: "Failed to load Send As aliases.", operation: "listSendAsAliases", cause }),
    }),
  getHistoryId: () =>
    Effect.try({
      try: () => (database.prepare("SELECT history_id FROM gmail_sync_state WHERE id = 1").get() as { history_id: string } | null)?.history_id ?? null,
      catch: (cause) => new DatabaseError({ message: "Failed to load Gmail history cursor.", operation: "getHistoryId", cause }),
    }),
  setHistoryId: (historyId) =>
    Effect.try({
      try: () => database.prepare(`
        INSERT INTO gmail_sync_state (id, history_id) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET history_id = excluded.history_id
      `).run(historyId),
      catch: (cause) => new DatabaseError({ message: "Failed to save Gmail history cursor.", operation: "setHistoryId", cause }),
    }).pipe(Effect.asVoid),
  listEnabledAiRules: () =>
    Effect.try({
      try: () => (database.prepare(`
        SELECT id, name, priority, dry_run AS dryRun, min_confidence AS minConfidence,
          precondition_ast_json AS preconditionJson, system_prompt AS systemPrompt,
          actions_json AS actionsJson, llm_endpoint_id AS llmEndpointId,
          api_mode_override AS apiModeOverride
        FROM ai_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC
      `).all() as Array<{
        id: string; name: string; priority: number; dryRun: number; minConfidence: number;
        preconditionJson: string; systemPrompt: string; actionsJson: string;
        llmEndpointId: string; apiModeOverride: "responses" | "chat_completions" | null;
      }>).map((row) => ({
        id: row.id,
        name: row.name,
        priority: row.priority,
        dryRun: row.dryRun === 1,
        minConfidence: row.minConfidence,
        precondition: JSON.parse(row.preconditionJson) as FilterExpr,
        systemPrompt: row.systemPrompt,
        actions: JSON.parse(row.actionsJson) as unknown,
        llmEndpointId: row.llmEndpointId,
        apiModeOverride: row.apiModeOverride,
      })),
      catch: (cause) => new DatabaseError({ message: "Failed to load AI rules.", operation: "listEnabledAiRules", cause }),
    }),
  getAiThreadContext: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
        if (!row) return null;
        const messages = database.prepare(`
          SELECT id, from_address AS fromAddress, body_markdown AS bodyMarkdown
          FROM messages WHERE thread_id = ? ORDER BY date_ts ASC, id ASC
        `).all(id) as Array<{ id: string; fromAddress: string; bodyMarkdown: string }>;
        return {
          thread: toFilterThread(row),
          subject: row.subject,
          snippet: row.snippet,
          ghostLabels: JSON.parse(row.ghost_labels_json) as string[],
          messages,
        };
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load AI thread context.", operation: "getAiThreadContext", cause }),
    }),
  updateAiThread: (id, update) =>
    Effect.try({
      try: () => database.prepare(`
        UPDATE threads SET labels_json = ?, ghost_labels_json = ?, is_archived = ?, ai_status = ?
        WHERE id = ?
      `).run(JSON.stringify(update.labels), JSON.stringify(update.ghostLabels), Number(update.isArchived), update.aiStatus, id),
      catch: (cause) => new DatabaseError({ message: "Failed to update AI thread state.", operation: "updateAiThread", cause }),
    }).pipe(Effect.asVoid),
  insertAiAudit: (audit) =>
    Effect.try({
      try: () => database.prepare(`
        INSERT INTO ai_audit_logs (
          id, thread_id, rule_id, endpoint_id, api_mode_used, model_used, confidence,
          reasoning, actions_applied_json, reverted, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        audit.id, audit.threadId, audit.ruleId, audit.endpointId, audit.apiModeUsed,
        audit.modelUsed, audit.confidence, audit.reasoning, JSON.stringify(audit.actionsApplied),
        audit.latencyMs, audit.createdAt,
      ),
      catch: (cause) => new DatabaseError({ message: "Failed to write AI audit log.", operation: "insertAiAudit", cause }),
    }).pipe(Effect.asVoid),
  getLatestUndoableAiAudit: () =>
    Effect.try({
      try: () => {
        const row = database.prepare(`
          SELECT id, thread_id AS threadId, rule_id AS ruleId, endpoint_id AS endpointId,
            api_mode_used AS apiModeUsed, model_used AS modelUsed, confidence, reasoning,
            actions_applied_json AS actionsJson, latency_ms AS latencyMs, created_at AS createdAt
          FROM ai_audit_logs WHERE reverted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get() as {
          id: string; threadId: string; ruleId: string | null; endpointId: string;
          apiModeUsed: "responses" | "chat_completions"; modelUsed: string; confidence: number;
          reasoning: string; actionsJson: string; latencyMs: number; createdAt: number;
        } | null;
        if (!row) return null;
        return {
          id: row.id,
          threadId: row.threadId,
          ruleId: row.ruleId,
          endpointId: row.endpointId,
          apiModeUsed: row.apiModeUsed,
          modelUsed: row.modelUsed,
          confidence: row.confidence,
          reasoning: row.reasoning,
          actionsApplied: JSON.parse(row.actionsJson) as AiAppliedAction,
          latencyMs: row.latencyMs,
          createdAt: row.createdAt,
        };
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load undoable AI audit log.", operation: "getLatestUndoableAiAudit", cause }),
    }),
  markAiAuditReverted: (id) =>
    Effect.try({
      try: () => database.prepare("UPDATE ai_audit_logs SET reverted = 1 WHERE id = ? AND reverted = 0").run(id),
      catch: (cause) => new DatabaseError({ message: "Failed to mark AI audit log as reverted.", operation: "markAiAuditReverted", cause }),
    }).pipe(Effect.asVoid),
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
