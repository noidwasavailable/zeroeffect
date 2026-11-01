import { Effect, Layer, ManagedRuntime } from "effect";
import type { RegistryDbService } from "./RegistryDb";
import type { GoogleOAuth2Api } from "./GoogleOAuth2";
import { createGmailAccessTokenProvider, type GmailAccessTokenProvider } from "./GmailAccessTokens";
import { AccountDbLive } from "./AccountDb";
import { GmailClient, GmailClientLive } from "./GmailClient";
import { GmailSyncService, GmailSyncServiceLive, type GmailSyncOptions } from "./GmailSyncService";
import { OAuthTokenVault } from "./OAuthTokenVault";

export type GmailAccountId = "personal" | "work";

export interface GmailAccountSyncResult {
  readonly mode: "initial" | "incremental";
  readonly messagesUpserted: number;
  readonly messagesDeleted: number;
  readonly threadsWithNewMessages?: ReadonlyArray<string>;
  /** The stored history cursor already covered the triggering notification; nothing was fetched. */
  readonly skipped?: boolean;
}

export interface GmailAccountSyncOptions {
  /** Skip the sync when the account's stored history cursor has already reached this Pub/Sub historyId. */
  readonly skipIfCursorAtLeast?: string;
}

/** Send As aliases rarely change, so notification-driven syncs refresh them at most this often. */
const ALIAS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface GmailAccountOperationsConfig {
  readonly registry: RegistryDbService;
  readonly oauth: GoogleOAuth2Api;
  readonly vault: OAuthTokenVault;
  readonly accountDataDirectory?: string;
  readonly gmailApiBaseUrl?: string;
  /** Optional sync executor for deterministic service tests. Production uses the scoped GmailSyncService. */
  /** Shared with the HTTP API so both refresh tokens through one place. */
  readonly tokens?: GmailAccessTokenProvider;
  /** Called after each successful account sync (e.g. to notify connected web clients). */
  readonly onSynced?: (accountId: GmailAccountId, result: GmailAccountSyncResult) => void;
  readonly syncAccount?: (accountId: GmailAccountId, accessToken: string, options: GmailSyncOptions) => Promise<GmailAccountSyncResult>;
}

export interface GmailAccountOperations {
  readonly sync: (accountId: GmailAccountId, options?: GmailAccountSyncOptions) => Promise<GmailAccountSyncResult>;
  readonly ensureWatch: (accountId: GmailAccountId, topicName: string) => Promise<void>;
  readonly renewWatches: (topicName: string) => Promise<void>;
  readonly processNotification: (data: string) => Promise<"synced" | "ignored">;
}

/** Centralizes account-scoped Gmail sync and watch operations for HTTP and background workers. */
export const createGmailAccountOperations = (config: GmailAccountOperationsConfig): GmailAccountOperations => {
  const inFlightSyncs = new Map<GmailAccountId, Promise<GmailAccountSyncResult>>();

  const tokens = config.tokens ?? createGmailAccessTokenProvider(config);
  const getUsableAccessToken = tokens.get;
  const lastAliasSync = new Map<GmailAccountId, number>();

  const runSync = async (accountId: GmailAccountId, accessToken: string, options: GmailSyncOptions): Promise<GmailAccountSyncResult> => {
    if (config.syncAccount) return await config.syncAccount(accountId, accessToken, options);
    const dependencies = Layer.merge(
      AccountDbLive(accountId, config.accountDataDirectory),
      GmailClientLive({ accessToken, apiBaseUrl: config.gmailApiBaseUrl }),
    );
    const runtime = ManagedRuntime.make(Layer.provide(GmailSyncServiceLive, dependencies));
    try {
      const service = await runtime.runPromise(Effect.gen(function* () { return yield* GmailSyncService; }));
      return await runtime.runPromise(service.sync(options));
    } finally {
      await runtime.dispose();
    }
  };

  const startSync = (accountId: GmailAccountId, options: GmailAccountSyncOptions): Promise<GmailAccountSyncResult> => {
    const task = (async () => {
      const includeAliases = (Date.now() - (lastAliasSync.get(accountId) ?? 0)) >= ALIAS_REFRESH_INTERVAL_MS;
      const syncOptions: GmailSyncOptions = { includeAliases, skipIfCursorAtLeast: options.skipIfCursorAtLeast };
      const { accessToken } = await getUsableAccessToken(accountId);
      let result: GmailAccountSyncResult;
      try {
        result = await runSync(accountId, accessToken, syncOptions);
      } catch (error) {
        // A token Google revoked before its stated expiry: refresh once and retry.
        if (!isUnauthorized(error) || !tokens.refresh) throw error;
        result = await runSync(accountId, (await tokens.refresh(accountId)).accessToken, syncOptions);
      }
      if (includeAliases && !result.skipped) lastAliasSync.set(accountId, Date.now());
      return result;
    })().then((result) => {
      if (!result.skipped) config.onSynced?.(accountId, result);
      return result;
    });
    inFlightSyncs.set(accountId, task);
    void task.finally(() => {
      if (inFlightSyncs.get(accountId) === task) inFlightSyncs.delete(accountId);
    }).catch(() => undefined);
    return task;
  };

  const sync = async (accountId: GmailAccountId, options: GmailAccountSyncOptions = {}): Promise<GmailAccountSyncResult> => {
    const active = inFlightSyncs.get(accountId);
    if (active) {
      // Manual syncs share the running one. A notification may describe a change the running sync
      // has already passed, so wait for it and then sync again (skipped if its cursor covered the change).
      if (options.skipIfCursorAtLeast === undefined) return active;
      await active.catch(() => undefined);
      return sync(accountId, options);
    }
    return startSync(accountId, options);
  };

  const ensureWatch = async (accountId: GmailAccountId, topicName: string): Promise<void> => {
    const { account, accessToken } = await getUsableAccessToken(accountId);
    const expirationTs = Number(account.watchExpirationTs ?? 0);
    if (account.pubsubTopic === topicName && expirationTs > Date.now() + 24 * 60 * 60 * 1000) return;
    const gmailLayer = GmailClientLive({ accessToken, apiBaseUrl: config.gmailApiBaseUrl });
    const gmail = Effect.runSync(Effect.gen(function* () { return yield* GmailClient; }).pipe(Effect.provide(gmailLayer)));
    const watch = await Effect.runPromise(gmail.watch(topicName));
    const expiration = Number(watch.expiration);
    if (!Number.isSafeInteger(expiration) || expiration <= Date.now()) {
      throw new Error(`Gmail returned an invalid watch expiration for ${accountId}.`);
    }
    await Effect.runPromise(config.registry.upsertAccount({
      ...account,
      pubsubTopic: topicName,
      watchExpirationTs: expiration,
    }));
    console.info(`Gmail Pub/Sub watch active for ${accountId} until ${new Date(expiration).toISOString()}.`);
  };

  const renewWatches = async (topicName: string): Promise<void> => {
    const accounts = await Effect.runPromise(config.registry.listAccounts());
    for (const account of accounts) {
      if (account.id !== "personal" && account.id !== "work") continue;
      try {
        await ensureWatch(account.id, topicName);
      } catch (error) {
        console.error(`Could not establish or renew the Gmail watch for ${account.id}.`, error);
      }
    }
  };

  const processNotification = async (data: string): Promise<"synced" | "ignored"> => {
    let notification: { emailAddress?: unknown; historyId?: unknown };
    try {
      notification = JSON.parse(data) as typeof notification;
    } catch {
      console.warn("Discarding malformed Gmail Pub/Sub notification JSON.");
      return "ignored";
    }
    if (typeof notification !== "object" || notification === null) {
      console.warn("Discarding Gmail Pub/Sub notification without an emailAddress and historyId.");
      return "ignored";
    }
    // Gmail documents historyId as a string, but some Pub/Sub payloads encode it as a JSON number.
    // Sync reads the authoritative cursor from this account's DB and skips notifications it already covers.
    const hasHistoryId = typeof notification.historyId === "string"
      ? notification.historyId.trim().length > 0
      : typeof notification.historyId === "number" &&
        Number.isFinite(notification.historyId) && Number.isInteger(notification.historyId) && notification.historyId > 0;
    if (
      typeof notification.emailAddress !== "string" || notification.emailAddress.trim().length === 0 ||
      !hasHistoryId
    ) {
      console.warn("Discarding Gmail Pub/Sub notification without an emailAddress and historyId.");
      return "ignored";
    }
    const accounts = await Effect.runPromise(config.registry.listAccounts());
    const normalizedEmail = notification.emailAddress.trim().toLowerCase();
    const matching = accounts.find((account) => account.email.trim().toLowerCase() === normalizedEmail);
    if (!matching || (matching.id !== "personal" && matching.id !== "work")) {
      console.warn(`Ignoring Gmail Pub/Sub notification for an unbound account (${notification.emailAddress}).`);
      return "ignored";
    }
    const result = await sync(matching.id, { skipIfCursorAtLeast: String(notification.historyId).trim() });
    return result.skipped ? "ignored" : "synced";
  };

  return { sync, ensureWatch, renewWatches, processNotification };
};

const isUnauthorized = (error: unknown): boolean =>
  typeof error === "object" && error !== null &&
  (error as { _tag?: unknown })._tag === "GmailApiError" && (error as { status?: unknown }).status === 401;
