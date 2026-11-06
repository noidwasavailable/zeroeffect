import { RedisClient } from "bun";
import { Context, Effect, Layer } from "effect";
import { RedisQueueError } from "../../shared/errors";

export interface RedisQueueServiceApi {
  readonly enqueue: (queue: string, payload: unknown) => Effect.Effect<void, RedisQueueError>;
  /** Atomically moves the oldest queued item to a processing list, waiting up to five seconds. */
  readonly reserve: (queue: string, processingQueue: string) => Effect.Effect<string | null, RedisQueueError>;
  /** Removes a successfully processed item from its processing list. */
  readonly acknowledge: (processingQueue: string, payload: string) => Effect.Effect<void, RedisQueueError>;
  /** Atomically returns an unsuccessful item to the pending queue. */
  readonly retry: (processingQueue: string, queue: string, payload: string) => Effect.Effect<void, RedisQueueError>;
  /** Recovers items left in processing by a previous process. */
  readonly recover: (processingQueue: string, queue: string) => Effect.Effect<number, RedisQueueError>;
}

export class RedisQueueService extends Context.Service<RedisQueueService, RedisQueueServiceApi>()(
  "zeroeffect/RedisQueueService",
) {}

/** `connect`/`connected` are optional so tests can pass a plain `send` fake. */
export type RedisQueueClient = Pick<RedisClient, "send"> & Partial<Pick<RedisClient, "connect" | "connected">>;

export interface RedisQueueConfig {
  readonly url: string;
  readonly client?: RedisQueueClient;
}

export const RedisQueueServiceLive = (config: RedisQueueConfig): Layer.Layer<RedisQueueService> => {
  const client = config.client ?? new RedisClient(config.url);
  return Layer.succeed(RedisQueueService, makeService(client));
};

export const RedisQueueServiceTest = (client: RedisQueueClient): Layer.Layer<RedisQueueService> =>
  Layer.succeed(RedisQueueService, makeService(client));

const makeService = (redis: RedisQueueClient): RedisQueueServiceApi => {
  // Bun's client stops reconnecting for good once its retries run out (e.g. while Docker restarts the
  // Valkey container), so reconnect explicitly before each command.
  const client = {
    send: async (command: string, args: string[]): Promise<unknown> => {
      if (redis.connected === false) await redis.connect?.();
      return redis.send(command, args);
    },
  };
  return {
    enqueue: (queue, payload) => Effect.tryPromise({
      try: async () => { await client.send("LPUSH", [queue, JSON.stringify(payload)]); },
      catch: (cause) => new RedisQueueError({ message: `Failed to enqueue message in ${queue}.`, cause }),
    }).pipe(Effect.asVoid),
    reserve: (queue, processingQueue) => Effect.tryPromise({
      try: async () => {
        const result: unknown = await client.send("BRPOPLPUSH", [queue, processingQueue, "5"]);
        if (result === null || result === undefined) return null;
        if (typeof result !== "string") throw new TypeError("Redis returned a non-string queued message.");
        return result;
      },
      catch: (cause) => new RedisQueueError({ message: `Failed to reserve a message from ${queue}.`, cause }),
    }),
    acknowledge: (processingQueue, payload) => Effect.tryPromise({
      try: async () => { await client.send("LREM", [processingQueue, "1", payload]); },
      catch: (cause) => new RedisQueueError({ message: `Failed to acknowledge a message from ${processingQueue}.`, cause }),
    }).pipe(Effect.asVoid),
    retry: (processingQueue, queue, payload) => Effect.tryPromise({
      try: async () => {
        await client.send("EVAL", [
          "if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then return redis.call('LPUSH', KEYS[2], ARGV[1]) else return 0 end",
          "2", processingQueue, queue, payload,
        ]);
      },
      catch: (cause) => new RedisQueueError({ message: `Failed to return a message to ${queue} for retry.`, cause }),
    }).pipe(Effect.asVoid),
    recover: (processingQueue, queue) => Effect.tryPromise({
      try: async () => {
        let recovered = 0;
        while (await client.send("RPOPLPUSH", [processingQueue, queue])) recovered++;
        return recovered;
      },
      catch: (cause) => new RedisQueueError({ message: `Failed to recover messages from ${processingQueue}.`, cause }),
    }),
  };
};
