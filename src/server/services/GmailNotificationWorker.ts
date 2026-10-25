import { Effect } from "effect";
import type { RedisQueueServiceApi } from "./RedisQueue";

export interface QueuedGmailNotification {
  readonly messageId: string;
  readonly data: string;
}

export type GmailNotificationProcessor = (data: string) => Promise<"synced" | "ignored">;

/** Process a reserved Redis item, acknowledging only after handling succeeds. */
export const handleQueuedGmailNotification = async (
  payload: string,
  queue: RedisQueueServiceApi,
  processNotification: GmailNotificationProcessor,
  pendingQueue = "gmail:notifications",
  processingQueue = "gmail:notifications:processing",
): Promise<"acknowledged" | "retried"> => {
  try {
    let envelope: unknown;
    try {
      envelope = JSON.parse(payload) as unknown;
    } catch {
      console.warn("Discarding malformed queued Gmail Pub/Sub envelope.");
      await Effect.runPromise(queue.acknowledge(processingQueue, payload));
      return "acknowledged";
    }

    if (
      typeof envelope !== "object" || envelope === null ||
      typeof (envelope as Partial<QueuedGmailNotification>).messageId !== "string" ||
      typeof (envelope as Partial<QueuedGmailNotification>).data !== "string"
    ) {
      console.warn("Discarding queued Gmail Pub/Sub envelope without a messageId and data.");
      await Effect.runPromise(queue.acknowledge(processingQueue, payload));
      return "acknowledged";
    }

    await processNotification((envelope as QueuedGmailNotification).data);
    await Effect.runPromise(queue.acknowledge(processingQueue, payload));
    return "acknowledged";
  } catch (error) {
    await Effect.runPromise(queue.retry(processingQueue, pendingQueue, payload));
    console.error("Gmail notification processing failed; returned to the queue for retry.", error);
    return "retried";
  }
};
