import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { AccountIsolationError, DatabaseError } from "../../shared/errors";
import type { ConversationStatus, LlmApiMode } from "../../shared/aiRules";
import { extractOtpCode } from "../../shared/otp";
import { formatFilterExpr, renameFilterLabels } from "../../shared/filterDsl";
import { applyLabelChange } from "../../shared/threadActions";
import type { FilterExpr, FilterThread } from "../../shared/schemas";
import type { SearchDocument } from "../../shared/searchText";
import type { ThreadDetail, ThreadSummary, ViewSummary } from "../../shared/api";
import { renameLabelsInRulesFile } from "./AiRules";
import type { AttachmentRecord } from "./MimeParser";
import type { CompiledFilter } from "./BooleanFilter";

export interface ThreadRecord extends FilterThread {
  readonly snippet?: string;
  readonly lastMessageAt?: number;
  readonly deliveredToAlias?: string | null;
  readonly ghostLabels?: ReadonlyArray<string>;
  readonly aiStatus?: "pending" | "processed" | "skipped" | "error";
  /** One-time code found in the newest message (see shared/otp.ts); shown for OTP-labelled threads. */
  readonly otpCode?: string | null;
}

export interface LabelRecord {
  readonly id: string;
  readonly name: string;
  readonly type: "system" | "user";
  readonly colorBg: string | null;
  readonly colorText: string | null;
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
  /** Original message HTML; null for plain-text mail (and for messages stored before it was kept). */
  readonly bodyHtml?: string | null;
  readonly rawHeaders: Readonly<Record<string, string>>;
  /** This message's Gmail label names; a thread's labels are the union over its messages. */
  readonly labels?: ReadonlyArray<string>;
  readonly attachments?: ReadonlyArray<AttachmentRecord>;
}

export interface AiThreadMessage {
  readonly id: string;
  readonly fromAddress: string;
  readonly toAddresses: ReadonlyArray<string>;
  readonly ccAddresses: ReadonlyArray<string>;
  readonly deliveredTo: string | null;
  readonly dateTs: number;
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly labels: ReadonlyArray<string>;
  readonly listUnsubscribe: boolean;
}

export interface AiThreadContext {
  readonly thread: ThreadSummary;
  /** Date of the newest message the AI has already classified (null: never evaluated). */
  readonly aiEvaluatedThrough: number | null;
  /** Chronological, oldest first. */
  readonly messages: ReadonlyArray<AiThreadMessage>;
}

/** What one AI run changed, so it can be undone exactly. */
export interface AiRunChanges {
  readonly labelsAdded: ReadonlyArray<string>;
  readonly labelsRemoved: ReadonlyArray<string>;
  readonly ghostLabelsAdded: ReadonlyArray<string>;
  readonly ghostLabelsBefore: ReadonlyArray<string>;
}

export interface AiAuditRecord {
  readonly id: string;
  readonly threadId: string;
  readonly trigger: "auto" | "manual";
  /** Rules applied in this run, including a resolved conversation status rule. */
  readonly ruleNames: ReadonlyArray<string>;
  readonly conversationStatus: ConversationStatus | null;
  /** Null when the run needed no LLM call (static or inherited matches only). */
  readonly endpointId: string | null;
  readonly apiModeUsed: LlmApiMode | null;
  readonly modelUsed: string | null;
  readonly reasoning: string;
  readonly changes: AiRunChanges;
  readonly reverted: boolean;
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
  /** One page of matching threads, newest first, as shown in the thread list. */
  readonly listThreadSummaries: (filter: CompiledFilter, page: { readonly limit: number; readonly offset: number }) => Effect.Effect<ReadonlyArray<ThreadSummary>, DatabaseError>;
  readonly getThreadDetail: (id: string) => Effect.Effect<ThreadDetail | null, DatabaseError>;
  /** Adds/removes label names on every message of a thread (as Gmail's threads.modify does) and on the thread. */
  readonly applyThreadLabelChange: (id: string, add: ReadonlyArray<string>, remove: ReadonlyArray<string>) => Effect.Effect<ThreadSummary | null, DatabaseError>;
  /** Recomputes a thread's labels and flags as the union of its messages' labels (Gmail's thread semantics). */
  readonly refreshThreadLabelsFromMessages: (id: string) => Effect.Effect<void, DatabaseError>;
  readonly listSavedViews: () => Effect.Effect<ReadonlyArray<ViewSummary>, DatabaseError>;
  /** Appends a saved view; its DSL is always the canonical formatting of `filter`. */
  readonly createSavedView: (view: { readonly id: string; readonly name: string; readonly filter: FilterExpr }) => Effect.Effect<ViewSummary, DatabaseError>;
  readonly updateSavedView: (id: string, update: { readonly name?: string; readonly filter?: FilterExpr }) => Effect.Effect<ViewSummary | null, DatabaseError>;
  readonly deleteSavedView: (id: string) => Effect.Effect<boolean, DatabaseError>;
  /** Sets the sidebar order; `ids` must list every saved view exactly once. */
  readonly reorderSavedViews: (ids: ReadonlyArray<string>) => Effect.Effect<void, DatabaseError>;
  readonly upsertMessage: (message: MessageRecord) => Effect.Effect<void, DatabaseError>;
  readonly deleteMessage: (id: string) => Effect.Effect<void, DatabaseError>;
  /** Stores a message's original HTML (backfill for messages synced before it was kept). */
  readonly setMessageBodyHtml: (id: string, bodyHtml: string) => Effect.Effect<void, DatabaseError>;
  /** A message's attachments; null when it was stored before attachments were recorded (or is unknown). */
  readonly getMessageAttachments: (id: string) => Effect.Effect<ReadonlyArray<AttachmentRecord> | null, DatabaseError>;
  readonly setMessageAttachments: (id: string, attachments: ReadonlyArray<AttachmentRecord>) => Effect.Effect<void, DatabaseError>;
  /** A thread's `messages_fts` rows (subject, sender, body, attachment names), for in-memory `Text` evaluation. */
  readonly getThreadSearchDocuments: (threadId: string) => Effect.Effect<ReadonlyArray<SearchDocument>, DatabaseError>;
  /** Messages of a thread stored before attachments were recorded (backfilled when the thread is opened). */
  readonly listMessagesWithoutAttachmentInfo: (threadId: string) => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  /** Applies one label change to many threads in a single transaction (bulk actions). */
  readonly applyThreadsLabelChange: (ids: ReadonlyArray<string>, add: ReadonlyArray<string>, remove: ReadonlyArray<string>) => Effect.Effect<void, DatabaseError>;
  /** Message ids of these threads; with `withLabel`, only messages carrying that label (e.g. UNREAD). */
  readonly listMessageIds: (threadIds: ReadonlyArray<string>, withLabel?: string) => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  /** Ids of every thread matching a filter (no paging; bulk actions over a whole view). */
  readonly listThreadIds: (filter: CompiledFilter) => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  /** Drops a deleted Gmail label from every thread and message (and from suggested labels). */
  readonly removeLabelEverywhere: (name: string) => Effect.Effect<void, DatabaseError>;
  /** Replaces the label catalog and rewrites stored thread labels for renamed (or legacy ID-valued) labels. */
  readonly replaceLabels: (labels: ReadonlyArray<LabelRecord>) => Effect.Effect<void, DatabaseError>;
  readonly upsertLabel: (label: LabelRecord) => Effect.Effect<void, DatabaseError>;
  readonly listLabels: () => Effect.Effect<ReadonlyArray<LabelRecord>, DatabaseError>;
  readonly replaceSendAsAliases: (aliases: ReadonlyArray<SendAsAliasRecord>) => Effect.Effect<void, DatabaseError>;
  readonly listSendAsAliases: () => Effect.Effect<ReadonlyArray<SendAsAliasRecord>, DatabaseError>;
  readonly getHistoryId: () => Effect.Effect<string | null, DatabaseError>;
  readonly setHistoryId: (historyId: string) => Effect.Effect<void, DatabaseError>;
  readonly getAiThreadContext: (id: string) => Effect.Effect<AiThreadContext | null, DatabaseError>;
  /** A message's stored headers (lower-cased names), e.g. message-id and references for replies. */
  readonly getMessageHeaders: (messageId: string) => Effect.Effect<Readonly<Record<string, string>> | null, DatabaseError>;
  readonly setGhostLabels: (id: string, ghostLabels: ReadonlyArray<string>) => Effect.Effect<void, DatabaseError>;
  readonly markAiEvaluated: (id: string, update: { readonly through: number | null; readonly status: "processed" | "skipped" | "error" }) => Effect.Effect<void, DatabaseError>;
  readonly insertAiAudit: (audit: AiAuditRecord) => Effect.Effect<void, DatabaseError>;
  readonly listAiAudits: (threadId: string) => Effect.Effect<ReadonlyArray<AiAuditRecord>, DatabaseError>;
  /** Names of rules applied to a thread by runs that were not undone. */
  readonly appliedRuleNames: (threadId: string) => Effect.Effect<ReadonlySet<string>, DatabaseError>;
  readonly getLatestUndoableAiAudit: () => Effect.Effect<AiAuditRecord | null, DatabaseError>;
  readonly markAiAuditReverted: (id: string) => Effect.Effect<void, DatabaseError>;
  /** The account's AI rules file (JSON text), stored next to its database; null when absent. */
  readonly readRulesFile: () => Effect.Effect<string | null, DatabaseError>;
  readonly writeRulesFile: (text: string) => Effect.Effect<void, DatabaseError>;
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
  ai_evaluated_through: number | null;
  otp_code: string | null;
}

interface AuditRow {
  id: string;
  thread_id: string;
  trigger: "auto" | "manual";
  rule_names_json: string;
  conversation_status: ConversationStatus | null;
  endpoint_id: string | null;
  api_mode_used: LlmApiMode | null;
  model_used: string | null;
  reasoning: string;
  actions_applied_json: string;
  reverted: number;
  latency_ms: number;
  created_at: number;
}

const toAuditRecord = (row: AuditRow): AiAuditRecord => ({
  id: row.id,
  threadId: row.thread_id,
  trigger: row.trigger,
  ruleNames: JSON.parse(row.rule_names_json) as string[],
  conversationStatus: row.conversation_status,
  endpointId: row.endpoint_id,
  apiModeUsed: row.api_mode_used,
  modelUsed: row.model_used,
  reasoning: row.reasoning,
  changes: JSON.parse(row.actions_applied_json) as AiRunChanges,
  reverted: row.reverted === 1,
  latencyMs: row.latency_ms,
  createdAt: row.created_at,
});

/** Where an account's rules JSON lives: a file beside its database, or memory in tests. */
interface RulesStore {
  readonly read: () => string | null;
  readonly write: (text: string) => void;
}

const fileRulesStore = (path: string): RulesStore => ({
  read: () => existsSync(path) ? readFileSync(path, "utf8") : null,
  write: (text) => {
    // Write-then-rename so a crash never leaves a half-written rules file.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  },
});

const memoryRulesStores = new WeakMap<Database, { text: string | null }>();
const memoryRulesStore = (database: Database): RulesStore => {
  const slot = memoryRulesStores.get(database) ?? { text: null };
  memoryRulesStores.set(database, slot);
  return { read: () => slot.text, write: (text) => { slot.text = text; } };
};

const AUDIT_LOG_TABLE = `
  CREATE TABLE IF NOT EXISTS ai_audit_logs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
    rule_names_json TEXT NOT NULL,
    conversation_status TEXT,
    endpoint_id TEXT,
    api_mode_used TEXT,
    model_used TEXT,
    reasoning TEXT NOT NULL,
    actions_applied_json TEXT NOT NULL,
    undoable INTEGER NOT NULL,
    reverted INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const LABEL_NAMES_MIGRATION_ID = "thread-label-names-v1";

const columnNames = (database: Database, table: string): string[] =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

/**
 * Moves databases created before AI rules lived in JSON files to the current layout:
 * per-message labels, an AI evaluation marker per thread, and run-level audit logs.
 * Old AI tables are kept (renamed legacy_*) if they hold rows, and dropped when empty.
 */
const migrateAiStorage = (database: Database): void => {
  database.transaction(() => {
    if (!columnNames(database, "threads").includes("ai_evaluated_through")) {
      database.exec("ALTER TABLE threads ADD COLUMN ai_evaluated_through INTEGER");
    }
    if (!columnNames(database, "threads").includes("otp_code")) {
      database.exec("ALTER TABLE threads ADD COLUMN otp_code TEXT");
      // Backfill from each thread's newest message, as sync does for new mail.
      const newest = database.prepare(`
        SELECT threads.id, threads.subject, messages.body_markdown FROM threads
        JOIN messages ON messages.id = (
          SELECT id FROM messages WHERE thread_id = threads.id ORDER BY date_ts DESC, id DESC LIMIT 1
        )
      `).all() as Array<{ id: string; subject: string; body_markdown: string }>;
      const update = database.prepare("UPDATE threads SET otp_code = ? WHERE id = ?");
      for (const row of newest) {
        const code = extractOtpCode(row.subject, row.body_markdown);
        if (code) update.run(code, row.id);
      }
    }
    if (!columnNames(database, "messages").includes("body_html")) {
      // NULL marks messages stored before original HTML was kept; the API refetches those on open.
      database.exec("ALTER TABLE messages ADD COLUMN body_html TEXT");
    }
    if (!columnNames(database, "messages").includes("attachments_json")) {
      // NULL marks messages stored before attachments were recorded; the API refetches those on open.
      database.exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT");
    }
    if (!columnNames(database, "messages").includes("labels_json")) {
      database.exec("ALTER TABLE messages ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'");
      // Best available history: each message gets its thread's labels as of this migration.
      database.exec("UPDATE messages SET labels_json = (SELECT labels_json FROM threads WHERE threads.id = messages.thread_id)");
    }
    const keepOrDrop = (table: string) => {
      const rows = (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      database.exec(rows > 0 ? `ALTER TABLE ${table} RENAME TO legacy_${table}` : `DROP TABLE ${table}`);
    };
    const auditColumns = columnNames(database, "ai_audit_logs");
    if (auditColumns.length > 0 && !auditColumns.includes("rule_names_json")) keepOrDrop("ai_audit_logs");
    if (columnNames(database, "ai_rules").length > 0) keepOrDrop("ai_rules");
    database.exec(AUDIT_LOG_TABLE);
  })();
};

// Full-text search over every message (FR-FILTER-04). The tokenizer is shared with the in-memory
// evaluator (src/shared/searchText.ts), so changing it means regenerating src/shared/unicode61Table.ts.
const MESSAGES_FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    thread_id UNINDEXED, subject, from_address, body_markdown, attachment_names,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;
const SEARCH_INDEX_MIGRATION_ID = "messages-fts-v2";

/** Rewrites a thread's search rows from its messages: one row per message, with the thread subject. */
const reindexThreadText = (database: Database, threadId: string): void => {
  database.prepare("DELETE FROM messages_fts WHERE thread_id = ?").run(threadId);
  database.prepare(`
    INSERT INTO messages_fts (thread_id, subject, from_address, body_markdown, attachment_names)
    SELECT messages.thread_id, threads.subject, messages.from_address, messages.body_markdown,
      COALESCE((
        SELECT group_concat(json_extract(attachment.value, '$.filename'), ' ')
        FROM json_each(messages.attachments_json) AS attachment
        WHERE NOT json_extract(attachment.value, '$.inline')
      ), '')
    FROM messages JOIN threads ON threads.id = messages.thread_id
    WHERE messages.thread_id = ?
  `).run(threadId);
};

/** The v1 index used FTS5's default tokenizer and had no attachment names: rebuild it once. */
const migrateSearchIndex = (database: Database): void => {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(SEARCH_INDEX_MIGRATION_ID)) return;
  database.transaction(() => {
    if (!columnNames(database, "messages_fts").includes("attachment_names")) {
      database.exec("DROP TABLE messages_fts");
      database.exec(MESSAGES_FTS_TABLE);
      const threadIds = database.prepare("SELECT DISTINCT thread_id FROM messages").all() as Array<{ thread_id: string }>;
      for (const row of threadIds) reindexThreadText(database, row.thread_id);
    }
    database.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(SEARCH_INDEX_MIGRATION_ID);
  })();
};

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
        CHECK (ai_status IN ('pending', 'processed', 'skipped', 'error')),
      ai_evaluated_through INTEGER,
      otp_code TEXT
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
      raw_headers_json TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      body_html TEXT,
      attachments_json TEXT
    );
    ${MESSAGES_FTS_TABLE}
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
  `);

  migrateAiStorage(database);
  migrateSearchIndex(database);

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

/** Stores a thread's label names and derives its unread/starred/archived flags from them. */
const writeThreadLabels = (database: Database, id: string, labels: ReadonlyArray<string>): ThreadSummary | null => {
  const row = database.prepare(`
    UPDATE threads SET labels_json = ?, is_unread = ?, is_starred = ?, is_archived = ?
    WHERE id = ? RETURNING *
  `).get(
    JSON.stringify(labels),
    Number(labels.includes("UNREAD")),
    Number(labels.includes("STARRED")),
    Number(!labels.includes("INBOX")),
    id,
  ) as ThreadRow | null;
  return row ? toThreadSummary(row) : null;
};

const toThreadSummary = (row: ThreadRow): ThreadSummary => ({
  ...toFilterThread(row),
  snippet: row.snippet,
  lastMessageAt: row.last_message_at,
  ghostLabels: JSON.parse(row.ghost_labels_json) as string[],
  aiStatus: row.ai_status,
  otpCode: row.otp_code ?? null,
});

const makeService = (accountId: string, database: Database, rulesStore: RulesStore): AccountDbService => ({
  accountId,
  upsertThread: (thread) =>
    Effect.try({
      try: () => database.transaction(() => {
        const previous = database.prepare("SELECT subject FROM threads WHERE id = ?").get(thread.id) as { subject: string } | null;
        const saved = database.prepare(`
          INSERT INTO threads (
            id, subject, snippet, last_message_at, is_unread, is_starred, is_archived,
            sender_summary, delivered_to_alias, labels_json, ghost_labels_json, ai_status, otp_code
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, '[]'), COALESCE(?12, 'pending'), ?13)
          ON CONFLICT(id) DO UPDATE SET
            -- Display fields follow the newest message; updating an older message must not roll them back.
            subject = CASE WHEN excluded.last_message_at >= threads.last_message_at THEN excluded.subject ELSE threads.subject END,
            snippet = CASE WHEN excluded.last_message_at >= threads.last_message_at THEN excluded.snippet ELSE threads.snippet END,
            sender_summary = CASE WHEN excluded.last_message_at >= threads.last_message_at THEN excluded.sender_summary ELSE threads.sender_summary END,
            delivered_to_alias = CASE WHEN excluded.last_message_at >= threads.last_message_at THEN excluded.delivered_to_alias ELSE threads.delivered_to_alias END,
            otp_code = CASE WHEN excluded.last_message_at >= threads.last_message_at THEN excluded.otp_code ELSE threads.otp_code END,
            last_message_at = MAX(threads.last_message_at, excluded.last_message_at),
            is_unread = excluded.is_unread,
            is_starred = excluded.is_starred,
            is_archived = excluded.is_archived,
            labels_json = excluded.labels_json,
            -- AI state is owned by the AI worker; sync only sets it when explicitly given.
            ghost_labels_json = COALESCE(?11, threads.ghost_labels_json),
            ai_status = COALESCE(?12, threads.ai_status)
          RETURNING subject
        `).get(
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
          thread.ghostLabels ? JSON.stringify(thread.ghostLabels) : null,
          thread.aiStatus ?? null,
          thread.otpCode ?? null,
        ) as { subject: string };
        // Search rows carry the thread subject.
        if (previous && previous.subject !== saved.subject) reindexThreadText(database, thread.id);
      })(),
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
  listThreadSummaries: (filter, page) =>
    Effect.try({
      try: () => (database
        .prepare(`SELECT threads.* FROM threads WHERE ${filter.sql} ORDER BY last_message_at DESC, id LIMIT ? OFFSET ?`)
        .all(...filter.params, page.limit, page.offset) as ThreadRow[]).map(toThreadSummary),
      catch: (cause) => new DatabaseError({ message: "Failed to list threads.", operation: "listThreadSummaries", cause }),
    }),
  getThreadDetail: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
        if (!row) return null;
        const messages = (database.prepare(`
          SELECT id, from_address, to_addresses_json, cc_addresses_json, delivered_to, date_ts, body_markdown, body_html_sanitized, body_html, labels_json, attachments_json
          FROM messages WHERE thread_id = ? ORDER BY date_ts ASC, id ASC
        `).all(id) as Array<{
          id: string; from_address: string; to_addresses_json: string; cc_addresses_json: string;
          delivered_to: string | null; date_ts: number; body_markdown: string; body_html_sanitized: string; body_html: string | null; labels_json: string;
          attachments_json: string | null;
        }>).map((message) => ({
          id: message.id,
          fromAddress: message.from_address,
          toAddresses: JSON.parse(message.to_addresses_json) as string[],
          ccAddresses: JSON.parse(message.cc_addresses_json) as string[],
          deliveredTo: message.delivered_to,
          dateTs: message.date_ts,
          bodyMarkdown: message.body_markdown,
          bodyHtmlSanitized: message.body_html_sanitized,
          bodyHtml: message.body_html,
          isUnread: (JSON.parse(message.labels_json) as string[]).includes("UNREAD"),
          attachments: (JSON.parse(message.attachments_json ?? "[]") as AttachmentRecord[])
            .map(({ partId, filename, mimeType, size, contentId, inline }) => ({ partId, filename, mimeType, size, contentId, inline })),
        }));
        return { ...toThreadSummary(row), messages };
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load thread.", operation: "getThreadDetail", cause }),
    }),
  applyThreadLabelChange: (id, add, remove) =>
    Effect.try({
      try: () => database.transaction(() => {
        const thread = database.prepare("SELECT labels_json FROM threads WHERE id = ?").get(id) as { labels_json: string } | null;
        if (!thread) return null;
        const messages = database.prepare("SELECT id, labels_json FROM messages WHERE thread_id = ?").all(id) as Array<{ id: string; labels_json: string }>;
        const updateMessage = database.prepare("UPDATE messages SET labels_json = ? WHERE id = ?");
        for (const message of messages) {
          updateMessage.run(JSON.stringify(applyLabelChange(JSON.parse(message.labels_json) as string[], add, remove)), message.id);
        }
        return writeThreadLabels(database, id, applyLabelChange(JSON.parse(thread.labels_json) as string[], add, remove));
      })(),
      catch: (cause) => new DatabaseError({ message: "Failed to update thread labels.", operation: "applyThreadLabelChange", cause }),
    }),
  refreshThreadLabelsFromMessages: (id) =>
    Effect.try({
      try: () => {
        const messages = database.prepare("SELECT labels_json FROM messages WHERE thread_id = ? ORDER BY date_ts, id").all(id) as Array<{ labels_json: string }>;
        if (messages.length === 0) return;
        writeThreadLabels(database, id, [...new Set(messages.flatMap((message) => JSON.parse(message.labels_json) as string[]))]);
      },
      catch: (cause) => new DatabaseError({ message: "Failed to refresh thread labels.", operation: "refreshThreadLabelsFromMessages", cause }),
    }).pipe(Effect.asVoid),
  listSavedViews: () =>
    Effect.try({
      try: () => (database.prepare("SELECT id, name, dsl_string FROM saved_views ORDER BY sort_order, name").all() as Array<{
        id: string; name: string; dsl_string: string;
      }>).map((row) => ({ id: row.id, name: row.name, dsl: row.dsl_string, builtIn: false })),
      catch: (cause) => new DatabaseError({ message: "Failed to load saved views.", operation: "listSavedViews", cause }),
    }),
  createSavedView: (view) =>
    Effect.try({
      try: () => {
        const row = database.prepare(`
          INSERT INTO saved_views (id, name, sort_order, filter_ast_json, dsl_string)
          VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM saved_views), ?, ?)
          RETURNING id, name, dsl_string
        `).get(view.id, view.name, JSON.stringify(view.filter), formatFilterExpr(view.filter)) as { id: string; name: string; dsl_string: string };
        return { id: row.id, name: row.name, dsl: row.dsl_string, builtIn: false };
      },
      catch: (cause) => new DatabaseError({ message: "Failed to save view.", operation: "createSavedView", cause }),
    }),
  updateSavedView: (id, update) =>
    Effect.try({
      try: () => {
        const row = database.prepare(`
          UPDATE saved_views SET
            name = COALESCE(?, name),
            filter_ast_json = COALESCE(?, filter_ast_json),
            dsl_string = COALESCE(?, dsl_string)
          WHERE id = ? RETURNING id, name, dsl_string
        `).get(
          update.name ?? null,
          update.filter ? JSON.stringify(update.filter) : null,
          update.filter ? formatFilterExpr(update.filter) : null,
          id,
        ) as { id: string; name: string; dsl_string: string } | null;
        return row ? { id: row.id, name: row.name, dsl: row.dsl_string, builtIn: false } : null;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to update view.", operation: "updateSavedView", cause }),
    }),
  deleteSavedView: (id) =>
    Effect.try({
      try: () => database.prepare("DELETE FROM saved_views WHERE id = ?").run(id).changes > 0,
      catch: (cause) => new DatabaseError({ message: "Failed to delete view.", operation: "deleteSavedView", cause }),
    }),
  reorderSavedViews: (ids) =>
    Effect.try({
      try: () => {
        database.transaction(() => {
          const update = database.prepare("UPDATE saved_views SET sort_order = ? WHERE id = ?");
          ids.forEach((id, index) => update.run(index + 1, id));
        })();
      },
      catch: (cause) => new DatabaseError({ message: "Failed to reorder views.", operation: "reorderSavedViews", cause }),
    }).pipe(Effect.asVoid),
  upsertMessage: (message) =>
    Effect.try({
      try: () => {
        database.transaction(() => {
          database.prepare(`
            INSERT INTO messages (
              id, thread_id, from_address, to_addresses_json, cc_addresses_json,
              delivered_to, date_ts, body_markdown, body_html_sanitized, raw_headers_json, labels_json, body_html, attachments_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              thread_id = excluded.thread_id,
              from_address = excluded.from_address,
              to_addresses_json = excluded.to_addresses_json,
              cc_addresses_json = excluded.cc_addresses_json,
              delivered_to = excluded.delivered_to,
              date_ts = excluded.date_ts,
              body_markdown = excluded.body_markdown,
              body_html_sanitized = excluded.body_html_sanitized,
              raw_headers_json = excluded.raw_headers_json,
              labels_json = excluded.labels_json,
              body_html = excluded.body_html,
              attachments_json = excluded.attachments_json
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
            JSON.stringify(message.labels ?? []),
            message.bodyHtml ?? null,
            message.attachments ? JSON.stringify(message.attachments) : null,
          );
          reindexThreadText(database, message.threadId);
        })();
      },
      catch: (cause) => new DatabaseError({ message: "Failed to save message.", operation: "upsertMessage", cause }),
    }).pipe(Effect.asVoid),
  setMessageBodyHtml: (id, bodyHtml) =>
    Effect.try({
      try: () => { database.prepare("UPDATE messages SET body_html = ? WHERE id = ?").run(bodyHtml, id); },
      catch: (cause) => new DatabaseError({ message: "Failed to save message HTML.", operation: "setMessageBodyHtml", cause }),
    }),
  getMessageAttachments: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT attachments_json FROM messages WHERE id = ?").get(id) as { attachments_json: string | null } | null;
        return row?.attachments_json ? JSON.parse(row.attachments_json) as AttachmentRecord[] : null;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load attachments.", operation: "getMessageAttachments", cause }),
    }),
  setMessageAttachments: (id, attachments) =>
    Effect.try({
      try: () => database.transaction(() => {
        const row = database.prepare("UPDATE messages SET attachments_json = ? WHERE id = ? RETURNING thread_id")
          .get(JSON.stringify(attachments), id) as { thread_id: string } | null;
        if (row) reindexThreadText(database, row.thread_id);
      })(),
      catch: (cause) => new DatabaseError({ message: "Failed to save attachments.", operation: "setMessageAttachments", cause }),
    }),
  getThreadSearchDocuments: (threadId) =>
    Effect.try({
      try: () => (database.prepare(`
        SELECT subject, from_address, body_markdown, attachment_names FROM messages_fts WHERE thread_id = ? ORDER BY rowid
      `).all(threadId) as Array<{ subject: string; from_address: string; body_markdown: string; attachment_names: string }>)
        .map((row) => [row.subject, row.from_address, row.body_markdown, row.attachment_names]),
      catch: (cause) => new DatabaseError({ message: "Failed to load search text.", operation: "getThreadSearchDocuments", cause }),
    }),
  listMessagesWithoutAttachmentInfo: (threadId) =>
    Effect.try({
      try: () => (database.prepare("SELECT id FROM messages WHERE thread_id = ? AND attachments_json IS NULL ORDER BY date_ts, id")
        .all(threadId) as Array<{ id: string }>).map((row) => row.id),
      catch: (cause) => new DatabaseError({ message: "Failed to list messages.", operation: "listMessagesWithoutAttachmentInfo", cause }),
    }),
  applyThreadsLabelChange: (ids, add, remove) =>
    Effect.try({
      try: () => database.transaction(() => {
        const selectThread = database.prepare("SELECT labels_json FROM threads WHERE id = ?");
        const selectMessages = database.prepare("SELECT id, labels_json FROM messages WHERE thread_id = ?");
        const updateMessage = database.prepare("UPDATE messages SET labels_json = ? WHERE id = ?");
        for (const id of ids) {
          const thread = selectThread.get(id) as { labels_json: string } | null;
          if (!thread) continue;
          for (const message of selectMessages.all(id) as Array<{ id: string; labels_json: string }>) {
            updateMessage.run(JSON.stringify(applyLabelChange(JSON.parse(message.labels_json) as string[], add, remove)), message.id);
          }
          writeThreadLabels(database, id, applyLabelChange(JSON.parse(thread.labels_json) as string[], add, remove));
        }
      })(),
      catch: (cause) => new DatabaseError({ message: "Failed to update thread labels.", operation: "applyThreadsLabelChange", cause }),
    }),
  listMessageIds: (threadIds, withLabel) =>
    Effect.try({
      try: () => {
        const select = database.prepare("SELECT id, labels_json FROM messages WHERE thread_id = ? ORDER BY date_ts, id");
        return threadIds.flatMap((threadId) => (select.all(threadId) as Array<{ id: string; labels_json: string }>)
          .filter((row) => withLabel === undefined || (JSON.parse(row.labels_json) as string[]).includes(withLabel))
          .map((row) => row.id));
      },
      catch: (cause) => new DatabaseError({ message: "Failed to list messages.", operation: "listMessageIds", cause }),
    }),
  listThreadIds: (filter) =>
    Effect.try({
      try: () => (database.prepare(`SELECT threads.id FROM threads WHERE ${filter.sql} ORDER BY last_message_at DESC, id`)
        .all(...filter.params) as Array<{ id: string }>).map((row) => row.id),
      catch: (cause) => new DatabaseError({ message: "Failed to list threads.", operation: "listThreadIds", cause }),
    }),
  removeLabelEverywhere: (name) =>
    Effect.try({
      try: () => database.transaction(() => {
        const without = (json: string) => JSON.stringify((JSON.parse(json) as string[]).filter((label) => label !== name));
        const threads = database.prepare("SELECT id, labels_json, ghost_labels_json FROM threads").all() as Array<Pick<ThreadRow, "id" | "labels_json" | "ghost_labels_json">>;
        const updateGhosts = database.prepare("UPDATE threads SET ghost_labels_json = ? WHERE id = ?");
        for (const row of threads) {
          if ((JSON.parse(row.labels_json) as string[]).includes(name)) writeThreadLabels(database, row.id, JSON.parse(without(row.labels_json)) as string[]);
          if ((JSON.parse(row.ghost_labels_json) as string[]).includes(name)) updateGhosts.run(without(row.ghost_labels_json), row.id);
        }
        const messages = database.prepare("SELECT id, labels_json FROM messages").all() as Array<{ id: string; labels_json: string }>;
        const updateMessage = database.prepare("UPDATE messages SET labels_json = ? WHERE id = ?");
        for (const row of messages) {
          if ((JSON.parse(row.labels_json) as string[]).includes(name)) updateMessage.run(without(row.labels_json), row.id);
        }
        database.prepare("DELETE FROM labels WHERE name = ?").run(name);
      })(),
      catch: (cause) => new DatabaseError({ message: "Failed to remove label.", operation: "removeLabelEverywhere", cause }),
    }),
  deleteMessage: (id) =>
    Effect.try({
      try: () => {
        database.transaction(() => {
          const row = database.prepare("SELECT thread_id FROM messages WHERE id = ?").get(id) as { thread_id: string } | null;
          database.prepare("DELETE FROM messages WHERE id = ?").run(id);
          if (row) {
            reindexThreadText(database, row.thread_id);
            // Gmail has no empty threads, so drop the thread (and its cascaded rows) with its last message.
            database.prepare(`
              DELETE FROM threads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ?)
            `).run(row.thread_id, row.thread_id);
          }
        })();
      },
      catch: (cause) => new DatabaseError({ message: "Failed to delete message.", operation: "deleteMessage", cause }),
    }).pipe(Effect.asVoid),
  replaceLabels: (labels) =>
    Effect.try({
      try: () => {
        // Saved views and AI rules are written by the user with names, so only real renames apply to them.
        const userRenames = new Map<string, string>();
        database.transaction(() => {
          const previousNames = new Map((database.prepare("SELECT id, name FROM labels").all() as Array<{ id: string; name: string }>)
            .map((row) => [row.id, row.name]));
          // Threads store label names. Map renamed labels, and (once) the label IDs written by earlier importers.
          const legacyIdsPending = !database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(LABEL_NAMES_MIGRATION_ID);
          const renames = new Map<string, string>();
          for (const label of labels) {
            const previousName = previousNames.get(label.id);
            if (previousName !== undefined && previousName !== label.name) {
              renames.set(previousName, label.name);
              userRenames.set(previousName.toLowerCase(), label.name);
            }
            if (legacyIdsPending && label.id !== label.name) renames.set(label.id, label.name);
          }
          database.prepare("DELETE FROM labels").run();
          const insert = database.prepare("INSERT INTO labels (id, name, type, color_bg, color_text) VALUES (?, ?, ?, ?, ?)");
          for (const label of labels) insert.run(label.id, label.name, label.type, label.colorBg, label.colorText);
          if (renames.size > 0) {
            const rename = (json: string): string => JSON.stringify([...new Set((JSON.parse(json) as string[]).map((label) => renames.get(label) ?? label))]);
            const update = database.prepare("UPDATE threads SET labels_json = ?, ghost_labels_json = ? WHERE id = ?");
            const rows = database.prepare("SELECT id, labels_json, ghost_labels_json FROM threads").all() as Array<Pick<ThreadRow, "id" | "labels_json" | "ghost_labels_json">>;
            for (const row of rows) {
              const labelsJson = rename(row.labels_json);
              const ghostLabelsJson = rename(row.ghost_labels_json);
              if (labelsJson !== row.labels_json || ghostLabelsJson !== row.ghost_labels_json) update.run(labelsJson, ghostLabelsJson, row.id);
            }
          }
          if (userRenames.size > 0) {
            const views = database.prepare("SELECT id, filter_ast_json FROM saved_views").all() as Array<{ id: string; filter_ast_json: string }>;
            const updateView = database.prepare("UPDATE saved_views SET filter_ast_json = ?, dsl_string = ? WHERE id = ?");
            for (const view of views) {
              const renamed = renameFilterLabels(JSON.parse(view.filter_ast_json) as FilterExpr, userRenames);
              const renamedJson = JSON.stringify(renamed);
              if (renamedJson !== view.filter_ast_json) updateView.run(renamedJson, formatFilterExpr(renamed), view.id);
            }
          }
          if (legacyIdsPending) database.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)").run(LABEL_NAMES_MIGRATION_ID);
        })();
        if (userRenames.size > 0) {
          const rulesText = rulesStore.read();
          const renamed = rulesText === null ? null : renameLabelsInRulesFile(rulesText, userRenames);
          if (renamed !== null) rulesStore.write(renamed);
        }
      },
      catch: (cause) => new DatabaseError({ message: "Failed to replace Gmail labels.", operation: "replaceLabels", cause }),
    }).pipe(Effect.asVoid),
  upsertLabel: (label) =>
    Effect.try({
      try: () => database.prepare(`
        INSERT INTO labels (id, name, type, color_bg, color_text) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, type = excluded.type, color_bg = excluded.color_bg, color_text = excluded.color_text
      `).run(label.id, label.name, label.type, label.colorBg, label.colorText),
      catch: (cause) => new DatabaseError({ message: "Failed to save Gmail label.", operation: "upsertLabel", cause }),
    }).pipe(Effect.asVoid),
  listLabels: () =>
    Effect.try({
      try: () => database.prepare(`
        SELECT id, name, type, color_bg AS colorBg, color_text AS colorText
        FROM labels ORDER BY type DESC, name
      `).all() as LabelRecord[],
      catch: (cause) => new DatabaseError({ message: "Failed to load Gmail labels.", operation: "listLabels", cause }),
    }),
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
  getAiThreadContext: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
        if (!row) return null;
        const messages = (database.prepare(`
          SELECT id, from_address, to_addresses_json, cc_addresses_json, delivered_to, date_ts,
            body_markdown, raw_headers_json, labels_json
          FROM messages WHERE thread_id = ? ORDER BY date_ts ASC, id ASC
        `).all(id) as Array<{
          id: string; from_address: string; to_addresses_json: string; cc_addresses_json: string; delivered_to: string | null;
          date_ts: number; body_markdown: string; raw_headers_json: string; labels_json: string;
        }>).map((message) => {
          const headers = JSON.parse(message.raw_headers_json) as Record<string, string>;
          return {
            id: message.id,
            fromAddress: message.from_address,
            toAddresses: JSON.parse(message.to_addresses_json) as string[],
            ccAddresses: JSON.parse(message.cc_addresses_json) as string[],
            deliveredTo: message.delivered_to,
            dateTs: message.date_ts,
            subject: headers.subject ?? row.subject,
            bodyMarkdown: message.body_markdown,
            labels: JSON.parse(message.labels_json) as string[],
            listUnsubscribe: Boolean(headers["list-unsubscribe"]),
          };
        });
        return { thread: toThreadSummary(row), aiEvaluatedThrough: row.ai_evaluated_through, messages };
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load AI thread context.", operation: "getAiThreadContext", cause }),
    }),
  getMessageHeaders: (messageId) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT raw_headers_json FROM messages WHERE id = ?").get(messageId) as { raw_headers_json: string } | null;
        return row ? JSON.parse(row.raw_headers_json) as Record<string, string> : null;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load message headers.", operation: "getMessageHeaders", cause }),
    }),
  setGhostLabels: (id, ghostLabels) =>
    Effect.try({
      try: () => database.prepare("UPDATE threads SET ghost_labels_json = ? WHERE id = ?").run(JSON.stringify(ghostLabels), id),
      catch: (cause) => new DatabaseError({ message: "Failed to update ghost labels.", operation: "setGhostLabels", cause }),
    }).pipe(Effect.asVoid),
  markAiEvaluated: (id, update) =>
    Effect.try({
      try: () => database.prepare(`
        UPDATE threads SET ai_status = ?, ai_evaluated_through = COALESCE(?, ai_evaluated_through) WHERE id = ?
      `).run(update.status, update.through, id),
      catch: (cause) => new DatabaseError({ message: "Failed to record AI evaluation.", operation: "markAiEvaluated", cause }),
    }).pipe(Effect.asVoid),
  insertAiAudit: (audit) =>
    Effect.try({
      try: () => database.prepare(`
        INSERT INTO ai_audit_logs (
          id, thread_id, trigger, rule_names_json, conversation_status, endpoint_id, api_mode_used, model_used,
          reasoning, actions_applied_json, undoable, reverted, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        audit.id, audit.threadId, audit.trigger, JSON.stringify(audit.ruleNames), audit.conversationStatus,
        audit.endpointId, audit.apiModeUsed, audit.modelUsed, audit.reasoning, JSON.stringify(audit.changes),
        Number(audit.changes.labelsAdded.length + audit.changes.labelsRemoved.length + audit.changes.ghostLabelsAdded.length > 0),
        Number(audit.reverted), audit.latencyMs, audit.createdAt,
      ),
      catch: (cause) => new DatabaseError({ message: "Failed to write AI audit log.", operation: "insertAiAudit", cause }),
    }).pipe(Effect.asVoid),
  listAiAudits: (threadId) =>
    Effect.try({
      try: () => (database.prepare("SELECT * FROM ai_audit_logs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(threadId) as AuditRow[]).map(toAuditRecord),
      catch: (cause) => new DatabaseError({ message: "Failed to load AI audit logs.", operation: "listAiAudits", cause }),
    }),
  appliedRuleNames: (threadId) =>
    Effect.try({
      try: () => new Set((database.prepare("SELECT rule_names_json FROM ai_audit_logs WHERE thread_id = ? AND reverted = 0")
        .all(threadId) as Array<{ rule_names_json: string }>).flatMap((row) => JSON.parse(row.rule_names_json) as string[])),
      catch: (cause) => new DatabaseError({ message: "Failed to load applied AI rules.", operation: "appliedRuleNames", cause }),
    }),
  getLatestUndoableAiAudit: () =>
    Effect.try({
      try: () => {
        const row = database.prepare(`
          SELECT * FROM ai_audit_logs WHERE reverted = 0 AND undoable = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get() as AuditRow | null;
        return row ? toAuditRecord(row) : null;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load undoable AI audit log.", operation: "getLatestUndoableAiAudit", cause }),
    }),
  markAiAuditReverted: (id) =>
    Effect.try({
      try: () => database.prepare("UPDATE ai_audit_logs SET reverted = 1 WHERE id = ? AND reverted = 0").run(id),
      catch: (cause) => new DatabaseError({ message: "Failed to mark AI audit log as reverted.", operation: "markAiAuditReverted", cause }),
    }).pipe(Effect.asVoid),
  readRulesFile: () =>
    Effect.try({
      try: () => rulesStore.read(),
      catch: (cause) => new DatabaseError({ message: "Failed to read the AI rules file.", operation: "readRulesFile", cause }),
    }),
  writeRulesFile: (text) =>
    Effect.try({
      try: () => rulesStore.write(text),
      catch: (cause) => new DatabaseError({ message: "Failed to write the AI rules file.", operation: "writeRulesFile", cause }),
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
      return makeService(accountId, database, fileRulesStore(join(dataDirectory, `${accountId}.rules.json`)));
    }),
  );

/** Test layer accepts its own in-memory handle so tests never touch disk (rules live in memory per handle). */
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
      return makeService(accountId, database, memoryRulesStore(database));
    }),
  );
