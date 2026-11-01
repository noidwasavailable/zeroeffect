import { RedisClient } from "bun";
import { PubSub } from "@google-cloud/pubsub";
import { Effect, Layer, ManagedRuntime } from "effect";
import { GoogleOAuth2, GoogleOAuth2Live, PUBSUB_OAUTH_SCOPES } from "./services/GoogleOAuth2";
import { GooglePubSubTransport } from "./services/GooglePubSubTransport";
import { OAuthTokenVault } from "./services/OAuthTokenVault";
import { createGmailAccountOperations } from "./services/GmailAccountOperations";
import { handleQueuedGmailNotification } from "./services/GmailNotificationWorker";
import { PubSubListenerService, PubSubListenerServiceLive } from "./services/PubSubListenerService";
import { RedisQueueService, RedisQueueServiceLive } from "./services/RedisQueue";
import type { RedisQueueServiceApi } from "./services/RedisQueue";
import { RegistryDb, RegistryDbLive } from "./services/RegistryDb";
import { createGmailAccessTokenProvider } from "./services/GmailAccessTokens";
import { createAiRunner } from "./services/AiRunner";
import { ACCOUNT_IDS } from "../shared/api";
import { createApiHandler } from "./routes/api";
import { createAccountEventBus } from "./routes/sse";
import { createDevServer, devServerConfigFromEnvironment } from "./dev-server";
import { ensureLocalValkey, VALKEY_CONTAINER } from "./localValkey";
import type { LocalValkey } from "./localValkey";
import { createServerStatusStore } from "./serverStatus";
import { supervisePubSub, type PubSubSupervisor } from "./pubSubSupervisor";

const CATCH_UP_INTERVAL_MS = 10 * 60 * 1000;

const main = async (): Promise<void> => {
  const config = devServerConfigFromEnvironment();
  const pubSubProjectId = config.pubsubProjectId;
  const pubSubSubscription = config.pubsubSubscription;
  const pubSubTopicId = config.pubsubTopicId;
  const pubSubConfigurationCount = [pubSubProjectId, pubSubSubscription, pubSubTopicId].filter(Boolean).length;
  if (pubSubConfigurationCount !== 0 && pubSubConfigurationCount !== 3) {
    throw new Error("Set GCP_PROJECT_ID, GMAIL_PUBSUB_SUBSCRIPTION, and GMAIL_PUBSUB_TOPIC together to enable Gmail notifications.");
  }
  if (pubSubSubscription && pubSubSubscription.includes("/")) {
    throw new Error("GMAIL_PUBSUB_SUBSCRIPTION must be the subscription ID, not a full resource name.");
  }
  if (pubSubTopicId && (pubSubTopicId.includes("/") || !/^[A-Za-z0-9._~-]{3,255}$/.test(pubSubTopicId))) {
    throw new Error("GMAIL_PUBSUB_TOPIC must be a topic ID, not a full resource name.");
  }
  const pubSubTopic = pubSubProjectId && pubSubTopicId
    ? `projects/${pubSubProjectId}/topics/${pubSubTopicId}`
    : undefined;
  const redirectUri = new URL(config.redirectUri);
  const pubSubRedirectUri = new URL(config.pubsubRedirectUri!);
  const isLoopbackHttp = (url: URL) => url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (
    !isLoopbackHttp(redirectUri) ||
    redirectUri.pathname !== "/auth/google/callback" ||
    redirectUri.search ||
    redirectUri.hash
  ) {
    throw new Error("GOOGLE_REDIRECT_URI must be a loopback HTTP URL ending in /auth/google/callback.");
  }
  if (
    !isLoopbackHttp(pubSubRedirectUri) ||
    pubSubRedirectUri.pathname !== "/auth/google/pubsub/callback" ||
    pubSubRedirectUri.search ||
    pubSubRedirectUri.hash
  ) {
    throw new Error("GOOGLE_PUBSUB_REDIRECT_URI must be a loopback HTTP URL ending in /auth/google/pubsub/callback.");
  }
  const redirectPort = redirectUri.port ? Number(redirectUri.port) : 80;
  const pubSubRedirectPort = pubSubRedirectUri.port ? Number(pubSubRedirectUri.port) : 80;
  if (config.port === 0 || redirectPort !== config.port || pubSubRedirectPort !== config.port) {
    throw new Error("PORT must match both loopback callback URLs (PORT=0 is not supported for OAuth callbacks).");
  }

  const registryRuntime = ManagedRuntime.make(RegistryDbLive(process.env.REGISTRY_DB_PATH ?? "./data/registry.sqlite"));
  const registry = await registryRuntime.runPromise(Effect.gen(function* () { return yield* RegistryDb; }));
  const oauthLayer = GoogleOAuth2Live({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
  const oauth = Effect.runSync(Effect.gen(function* () { return yield* GoogleOAuth2; }).pipe(Effect.provide(oauthLayer)));
  const pubSubOAuthLayer = GoogleOAuth2Live({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.pubsubRedirectUri!,
  });
  const pubSubOAuth = Effect.runSync(Effect.gen(function* () { return yield* GoogleOAuth2; }).pipe(Effect.provide(pubSubOAuthLayer)));
  const vault = OAuthTokenVault.fromKey(config.encryptionKey);
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const tokens = createGmailAccessTokenProvider({ registry, oauth, vault });
  const events = createAccountEventBus();
  // Background problems and the Pub/Sub state, shown in the web client (GET /api/status).
  const serverStatus = createServerStatusStore();
  serverStatus.subscribe(() => {
    for (const accountId of ACCOUNT_IDS) events.publish(accountId, { type: "server-status" });
  });
  const aiRunner = createAiRunner({
    reportProblem: serverStatus.report,
    registry,
    tokens,
    vault,
    events,
    accountDataDirectory: config.accountDataDirectory,
    gmailApiBaseUrl: config.gmailApiBaseUrl,
  });
  // New mail from any sync (Pub/Sub or manual) goes through the AI labeller in the background.
  const classifyNewMail = (accountId: string, threadIds: ReadonlyArray<string> | undefined) => {
    if (!threadIds?.length) return;
    aiRunner.runNewMail(accountId, threadIds).catch((error) => console.error(`AI labelling failed for ${accountId}.`, error));
  };
  const api = createApiHandler({
    registry,
    tokens,
    events,
    aiRunner,
    vault,
    // Sync right after sending so the reply appears (and its conversation status updates) without waiting for Pub/Sub.
    onReplySent: (accountId) => {
      accountOperations.sync(accountId).then(
        () => serverStatus.report("sync", accountId, null),
        (error) => {
          console.error(`Sync after sending from ${accountId} failed.`, error);
          serverStatus.report("sync", accountId, error);
        },
      );
    },
    serverStatus,
    accountDataDirectory: config.accountDataDirectory,
    gmailApiBaseUrl: config.gmailApiBaseUrl,
  });
  const accountOperations = createGmailAccountOperations({
    registry,
    oauth,
    vault,
    tokens,
    // Pub/Sub-driven syncs refresh any open web clients for that account.
    onSynced: (accountId, result) => {
      events.publish(accountId, { type: "threads-changed" });
      classifyNewMail(accountId, result.threadsWithNewMessages);
    },
    accountDataDirectory: config.accountDataDirectory,
    gmailApiBaseUrl: config.gmailApiBaseUrl,
    reportProblem: serverStatus.report,
  });
  let stopping = false;
  let pubSubTransport: GooglePubSubTransport | undefined;
  let redisClient: RedisClient | undefined;
  let pubSubRuntime: ManagedRuntime.ManagedRuntime<PubSubListenerService, never> | undefined;
  let pubSubTask: Promise<void> | undefined;
  let notificationWorkerTask: Promise<void> | undefined;
  let watchRenewalTimer: ReturnType<typeof setInterval> | undefined;
  let localValkey: LocalValkey | undefined;
  const renewWatchesSafely = async (topicName: string): Promise<void> => {
    try {
      await accountOperations.renewWatches(topicName);
    } catch (error) {
      console.error("Could not load Gmail accounts for watch renewal; retrying on the next renewal cycle.", error);
    }
  };
  // The current Pub/Sub refresh token. Reauthorizing replaces it and reconnects the running listener.
  let pubSubRefreshToken = "";
  let pubSubSupervisor: PubSubSupervisor | undefined;
  const startPubSub = async (refreshToken: string): Promise<void> => {
    if (!pubSubProjectId || !pubSubSubscription || !pubSubTopic || stopping) return;
    pubSubRefreshToken = refreshToken;
    // Already running (possibly stuck on a rejected token): reconnect with the new credentials now.
    if (pubSubSupervisor) return pubSubSupervisor.reauthorized();
    // PubSub builds its own GoogleAuth from these options, so google-auth-library needn't be imported directly.
    pubSubTransport = new GooglePubSubTransport(pubSubProjectId, async () => {
      const client = new PubSub({
        projectId: pubSubProjectId,
        credentials: {
          type: "authorized_user",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: pubSubRefreshToken,
        },
        scopes: [...PUBSUB_OAUTH_SCOPES],
      });
      try {
        // Exchange the refresh token up front, so a rejected grant fails here with a clear error.
        await client.auth.getAccessToken();
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      return client;
    }, {
      onStreamOpened: () => {
        serverStatus.setPubSub("listening");
        serverStatus.report("pubsub", null, null);
      },
    });
    redisClient = new RedisClient(redisUrl);
    const queueLayer = RedisQueueServiceLive({ url: redisUrl, client: redisClient });
    const queueApi: RedisQueueServiceApi = Effect.runSync(Effect.gen(function* () { return yield* RedisQueueService; }).pipe(Effect.provide(queueLayer)));
    pubSubRuntime = ManagedRuntime.make(Layer.provide(
      PubSubListenerServiceLive(pubSubTransport),
      Layer.succeed(RedisQueueService, queueApi),
    ));
    const listener = await pubSubRuntime.runPromise(Effect.gen(function* () { return yield* PubSubListenerService; }));
    const processingQueue = "gmail:notifications:processing";
    notificationWorkerTask = (async () => {
      let reserved: string | null = null;
      while (!stopping) {
        try {
          const count = await Effect.runPromise(queueApi.recover(processingQueue, "gmail:notifications"));
          if (count > 0) console.warn(`Recovered ${count} unacknowledged Gmail notification(s) from the previous run.`);
          break;
        } catch (error) {
          console.error("Could not recover in-flight Gmail notifications; retrying shortly.", error);
          serverStatus.report("notifications", null, error);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      while (!stopping) {
        try {
          if (reserved === null) reserved = await Effect.runPromise(queueApi!.reserve("gmail:notifications", processingQueue));
          if (reserved === null) continue;
          const outcome = await handleQueuedGmailNotification(
            reserved,
            queueApi,
            // Report the processor's own outcome: the handler only logs the error.
            (data) => accountOperations.processNotification(data).then(
              (result) => {
                serverStatus.report("notifications", null, null);
                return result;
              },
              (error: unknown) => {
                serverStatus.report("notifications", null, error);
                throw error;
              },
            ),
          );
          reserved = null;
          if (outcome === "retried" && !stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
        } catch (error) {
          console.error("Gmail notification processing failed; preserving the queue item for retry.", error);
          serverStatus.report("notifications", null, error);
          if (reserved !== null) {
            try {
              await Effect.runPromise(queueApi!.retry(processingQueue, "gmail:notifications", reserved));
              reserved = null;
            } catch (retryError) {
              console.error("Could not return the Gmail notification to the pending queue; it remains in processing.", retryError);
            }
          }
          if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    })();
    console.log(`Starting Gmail Pub/Sub StreamingPull for ${pubSubSubscription}.`);
    const transport = pubSubTransport;
    pubSubSupervisor = supervisePubSub({
      listen: () => Effect.runPromise(listener.listen(pubSubSubscription)),
      replaceClient: () => transport.replaceClient(),
      status: serverStatus,
    });
    pubSubTask = pubSubSupervisor.task;
    void renewWatchesSafely(pubSubTopic);
    watchRenewalTimer = setInterval(() => {
      void renewWatchesSafely(pubSubTopic);
    }, 12 * 60 * 60 * 1000);
  };
  if (pubSubProjectId && pubSubSubscription && pubSubTopic) {
    // The notification queue needs Redis/Valkey; start a local Valkey container if nothing is listening yet.
    try {
      localValkey = await ensureLocalValkey(redisUrl);
      if (localValkey.started) console.log(`Started Valkey (Docker container ${VALKEY_CONTAINER}) at ${redisUrl}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error, "Gmail notifications will queue once it is reachable.");
    }
    try {
      const encrypted = await registryRuntime.runPromise(registry.getServiceCredential("google_pubsub"));
      if (encrypted) {
        const stored = vault.decrypt<{ readonly refreshToken?: unknown }>(encrypted);
        if (typeof stored.refreshToken === "string" && stored.refreshToken.length > 0) {
          await startPubSub(stored.refreshToken);
        } else {
          console.error("Stored Google Pub/Sub authorization is invalid; reconnect it from the local setup page.");
          serverStatus.setPubSub("needs_reauthorization", "The stored Pub/Sub authorization is invalid.");
        }
      } else {
        console.log("Gmail Pub/Sub is configured but not authorized. Connect its Google account from the local setup page.");
        serverStatus.setPubSub("unauthorized");
      }
    } catch {
      console.error("Stored Google Pub/Sub authorization could not be read. Reconnect it from the local setup page.");
      serverStatus.setPubSub("needs_reauthorization", "The stored Pub/Sub authorization could not be read.");
    }
  } else {
    console.log("Gmail Pub/Sub ingestion is disabled; set GCP_PROJECT_ID, GMAIL_PUBSUB_SUBSCRIPTION, and GMAIL_PUBSUB_TOPIC to enable it.");
  }

  // Catch-up sync at startup and every few minutes, whether or not Pub/Sub is configured: it picks up
  // mail whose notification was lost (lapsed watch, downtime, a dropped delivery). With nothing new it
  // costs one history.list request per account.
  const runCatchUp = () => {
    if (!stopping) accountOperations.catchUp().catch((error) => console.error("Catch-up sync failed.", error));
  };
  runCatchUp();
  const catchUpTimer = setInterval(runCatchUp, CATCH_UP_INTERVAL_MS);

  const server = createDevServer({
    ...config,
    registry,
    oauth,
    tokens,
    events,
    api,
    onSyncCompleted: (accountId, result) => classifyNewMail(accountId, result.threadsWithNewMessages),
    pubsubOAuth: pubSubOAuth,
    onPubSubAuthorization: startPubSub,
    onGmailAccountConnected: async (accountId) => {
      if (!pubSubTopic || !pubSubTask || stopping) return;
      try {
        await accountOperations.ensureWatch(accountId, pubSubTopic);
        serverStatus.report("watch", accountId, null);
      } catch (error) {
        console.error(`Could not establish a Gmail Pub/Sub watch for newly connected account ${accountId}.`, error);
        serverStatus.report("watch", accountId, error);
      }
    },
  });
  console.log(`ZeroEffect web client: http://${server.hostname}:${server.port}/`);
  console.log(`Connect Gmail accounts (on this machine): http://${server.hostname}:${server.port}/setup`);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    pubSubSupervisor?.stop();
    server.stop(true);
    if (watchRenewalTimer) clearInterval(watchRenewalTimer);
    clearInterval(catchUpTimer);
    await pubSubTransport?.close();
    await Promise.all([pubSubTask, notificationWorkerTask]);
    await pubSubRuntime?.dispose();
    await api.close();
    redisClient?.close();
    await localValkey?.stop();
    await registryRuntime.dispose();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
};

if (import.meta.main) {
  main().catch((error) => {
    if ((error as { code?: unknown })?.code === "EADDRINUSE") {
      console.error(`${error instanceof Error ? error.message : error}\nIs the background server running? Stop it with: bun run zeroeffect stop`);
      // Background workers (Pub/Sub, sync timers) started before the port was bound; do not leave them running.
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
