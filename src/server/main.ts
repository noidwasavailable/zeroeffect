import { Effect, ManagedRuntime } from "effect";
import { GoogleOAuth2, GoogleOAuth2Live } from "./services/GoogleOAuth2";
import { RegistryDb, RegistryDbLive } from "./services/RegistryDb";
import { createDevServer, devServerConfigFromEnvironment } from "./dev-server";

const main = async (): Promise<void> => {
  const config = devServerConfigFromEnvironment();
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
  const server = createDevServer({ ...config, registry, oauth });
  console.log(`ZeroEffect local account setup: http://${server.hostname}:${server.port}`);
  console.log("OAuth credentials and tokens stay on this machine; stop this server when you are done.");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
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
