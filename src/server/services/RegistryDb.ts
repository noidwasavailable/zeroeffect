import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { DatabaseError } from "../../shared/errors";
import type { AccountRecord, LlmEndpointRecord } from "../../shared/schemas";

export interface RegistryDbService {
  readonly upsertAccount: (account: AccountRecord) => Effect.Effect<void, DatabaseError>;
  readonly getAccount: (id: string) => Effect.Effect<AccountRecord | null, DatabaseError>;
  readonly listAccounts: () => Effect.Effect<ReadonlyArray<Pick<AccountRecord, "id" | "email" | "displayName" | "colorTheme">>, DatabaseError>;
  readonly upsertServiceCredential: (id: string, credentialsEnc: Uint8Array) => Effect.Effect<void, DatabaseError>;
  readonly getServiceCredential: (id: string) => Effect.Effect<Uint8Array | null, DatabaseError>;
  readonly deleteServiceCredential: (id: string) => Effect.Effect<void, DatabaseError>;
  readonly upsertLlmEndpoint: (endpoint: LlmEndpointRecord) => Effect.Effect<void, DatabaseError>;
}

export class RegistryDb extends Context.Service<RegistryDb, RegistryDbService>()(
  "zeroeffect/RegistryDb",
) {}

const initialize = (database: Database): void => {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      color_theme TEXT NOT NULL,
      oauth_tokens_enc BLOB NOT NULL,
      pubsub_topic TEXT,
      watch_expiration_ts INTEGER,
      last_history_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_credentials (
      id TEXT PRIMARY KEY,
      credentials_enc BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_enc BLOB NOT NULL,
      model_id TEXT NOT NULL,
      api_mode TEXT NOT NULL CHECK (api_mode IN ('responses', 'chat_completions')),
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      max_concurrency INTEGER NOT NULL DEFAULT 3
    );
  `);
};

const makeService = (database: Database): RegistryDbService => ({
  upsertAccount: (account) =>
    Effect.try({
      try: () => {
        database.prepare(`
          INSERT INTO accounts (
            id, email, display_name, color_theme, oauth_tokens_enc, pubsub_topic,
            watch_expiration_ts, last_history_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            display_name = excluded.display_name,
            color_theme = excluded.color_theme,
            oauth_tokens_enc = excluded.oauth_tokens_enc,
            pubsub_topic = excluded.pubsub_topic,
            watch_expiration_ts = excluded.watch_expiration_ts,
            last_history_id = excluded.last_history_id
        `).run(
          account.id,
          account.email,
          account.displayName,
          account.colorTheme,
          account.oauthTokensEnc,
          account.pubsubTopic ?? null,
          account.watchExpirationTs ?? null,
          account.lastHistoryId ?? null,
          account.createdAt,
        );
      },
      catch: (cause) => new DatabaseError({ message: "Failed to save registry account.", operation: "upsertAccount", cause }),
    }).pipe(Effect.asVoid),
  getAccount: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare(`
          SELECT id, email, display_name AS displayName, color_theme AS colorTheme,
            oauth_tokens_enc AS oauthTokensEnc, pubsub_topic AS pubsubTopic,
            watch_expiration_ts AS watchExpirationTs, last_history_id AS lastHistoryId,
            created_at AS createdAt
          FROM accounts WHERE id = ?
        `).get(id) as (AccountRecord & { oauthTokensEnc: Uint8Array }) | null;
        return row;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load registry account.", operation: "getAccount", cause }),
    }),
  listAccounts: () =>
    Effect.try({
      try: () => database.prepare(`
        SELECT id, email, display_name AS displayName, color_theme AS colorTheme
        FROM accounts ORDER BY id
      `).all() as Array<Pick<AccountRecord, "id" | "email" | "displayName" | "colorTheme">>,
      catch: (cause) => new DatabaseError({ message: "Failed to list registry accounts.", operation: "listAccounts", cause }),
    }),
  upsertServiceCredential: (id, credentialsEnc) =>
    Effect.try({
      try: () => {
        database.prepare(`
          INSERT INTO service_credentials (id, credentials_enc, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET credentials_enc = excluded.credentials_enc, updated_at = excluded.updated_at
        `).run(id, credentialsEnc, Date.now());
      },
      catch: (cause) => new DatabaseError({ message: "Failed to save registry service credential.", operation: "upsertServiceCredential", cause }),
    }).pipe(Effect.asVoid),
  getServiceCredential: (id) =>
    Effect.try({
      try: () => {
        const row = database.prepare("SELECT credentials_enc AS credentialsEnc FROM service_credentials WHERE id = ?")
          .get(id) as { credentialsEnc: Uint8Array } | null;
        return row?.credentialsEnc ?? null;
      },
      catch: (cause) => new DatabaseError({ message: "Failed to load registry service credential.", operation: "getServiceCredential", cause }),
    }),
  deleteServiceCredential: (id) =>
    Effect.try({
      try: () => { database.prepare("DELETE FROM service_credentials WHERE id = ?").run(id); },
      catch: (cause) => new DatabaseError({ message: "Failed to delete registry service credential.", operation: "deleteServiceCredential", cause }),
    }).pipe(Effect.asVoid),
  upsertLlmEndpoint: (endpoint) =>
    Effect.try({
      try: () => {
        database.prepare(`
          INSERT INTO llm_endpoints (
            id, name, base_url, api_key_enc, model_id, api_mode, timeout_ms, max_concurrency
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            base_url = excluded.base_url,
            api_key_enc = excluded.api_key_enc,
            model_id = excluded.model_id,
            api_mode = excluded.api_mode,
            timeout_ms = excluded.timeout_ms,
            max_concurrency = excluded.max_concurrency
        `).run(
          endpoint.id,
          endpoint.name,
          endpoint.baseUrl,
          endpoint.apiKeyEnc,
          endpoint.modelId,
          endpoint.apiMode,
          endpoint.timeoutMs ?? 30_000,
          endpoint.maxConcurrency ?? 3,
        );
      },
      catch: (cause) => new DatabaseError({ message: "Failed to save LLM endpoint.", operation: "upsertLlmEndpoint", cause }),
    }).pipe(Effect.asVoid),
});

export const RegistryDbLive = (path = "./data/registry.sqlite"): Layer.Layer<RegistryDb, DatabaseError> =>
  Layer.effect(
    RegistryDb,
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(path), { recursive: true }),
        catch: (cause) => new DatabaseError({ message: "Failed to create registry database directory.", operation: "mkdirRegistry", cause }),
      });
      const database = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Database(path),
          catch: (cause) => new DatabaseError({ message: "Failed to open registry database.", operation: "openRegistryDatabase", cause }),
        }),
        (db) => Effect.sync(() => db.close()),
      );
      yield* Effect.try({
        try: () => initialize(database),
        catch: (cause) => new DatabaseError({ message: "Failed to initialize registry database.", operation: "initializeRegistryDatabase", cause }),
      });
      return makeService(database);
    }),
  );

export const RegistryDbTest = (database: Database): Layer.Layer<RegistryDb, DatabaseError> =>
  Layer.effect(
    RegistryDb,
    Effect.try({
      try: () => {
        initialize(database);
        return makeService(database);
      },
      catch: (cause) => new DatabaseError({ message: "Failed to initialize test registry database.", operation: "initializeTestRegistryDatabase", cause }),
    }),
  );
