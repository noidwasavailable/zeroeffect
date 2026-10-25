import { RedisClient } from "bun";
import { Context, Effect, Layer } from "effect";
import { RedisQueueError } from "../../shared/errors";

export interface RedisQueueServiceApi {
  readonly enqueue: (queue: string, payload: unknown) => Effect.Effect<void, RedisQueueError>;
}

export class RedisQueueService extends Context.Service<RedisQueueService, RedisQueueServiceApi>()(
  "zeroeffect/RedisQueueService",
) {}

export interface RedisQueueConfig {
  readonly url: string;
  readonly client?: Pick<RedisClient, "send">;
}

export const RedisQueueServiceLive = (config: RedisQueueConfig): Layer.Layer<RedisQueueService> => {
  const client = config.client ?? new RedisClient(config.url);
  return Layer.succeed(RedisQueueService, makeService(client));
};

export const RedisQueueServiceTest = (client: Pick<RedisClient, "send">): Layer.Layer<RedisQueueService> =>
  Layer.succeed(RedisQueueService, makeService(client));

const makeService = (client: Pick<RedisClient, "send">): RedisQueueServiceApi => ({
  enqueue: (queue, payload) => Effect.tryPromise({
    try: async () => { await client.send("LPUSH", [queue, JSON.stringify(payload)]); },
    catch: (cause) => new RedisQueueError({ message: `Failed to enqueue message in ${queue}.`, cause }),
  }).pipe(Effect.asVoid),
});
