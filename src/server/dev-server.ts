import { Effect, Layer, ManagedRuntime } from "effect";
import type { RegistryDbService } from "./services/RegistryDb";
import { AccountDbLive } from "./services/AccountDb";
import { GmailClient, GmailClientLive } from "./services/GmailClient";
import { GmailSyncService, GmailSyncServiceLive } from "./services/GmailSyncService";
import type { GoogleOAuth2Api, GoogleOAuthTokens } from "./services/GoogleOAuth2";
import { OAuthTokenVault } from "./services/OAuthTokenVault";
import { renderAccountBindingPage } from "../client/auth-page";
import { GmailApiError } from "../shared/errors";

const ACCOUNT_IDS = ["personal", "work"] as const;
type AccountId = (typeof ACCOUNT_IDS)[number];
const DEFAULT_INITIAL_CONVERSATION_LIMIT = 100;
const MAX_INITIAL_CONVERSATION_LIMIT = 10_000;

type SyncJobProgress = {
  readonly stage: "queued" | "preparing" | "listing_conversations" | "importing_conversations" | "completed";
  readonly conversationsCompleted: number;
  readonly conversationsTotal: number;
  readonly messagesUpserted: number;
};

type SyncJob = {
  readonly id: string;
  readonly accountId: AccountId;
  readonly initialConversationLimit: number;
  readonly createdAt: number;
  status: "queued" | "running" | "completed" | "failed";
  updatedAt: number;
  progress: SyncJobProgress;
  result?: { readonly mode: "initial" | "incremental"; readonly messagesUpserted: number; readonly messagesDeleted: number };
  error?: string;
};

interface StoredTokens {
  readonly tokens: GoogleOAuthTokens;
  readonly expiresAt: number;
}

export interface DevServerConfig {
  readonly registry: RegistryDbService;
  readonly oauth: GoogleOAuth2Api;
  readonly encryptionKey: Uint8Array;
  readonly redirectUri: string;
  readonly accountDataDirectory?: string;
  readonly gmailApiBaseUrl?: string;
  readonly hostname?: string;
  readonly port?: number;
}

const json = (value: unknown, status = 200): Response => Response.json(value, {
  status,
  headers: { "Cache-Control": "no-store" },
});

const isAccountId = (value: string | null): value is AccountId =>
  value !== null && ACCOUNT_IDS.some((accountId) => accountId === value);

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const isLoopback = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";

const syncJobErrorMessage = (error: unknown, conversationsSaved: number): string => {
  const saved = `${conversationsSaved} complete conversation${conversationsSaved === 1 ? "" : "s"} saved before the failure.`;
  if (!(error instanceof GmailApiError) || error.status !== 403) {
    return `Gmail sync failed. ${saved} Check the local server logs for details.`;
  }
  if (error.reason === "userRateLimitExceeded" || error.reason === "rateLimitExceeded") {
    return `Google temporarily rate-limited this Gmail request. ${saved} Try again shortly.`;
  }
  if (error.reason === "insufficientPermissions") {
    return `Google denied the Gmail permission. Reconnect this account to refresh its authorization. ${saved}`;
  }
  if (error.reason === "accessNotConfigured") {
    return `The Gmail API is not enabled for this Google Cloud project. ${saved}`;
  }
  if (error.reason === "dailyLimitExceeded" || error.reason === "quotaExceeded") {
    return `The Gmail API quota is exhausted. Wait for the quota to reset or review the project's Gmail API quota. ${saved}`;
  }
  if (error.reason === "domainPolicy") {
    return `Your Google Workspace administrator blocks this Gmail request. ${saved}`;
  }
  const reason = error.reason ? ` (${error.reason})` : "";
  return `Google rejected a Gmail request (HTTP 403${reason}). ${saved} Check the local server logs for the affected API operation.`;
};

const runSyncJob = async (
  job: SyncJob,
  work: () => Promise<SyncJob["result"]>,
): Promise<void> => {
  job.status = "running";
  job.updatedAt = Date.now();
  job.progress = { ...job.progress, stage: "preparing" };
  try {
    const result = await work();
    job.result = result;
    job.status = "completed";
    job.progress = {
      stage: "completed",
      conversationsCompleted: result?.mode === "initial" ? job.progress.conversationsCompleted : 0,
      conversationsTotal: result?.mode === "initial" ? job.progress.conversationsCompleted : 0,
      messagesUpserted: result?.messagesUpserted ?? 0,
    };
  } catch (error) {
    job.status = "failed";
    job.error = syncJobErrorMessage(error, job.progress.conversationsCompleted);
  }
  job.updatedAt = Date.now();
};

export const createDevServer = (config: DevServerConfig): Bun.Server<unknown> => {
  const hostname = config.hostname ?? "127.0.0.1";
  if (!isLoopback(hostname)) throw new Error("The Gmail development server must bind to localhost or a loopback address.");
  const vault = OAuthTokenVault.fromKey(config.encryptionKey);
  const callbackHostname = new URL(config.redirectUri).hostname;
  const pendingStates = new Map<string, { readonly accountId: AccountId; readonly createdAt: number }>();
  const syncJobs = new Map<AccountId, SyncJob>();
  const html = renderAccountBindingPage();

  const getUsableAccessToken = async (accountId: AccountId) => {
    const account = await Effect.runPromise(config.registry.getAccount(accountId));
    if (!account) throw new Error(`${accountId} Gmail account is not connected.`);
    let stored: StoredTokens;
    try {
      stored = vault.decrypt<StoredTokens>(account.oauthTokensEnc);
    } catch {
      throw new Error(`Could not decrypt ${accountId} account tokens. Check OAUTH_ENCRYPTION_KEY.`);
    }
    if (stored.expiresAt > Date.now() + 60_000) return stored.tokens.accessToken;
    if (!stored.tokens.refreshToken) throw new Error(`${accountId} Gmail access token expired and has no refresh token; reconnect the account.`);
    const refreshed = await Effect.runPromise(config.oauth.refreshAccessToken(accountId, stored.tokens.refreshToken));
    const tokens: GoogleOAuthTokens = {
      ...refreshed.tokens,
      refreshToken: refreshed.tokens.refreshToken ?? stored.tokens.refreshToken,
    };
    await Effect.runPromise(config.registry.upsertAccount({
      ...account,
      oauthTokensEnc: vault.encrypt({
        tokens,
        expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      } satisfies StoredTokens),
    }));
    return tokens.accessToken;
  };

  return Bun.serve({
    hostname,
    port: config.port ?? 3000,
    // Initial hydration fetches Gmail messages one at a time and can exceed Bun's 10s default.
    idleTimeout: 255,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.hostname !== callbackHostname &&
        (url.pathname === "/" || url.pathname === "/auth/google/start")
      ) {
        const canonicalUrl = new URL(url);
        canonicalUrl.hostname = callbackHostname;
        return new Response(null, {
          status: 302,
          headers: { Location: canonicalUrl.toString(), "Cache-Control": "no-store" },
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/auth/google/start") {
        const accountId = url.searchParams.get("accountId");
        if (!isAccountId(accountId)) return new Response("accountId must be personal or work", { status: 400 });
        const now = Date.now();
        for (const [state, pending] of pendingStates) {
          if (pending.createdAt < now - 10 * 60_000) pendingStates.delete(state);
        }
        const state = crypto.randomUUID();
        pendingStates.set(state, { accountId, createdAt: now });
        return new Response(null, {
          status: 302,
          headers: {
            Location: config.oauth.authorizationUrl(accountId, state).toString(),
            "Set-Cookie": `ze_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=600`,
            "Cache-Control": "no-store",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/auth/google/callback") {
        const suppliedState = url.searchParams.get("state") ?? "";
        const separator = suppliedState.indexOf(":");
        const stateAccountId = suppliedState.slice(0, separator);
        const nonce = suppliedState.slice(separator + 1);
        const pending = pendingStates.get(nonce);
        const cookieNonce = request.headers.get("cookie")?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("ze_oauth_state="))
          ?.slice("ze_oauth_state=".length);
        const clearStateCookie = "ze_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=0";
        if (!isAccountId(stateAccountId) || !pending || pending.accountId !== stateAccountId || cookieNonce !== nonce) {
          return new Response("OAuth state is missing, expired, or invalid. Start account connection again.", {
            status: 400,
            headers: { "Set-Cookie": clearStateCookie, "Cache-Control": "no-store" },
          });
        }
        pendingStates.delete(nonce);
        const redirectError = (message: string): Response => new Response(null, {
          status: 303,
          headers: {
            Location: "/?error=" + encodeURIComponent(message),
            "Set-Cookie": clearStateCookie,
            "Cache-Control": "no-store",
          },
        });
        const googleError = url.searchParams.get("error");
        if (googleError) return redirectError(`Google authorization failed: ${googleError}`);
        const code = url.searchParams.get("code");
        if (!code) return redirectError("Google did not return an authorization code.");

        try {
          const { tokens } = await Effect.runPromise(config.oauth.exchangeCode(pending.accountId, code));
          const clientLayer = GmailClientLive({ accessToken: tokens.accessToken, apiBaseUrl: config.gmailApiBaseUrl });
          const gmail = Effect.runSync(Effect.gen(function* () {
            return yield* GmailClient;
          }).pipe(Effect.provide(clientLayer)));
          const profile = await Effect.runPromise(gmail.getProfile());
          const accountName = pending.accountId === "personal" ? "Personal" : "Work";
          const previousAccount = await Effect.runPromise(config.registry.getAccount(pending.accountId));
          const storedTokens: StoredTokens = {
            tokens,
            expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
          };
          await Effect.runPromise(config.registry.upsertAccount({
            id: pending.accountId,
            email: profile.emailAddress,
            displayName: accountName,
            colorTheme: pending.accountId === "personal" ? "blue" : "violet",
            oauthTokensEnc: vault.encrypt(storedTokens),
            ...(previousAccount?.pubsubTopic !== undefined ? { pubsubTopic: previousAccount.pubsubTopic } : {}),
            ...(previousAccount?.watchExpirationTs !== undefined ? { watchExpirationTs: previousAccount.watchExpirationTs } : {}),
            ...(previousAccount?.lastHistoryId !== undefined ? { lastHistoryId: previousAccount.lastHistoryId } : {}),
            createdAt: previousAccount?.createdAt ?? Date.now(),
          }));
          return new Response(null, {
            status: 303,
            headers: {
              Location: "/?connected=" + encodeURIComponent(pending.accountId),
              "Set-Cookie": clearStateCookie,
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Account binding failed.";
          return redirectError(message.slice(0, 220));
        }
      }

      if (request.method === "GET" && url.pathname === "/api/accounts") {
        try {
          return json({ accounts: await Effect.runPromise(config.registry.listAccounts()) });
        } catch {
          return json({ error: "Could not load account bindings." }, 500);
        }
      }

      const syncMatch = /^\/api\/accounts\/([^/]+)\/sync$/.exec(url.pathname);
      if (syncMatch && (request.method === "GET" || request.method === "POST")) {
        const accountId = syncMatch[1] ?? null;
        if (!isAccountId(accountId)) return json({ error: "Account id must be personal or work." }, 400);
        if (request.method === "GET") {
          const job = syncJobs.get(accountId);
          return json({ job: job ?? null });
        }
        if (request.headers.get("origin") !== url.origin || request.headers.get("x-zeroeffect-local") !== "1") {
          return json({ error: "Sync requests must come from the local account screen." }, 403);
        }
        let requestBody: unknown = {};
        try {
          const bodyText = await request.text();
          if (bodyText.trim()) requestBody = JSON.parse(bodyText);
        } catch {
          return json({ error: "Sync request must contain valid JSON." }, 400);
        }
        if (typeof requestBody !== "object" || requestBody === null || Array.isArray(requestBody)) {
          return json({ error: "Sync request must be a JSON object." }, 400);
        }
        const suppliedLimit = (requestBody as { initialConversationLimit?: unknown }).initialConversationLimit;
        const initialConversationLimit = suppliedLimit === undefined ? DEFAULT_INITIAL_CONVERSATION_LIMIT : suppliedLimit;
        if (!Number.isSafeInteger(initialConversationLimit) || (initialConversationLimit as number) < 1 || (initialConversationLimit as number) > MAX_INITIAL_CONVERSATION_LIMIT) {
          return json({ error: `Initial conversation limit must be an integer between 1 and ${MAX_INITIAL_CONVERSATION_LIMIT}.` }, 400);
        }
        const existing = syncJobs.get(accountId);
        if (existing && (existing.status === "queued" || existing.status === "running")) {
          return json({ error: "A sync is already running for this account.", job: existing }, 409);
        }
        const now = Date.now();
        const job: SyncJob = {
          id: crypto.randomUUID(),
          accountId,
          initialConversationLimit: initialConversationLimit as number,
          createdAt: now,
          updatedAt: now,
          status: "queued",
          progress: {
            stage: "queued",
            conversationsCompleted: 0,
            conversationsTotal: initialConversationLimit as number,
            messagesUpserted: 0,
          },
        };
        syncJobs.set(accountId, job);
        void runSyncJob(job, async () => {
          const accessToken = await getUsableAccessToken(accountId);
          const dependencies = Layer.merge(
            AccountDbLive(accountId, config.accountDataDirectory),
            GmailClientLive({ accessToken, apiBaseUrl: config.gmailApiBaseUrl }),
          );
          const runtime = ManagedRuntime.make(Layer.provide(GmailSyncServiceLive, dependencies));
          try {
            const service = await runtime.runPromise(Effect.gen(function* () { return yield* GmailSyncService; }));
            return await runtime.runPromise(service.sync({
              initialConversationLimit: job.initialConversationLimit,
              onProgress: (progress) => {
                job.progress = progress;
                job.updatedAt = Date.now();
              },
            }));
          } finally {
            await runtime.dispose();
          }
        });
        return json({ job }, 202);
      }

      return new Response("Not found", { status: 404 });
    },
  });
};

export const devServerConfigFromEnvironment = (): Omit<DevServerConfig, "registry" | "oauth"> & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
} => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://127.0.0.1:3000/auth/google/callback";
  const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY;
  if (!clientId || !clientSecret) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before starting the local server.");
  if (!encryptionKey || !/^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/.test(encryptionKey)) {
    throw new Error("Set OAUTH_ENCRYPTION_KEY to a 32-byte key encoded as 64 hex characters or base64.");
  }
  const keyBytes = /^[0-9a-fA-F]{64}$/.test(encryptionKey)
    ? Buffer.from(encryptionKey, "hex")
    : Buffer.from(encryptionKey, "base64");
  if (keyBytes.byteLength !== 32) throw new Error("OAUTH_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535.");
  return {
    clientId,
    clientSecret,
    redirectUri,
    encryptionKey: keyBytes,
    hostname: process.env.HOST ?? "127.0.0.1",
    port,
    accountDataDirectory: process.env.ACCOUNT_DATA_DIRECTORY ?? "./data/accounts",
    gmailApiBaseUrl: process.env.GMAIL_API_BASE_URL,
  };
};
