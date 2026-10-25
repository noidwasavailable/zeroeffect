import { Effect, Layer, ManagedRuntime } from "effect";
import { GmailApiError } from "../../shared/errors";
import type { AccountRecord } from "../../shared/schemas";
import type { RegistryDbService } from "./RegistryDb";
import type { GoogleOAuth2Api, GoogleOAuthTokens } from "./GoogleOAuth2";
import { AccountDbLive } from "./AccountDb";
import { GmailClient, GmailClientLive } from "./GmailClient";
import { GmailSyncService, GmailSyncServiceLive } from "./GmailSyncService";
import { OAuthTokenVault } from "./OAuthTokenVault";

export type GmailAccountId = "personal" | "work";

export interface GmailAccountSyncResult {
  readonly mode: "initial" | "incremental";
  readonly messagesUpserted: number;
  readonly messagesDeleted: number;
}

export interface GmailAccountOperationsConfig {
  readonly registry: RegistryDbService;
  readonly oauth: GoogleOAuth2Api;
  readonly vault: OAuthTokenVault;
  readonly accountDataDirectory?: string;
  readonly gmailApiBaseUrl?: string;
  /** Optional sync executor for deterministic service tests. Production uses the scoped GmailSyncService. */
  readonly syncAccount?: (accountId: GmailAccountId, accessToken: string) => Promise<GmailAccountSyncResult>;
}

export interface GmailAccountOperations {
  readonly sync: (accountId: GmailAccountId) => Promise<GmailAccountSyncResult>;
  readonly ensureWatch: (accountId: GmailAccountId, topicName: string) => Promise<void>;
  readonly renewWatches: (topicName: string) => Promise<void>;
  readonly processNotification: (data: string) => Promise<"synced" | "ignored">;
}

interface StoredTokens {
  readonly tokens: GoogleOAuthTokens;
  readonly expiresAt: number;
}

/** Centralizes account-scoped Gmail sync and watch operations for HTTP and background workers. */
export const createGmailAccountOperations = (config: GmailAccountOperationsConfig): GmailAccountOperations => {
  const inFlightSyncs = new Map<GmailAccountId, Promise<GmailAccountSyncResult>>();

  const getUsableAccessToken = async (accountId: GmailAccountId): Promise<{ account: AccountRecord; accessToken: string }> => {
    const account = await Effect.runPromise(config.registry.getAccount(accountId));
    if (!account) throw new Error(`${accountId} Gmail account is not connected.`);
    let stored: StoredTokens;
    try {
      stored = config.vault.decrypt<StoredTokens>(account.oauthTokensEnc);
    } catch {
      throw new Error(`Could not decrypt ${accountId} account tokens. Check OAUTH_ENCRYPTION_KEY.`);
    }
    if (stored.expiresAt > Date.now() + 60_000) return { account, accessToken: stored.tokens.accessToken };
    if (!stored.tokens.refreshToken) throw new Error(`${accountId} Gmail access token expired and has no refresh token; reconnect the account.`);
    const refreshed = await Effect.runPromise(config.oauth.refreshAccessToken(accountId, stored.tokens.refreshToken));
    const tokens: GoogleOAuthTokens = {
      ...refreshed.tokens,
      refreshToken: refreshed.tokens.refreshToken ?? stored.tokens.refreshToken,
    };
    const refreshedAccount: AccountRecord = {
      ...account,
      oauthTokensEnc: config.vault.encrypt({
        tokens,
        expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      } satisfies StoredTokens),
    };
    await Effect.runPromise(config.registry.upsertAccount(refreshedAccount));
    return { account: refreshedAccount, accessToken: tokens.accessToken };
  };

  const sync = (accountId: GmailAccountId): Promise<GmailAccountSyncResult> => {
    const active = inFlightSyncs.get(accountId);
    if (active) return active;
    const task = (async () => {
      const { accessToken } = await getUsableAccessToken(accountId);
      if (config.syncAccount) return await config.syncAccount(accountId, accessToken);
      const dependencies = Layer.merge(
        AccountDbLive(accountId, config.accountDataDirectory),
        GmailClientLive({ accessToken, apiBaseUrl: config.gmailApiBaseUrl }),
      );
      const runtime = ManagedRuntime.make(Layer.provide(GmailSyncServiceLive, dependencies));
      try {
        const service = await runtime.runPromise(Effect.gen(function* () { return yield* GmailSyncService; }));
        return await runtime.runPromise(service.sync());
      } finally {
        await runtime.dispose();
      }
    })();
    inFlightSyncs.set(accountId, task);
    void task.finally(() => {
      if (inFlightSyncs.get(accountId) === task) inFlightSyncs.delete(accountId);
    }).catch(() => undefined);
    return task;
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
    if (
      typeof notification !== "object" || notification === null ||
      typeof notification.emailAddress !== "string" || notification.emailAddress.trim().length === 0 ||
      typeof notification.historyId !== "string" || notification.historyId.trim().length === 0
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
    await sync(matching.id);
    return "synced";
  };

  return { sync, ensureWatch, renewWatches, processNotification };
};
