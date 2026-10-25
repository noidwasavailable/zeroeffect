import { Context, Effect, Layer, Stream } from "effect";
import { GmailApiError, RedisQueueError } from "../../shared/errors";
import { RedisQueueService } from "./RedisQueue";

export interface PubSubDelivery {
  readonly messageId: string;
  readonly data: string;
  readonly ack: () => Promise<void>;
}

/** Adapter for a GCP Pub/Sub StreamingPull connection. */
export interface StreamingPullTransport {
  readonly streamingPull: (subscription: string) => AsyncIterable<PubSubDelivery>;
}

export interface PubSubListenerServiceApi {
  readonly listen: (subscription: string) => Effect.Effect<void, GmailApiError | RedisQueueError>;
}

export class PubSubListenerService extends Context.Service<PubSubListenerService, PubSubListenerServiceApi>()(
  "zeroeffect/PubSubListenerService",
) {}

export const PubSubListenerServiceLive = (
  transport: StreamingPullTransport,
  queueName = "gmail:notifications",
): Layer.Layer<PubSubListenerService, never, RedisQueueService> =>
  Layer.effect(PubSubListenerService, Effect.gen(function* () {
    const queue = yield* RedisQueueService;
    const listen = (subscription: string) => Stream.fromAsyncIterable(
      transport.streamingPull(subscription),
      (cause) => new GmailApiError({ message: `GCP Pub/Sub StreamingPull failed: ${String(cause)}`, status: 0, retryable: true }),
    ).pipe(Stream.runForEach((delivery) => Effect.gen(function* () {
      let decoded: string;
      try {
        decoded = Buffer.from(delivery.data, "base64").toString("utf8");
      } catch (cause) {
        return yield* Effect.fail(new GmailApiError({ message: `Invalid Pub/Sub message data: ${String(cause)}`, status: 400, retryable: false }));
      }
      yield* queue.enqueue(queueName, { messageId: delivery.messageId, data: decoded });
      yield* Effect.tryPromise({
        try: delivery.ack,
        catch: (cause) => new RedisQueueError({ message: `Failed to acknowledge Pub/Sub message ${delivery.messageId}.`, cause }),
      });
    })));
    return { listen };
  }));

export const PubSubListenerServiceTest = PubSubListenerServiceLive;
