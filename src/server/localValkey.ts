import { RedisClient } from "bun";

/** Pinned so a Docker Hub `latest` bump never changes the queue server underneath us. */
export const VALKEY_IMAGE = "valkey/valkey:9.1-alpine";
export const VALKEY_CONTAINER = "zeroeffect-valkey";
/** Named volume, so queued notifications survive container restarts (with append-only persistence). */
export const VALKEY_VOLUME = "zeroeffect-valkey";

export interface LocalValkeyDeps {
  /** Resolves true when a Redis-compatible server answers PING at the URL. */
  readonly ping: (url: string) => Promise<boolean>;
  /** Runs `docker <args>`; resolves the exit code and trimmed stdout/stderr. */
  readonly docker: (args: ReadonlyArray<string>) => Promise<{ readonly exitCode: number; readonly output: string }>;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface LocalValkey {
  /** True when this process started the container (and should stop it on shutdown). */
  readonly started: boolean;
  readonly stop: () => Promise<void>;
}

const isLoopback = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";

export const pingRedis = async (url: string): Promise<boolean> => {
  const client = new RedisClient(url, { connectionTimeout: 1_000, autoReconnect: false, enableOfflineQueue: false });
  try {
    // With the offline queue disabled, commands fail unless the connection is opened first.
    await client.connect();
    return (await client.send("PING", [])) === "PONG";
  } catch {
    return false;
  } finally {
    client.close();
  }
};

const runDocker: LocalValkeyDeps["docker"] = async (args) => {
  try {
    const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { exitCode, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    // Bun.spawn throws when the docker executable is missing.
    return { exitCode: 127, output: error instanceof Error ? error.message : String(error) };
  }
};

const defaultDeps: LocalValkeyDeps = {
  ping: pingRedis,
  docker: runDocker,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Makes sure a Redis-compatible queue is reachable at `redisUrl`. A server already listening there is used as is;
 * otherwise, for a loopback URL, a Valkey container is started (or created) with Docker, bound to 127.0.0.1 only.
 */
export const ensureLocalValkey = async (redisUrl: string, deps: LocalValkeyDeps = defaultDeps): Promise<LocalValkey> => {
  const notStarted: LocalValkey = { started: false, stop: async () => {} };
  if (await deps.ping(redisUrl)) return notStarted;

  const url = new URL(redisUrl);
  if (!isLoopback(url.hostname)) {
    throw new Error(`No Redis-compatible server answered at ${redisUrl}, and only loopback URLs are started automatically.`);
  }
  const port = url.port || "6379";

  const inspect = await deps.docker(["container", "inspect", "--format", "{{.State.Running}}", VALKEY_CONTAINER]);
  if (inspect.exitCode === 127) {
    throw new Error(`Valkey is not running at ${redisUrl} and Docker was not found. Install Docker or point REDIS_URL at a running server.`);
  }
  const started = inspect.exitCode === 0
    ? await deps.docker(["start", VALKEY_CONTAINER])
    : await deps.docker([
      "run", "--detach", "--name", VALKEY_CONTAINER,
      "--publish", `127.0.0.1:${port}:6379`,
      "--volume", `${VALKEY_VOLUME}:/data`,
      VALKEY_IMAGE,
      "valkey-server", "--appendonly", "yes",
    ]);
  if (started.exitCode !== 0) {
    throw new Error(`Could not start the ${VALKEY_CONTAINER} Docker container (is Docker running?): ${started.output}`);
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    if (await deps.ping(redisUrl)) {
      return {
        started: true,
        stop: async () => {
          const stopped = await deps.docker(["stop", VALKEY_CONTAINER]);
          if (stopped.exitCode !== 0) console.error(`Could not stop the ${VALKEY_CONTAINER} container: ${stopped.output}`);
        },
      };
    }
    await deps.sleep(200);
  }
  throw new Error(`Started the ${VALKEY_CONTAINER} container, but nothing answered at ${redisUrl}. Check \`docker logs ${VALKEY_CONTAINER}\`.`);
};
