import { RedisClient } from "bun";
import { GoogleAuth } from "google-auth-library";
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
import { createDevServer, devServerConfigFromEnvironment } from "./dev-server";

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
  const accountOperations = createGmailAccountOperations({
    registry,
    oauth,
    vault,
    accountDataDirectory: config.accountDataDirectory,
    gmailApiBaseUrl: config.gmailApiBaseUrl,
  });
  let stopping = false;
  let pubSubTransport: GooglePubSubTransport | undefined;
  let redisClient: RedisClient | undefined;
  let pubSubRuntime: ManagedRuntime.ManagedRuntime<PubSubListenerService, never> | undefined;
  let pubSubTask: Promise<void> | undefined;
  let notificationWorkerTask: Promise<void> | undefined;
  let watchRenewalTimer: ReturnType<typeof setInterval> | undefined;
  const renewWatchesSafely = async (topicName: string): Promise<void> => {
    try {
      await accountOperations.renewWatches(topicName);
    } catch (error) {
      console.error("Could not load Gmail accounts for watch renewal; retrying on the next renewal cycle.", error);
    }
  };
  const startPubSub = async (refreshToken: string): Promise<void> => {
    if (!pubSubProjectId || !pubSubSubscription || !pubSubTopic || stopping || pubSubTask) return;
    pubSubTransport = new GooglePubSubTransport(pubSubProjectId, () => {
      const auth = new GoogleAuth({
        credentials: {
          type: "authorized_user",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
        },
        scopes: [...PUBSUB_OAUTH_SCOPES],
      });
      return new PubSub({ projectId: pubSubProjectId, auth });
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
            accountOperations.processNotification,
          );
          reserved = null;
          if (outcome === "retried" && !stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
        } catch (error) {
          console.error("Gmail notification processing failed; preserving the queue item for retry.", error);
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
    pubSubTask = (async () => {
      while (!stopping) {
        try {
          await Effect.runPromise(listener.listen(pubSubSubscription));
          if (!stopping) console.error("Gmail Pub/Sub stream closed; reconnecting in 5 seconds.");
        } catch (error) {
          if (!stopping) console.error("Gmail Pub/Sub listener failed; reconnecting in 5 seconds.", error);
        }
        if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    })();
    void renewWatchesSafely(pubSubTopic);
    watchRenewalTimer = setInterval(() => {
      void renewWatchesSafely(pubSubTopic);
    }, 12 * 60 * 60 * 1000);
  };
  if (pubSubProjectId && pubSubSubscription && pubSubTopic) {
    try {
      const encrypted = await registryRuntime.runPromise(registry.getServiceCredential("google_pubsub"));
      if (encrypted) {
        const stored = vault.decrypt<{ readonly refreshToken?: unknown }>(encrypted);
        if (typeof stored.refreshToken === "string" && stored.refreshToken.length > 0) await startPubSub(stored.refreshToken);
        else console.error("Stored Google Pub/Sub authorization is invalid; reconnect it from the local setup page.");
      } else {
        console.log("Gmail Pub/Sub is configured but not authorized. Connect its Google account from the local setup page.");
      }
    } catch {
      console.error("Stored Google Pub/Sub authorization could not be read. Reconnect it from the local setup page.");
    }
  } else {
    console.log("Gmail Pub/Sub ingestion is disabled; set GCP_PROJECT_ID, GMAIL_PUBSUB_SUBSCRIPTION, and GMAIL_PUBSUB_TOPIC to enable it.");
  }

  const server = createDevServer({
    ...config,
    registry,
    oauth,
    pubsubOAuth: pubSubOAuth,
    onPubSubAuthorization: startPubSub,
    onGmailAccountConnected: async (accountId) => {
      if (!pubSubTopic || !pubSubTask || stopping) return;
      try {
        await accountOperations.ensureWatch(accountId, pubSubTopic);
      } catch (error) {
        console.error(`Could not establish a Gmail Pub/Sub watch for newly connected account ${accountId}.`, error);
      }
    },
  });
  console.log(`ZeroEffect local account setup: http://${server.hostname}:${server.port}`);
  console.log("OAuth credentials and tokens stay on this machine; stop this server when you are done.");

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    if (watchRenewalTimer) clearInterval(watchRenewalTimer);
    await pubSubTransport?.close();
    await Promise.all([pubSubTask, notificationWorkerTask]);
    await pubSubRuntime?.dispose();
    redisClient?.close();
    await registryRuntime.dispose();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
