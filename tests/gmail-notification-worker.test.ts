import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RedisQueueError } from "../src/shared/errors";
import type { RedisQueueServiceApi } from "../src/server/services/RedisQueue";
import { handleQueuedGmailNotification } from "../src/server/services/GmailNotificationWorker";

const envelope = JSON.stringify({ messageId: "message-1", data: "{\"emailAddress\":\"work@example.com\",\"historyId\":\"22\"}" });

const fakeQueue = (
  events: string[],
  options: { readonly failAcknowledge?: boolean; readonly failRetry?: boolean } = {},
): RedisQueueServiceApi => ({
  enqueue: () => Effect.void,
  reserve: () => Effect.succeed(null),
  acknowledge: (_processingQueue, payload) => options.failAcknowledge
    ? Effect.fail(new RedisQueueError({ message: "ack failed" }))
    : Effect.sync(() => { events.push(`ack:${payload}`); }),
  retry: (_processingQueue, _pendingQueue, payload) => options.failRetry
    ? Effect.fail(new RedisQueueError({ message: "retry failed" }))
    : Effect.sync(() => { events.push(`retry:${payload}`); }),
  recover: () => Effect.succeed(0),
});

describe("Gmail notification Redis worker", () => {
  test("acknowledges only after notification processing succeeds", async () => {
    const events: string[] = [];
    const result = await handleQueuedGmailNotification(
      envelope,
      fakeQueue(events),
      async (data) => {
        events.push(`process:${data}`);
        return "synced";
      },
    );

    expect(result).toBe("acknowledged");
    expect(events).toEqual([
      `process:{"emailAddress":"work@example.com","historyId":"22"}`,
      `ack:${envelope}`,
    ]);
  });

  test("returns a failed notification to the pending queue without acknowledging it", async () => {
    const events: string[] = [];
    const result = await handleQueuedGmailNotification(
      envelope,
      fakeQueue(events),
      async () => { throw new Error("temporary sync failure"); },
    );

    expect(result).toBe("retried");
    expect(events).toEqual([`retry:${envelope}`]);
  });

  test("discards malformed queue envelopes but retries if acknowledging them fails", async () => {
    const events: string[] = [];
    const result = await handleQueuedGmailNotification("not-json", fakeQueue(events), async () => "ignored");
    expect(result).toBe("acknowledged");
    expect(events).toEqual(["ack:not-json"]);

    const failingQueue = fakeQueue(events, { failAcknowledge: true });
    await expect(handleQueuedGmailNotification("null", failingQueue, async () => "ignored"))
      .resolves.toBe("retried");
    expect(events.at(-1)).toBe("retry:null");
  });

  test("leaves an item in processing when Redis cannot return it for retry", async () => {
    await expect(handleQueuedGmailNotification(
      envelope,
      fakeQueue([], { failRetry: true }),
      async () => { throw new Error("temporary sync failure"); },
    )).rejects.toThrow("retry failed");
  });
});
