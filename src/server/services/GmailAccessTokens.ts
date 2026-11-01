import { Effect } from "effect";
import { GmailApiError } from "../../shared/errors";
import type { AccountRecord } from "../../shared/schemas";
import type { GoogleOAuth2Api, GoogleOAuthTokens } from "./GoogleOAuth2";
import type { OAuthTokenVault } from "./OAuthTokenVault";
import type { RegistryDbService } from "./RegistryDb";

export interface StoredTokens {
  readonly tokens: GoogleOAuthTokens;
  readonly expiresAt: number;
}

export interface GmailAccessTokenProvider {
  /** Returns a Gmail access token valid for at least a minute, refreshing (and persisting) it when needed. */
  readonly get: (accountId: string) => Promise<{ readonly account: AccountRecord; readonly accessToken: string }>;
  /** Refreshes the access token even if it looks unexpired (Gmail answered 401 for it). */
  readonly refresh?: (accountId: string) => Promise<{ readonly account: AccountRecord; readonly accessToken: string }>;
}

export const createGmailAccessTokenProvider = (config: {
  readonly registry: RegistryDbService;
  readonly oauth: GoogleOAuth2Api;
  readonly vault: OAuthTokenVault;
}): GmailAccessTokenProvider => {
  // Concurrent requests for one account share a refresh instead of racing to rotate its tokens.
  const inFlight = new Map<string, Promise<{ account: AccountRecord; accessToken: string }>>();

  const load = async (accountId: string, force = false) => {
    const account = await Effect.runPromise(config.registry.getAccount(accountId));
    if (!account) throw new Error(`${accountId} Gmail account is not connected.`);
    let stored: StoredTokens;
    try {
      stored = config.vault.decrypt<StoredTokens>(account.oauthTokensEnc);
    } catch {
      throw new Error(`Could not decrypt ${accountId} account tokens. Check OAUTH_ENCRYPTION_KEY.`);
    }
    if (!force && stored.expiresAt > Date.now() + 60_000) return { account, accessToken: stored.tokens.accessToken };
    if (!stored.tokens.refreshToken) throw new Error(`${accountId} Gmail access token expired and has no refresh token; reconnect the account.`);
    const refreshed = await Effect.runPromise(config.oauth.refreshAccessToken(accountId, stored.tokens.refreshToken)).catch((error: unknown) => {
      // invalid_grant: the user revoked access, or the grant expired. OAuth apps in Google's "Testing"
      // publishing status get refresh tokens that expire after 7 days.
      if (error instanceof GmailApiError && error.status === 400 && error.message.includes("invalid_grant")) {
        throw new GmailApiError({
          message: `Google no longer accepts the ${accountId} account's authorization (invalid_grant). Reconnect it from /setup. ` +
            `If the OAuth consent screen is in "Testing" mode, Google expires its grants after 7 days; publish the app to avoid this.`,
          status: 401,
          retryable: false,
          reason: "invalid_grant",
        });
      }
      throw error;
    });
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

  const run = (accountId: string, force: boolean) => {
    const active = inFlight.get(accountId);
    if (active) return active;
    const task = load(accountId, force).finally(() => inFlight.delete(accountId));
    inFlight.set(accountId, task);
    return task;
  };

  return {
    get: (accountId) => run(accountId, false),
    refresh: (accountId) => run(accountId, true),
  };
};
