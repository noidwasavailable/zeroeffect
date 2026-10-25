import { RedisClient } from "bun";
import { GoogleAuth } from "google-auth-library";
import { PubSub } from "@google-cloud/pubsub";
import { Effect, Layer, ManagedRuntime } from "effect";
import { GoogleOAuth2, GoogleOAuth2Live, PUBSUB_OAUTH_SCOPES } from "./services/GoogleOAuth2";
import { GooglePubSubTransport } from "./services/GooglePubSubTransport";
import { OAuthTokenVault } from "./services/OAuthTokenVault";
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
  let stopping = false;
  let pubSubTransport: GooglePubSubTransport | undefined;
  let redisClient: RedisClient | undefined;
  let pubSubRuntime: ManagedRuntime.ManagedRuntime<PubSubListenerService, never> | undefined;
  let pubSubTask: Promise<void> | undefined;
  const startPubSub = async (refreshToken: string): Promise<void> => {
    if (!pubSubProjectId || !pubSubSubscription || stopping || pubSubTask) return;
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
    pubSubRuntime = ManagedRuntime.make(Layer.provide(
      PubSubListenerServiceLive(pubSubTransport),
      RedisQueueServiceLive({ url: redisUrl, client: redisClient }),
    ));
    const listener = await pubSubRuntime.runPromise(Effect.gen(function* () { return yield* PubSubListenerService; }));
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
  };
  if (pubSubProjectId && pubSubSubscription) {
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
    console.log("Gmail Pub/Sub ingestion is disabled; set GCP_PROJECT_ID and GMAIL_PUBSUB_SUBSCRIPTION to enable it.");
  }

  const server = createDevServer({
    ...config,
    registry,
    oauth,
    pubsubOAuth: pubSubOAuth,
    onPubSubAuthorization: startPubSub,
  });
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
