import { RedisClient } from "bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { GoogleOAuth2, GoogleOAuth2Live } from "./services/GoogleOAuth2";
import { GooglePubSubTransport } from "./services/GooglePubSubTransport";
import { PubSubListenerService, PubSubListenerServiceLive } from "./services/PubSubListenerService";
import { RedisQueueServiceLive } from "./services/RedisQueue";
import { RegistryDb, RegistryDbLive } from "./services/RegistryDb";
import { createDevServer, devServerConfigFromEnvironment } from "./dev-server";

const main = async (): Promise<void> => {
  const config = devServerConfigFromEnvironment();
  const pubSubProjectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  const pubSubSubscription = process.env.GMAIL_PUBSUB_SUBSCRIPTION;
  if (Boolean(pubSubProjectId) !== Boolean(pubSubSubscription)) {
    throw new Error("Set both GCP_PROJECT_ID and GMAIL_PUBSUB_SUBSCRIPTION to enable Gmail Pub/Sub ingestion.");
  }
  if (pubSubSubscription && pubSubSubscription.includes("/")) {
    throw new Error("GMAIL_PUBSUB_SUBSCRIPTION must be the subscription ID, not a full resource name.");
  }
  const redirectUri = new URL(config.redirectUri);
  if (
    redirectUri.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(redirectUri.hostname) ||
    redirectUri.pathname !== "/auth/google/callback" ||
    redirectUri.search ||
    redirectUri.hash
  ) {
    throw new Error("GOOGLE_REDIRECT_URI must be a loopback HTTP URL ending in /auth/google/callback.");
  }
  const redirectPort = redirectUri.port ? Number(redirectUri.port) : 80;
  if (config.port === 0 || redirectPort !== config.port) {
    throw new Error("PORT must match the port in GOOGLE_REDIRECT_URI (PORT=0 is not supported for OAuth callbacks).");
  }

  const registryRuntime = ManagedRuntime.make(RegistryDbLive(process.env.REGISTRY_DB_PATH ?? "./data/registry.sqlite"));
  const registry = await registryRuntime.runPromise(Effect.gen(function* () { return yield* RegistryDb; }));
  const oauthLayer = GoogleOAuth2Live({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
  const oauth = Effect.runSync(Effect.gen(function* () { return yield* GoogleOAuth2; }).pipe(Effect.provide(oauthLayer)));
  const pubSubTransport = pubSubProjectId && pubSubSubscription
    ? new GooglePubSubTransport(pubSubProjectId)
    : undefined;
  const redisClient = pubSubTransport
    ? new RedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:6379")
    : undefined;
  const pubSubRuntime = pubSubTransport && redisClient
    ? ManagedRuntime.make(Layer.provide(
      PubSubListenerServiceLive(pubSubTransport),
      RedisQueueServiceLive({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379", client: redisClient }),
    ))
    : undefined;
  const pubSubListener = pubSubRuntime
    ? await pubSubRuntime.runPromise(Effect.gen(function* () { return yield* PubSubListenerService; }))
    : undefined;
  let stopping = false;
  let pubSubTask: Promise<void> | undefined;
  if (pubSubListener && pubSubSubscription) {
    console.log(`Starting Gmail Pub/Sub StreamingPull for ${pubSubSubscription}.`);
    pubSubTask = (async () => {
      while (!stopping) {
        try {
          await Effect.runPromise(pubSubListener.listen(pubSubSubscription));
          if (!stopping) console.error("Gmail Pub/Sub stream closed; reconnecting in 5 seconds.");
        } catch (error) {
          if (!stopping) console.error("Gmail Pub/Sub listener failed; reconnecting in 5 seconds.", error);
        }
        if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    })();
  } else {
    console.log("Gmail Pub/Sub ingestion is disabled; set GCP_PROJECT_ID and GMAIL_PUBSUB_SUBSCRIPTION to enable it.");
  }

  const server = createDevServer({ ...config, registry, oauth });
  console.log(`ZeroEffect local account setup: http://${server.hostname}:${server.port}`);
  console.log("OAuth credentials and tokens stay on this machine; stop this server when you are done.");

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await pubSubTransport?.close();
    await pubSubTask;
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
