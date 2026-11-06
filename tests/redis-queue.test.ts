import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RedisQueueService, RedisQueueServiceTest } from "../src/server/services/RedisQueue";
import type { RedisQueueClient } from "../src/server/services/RedisQueue";

describe("RedisQueueService", () => {
  test("reconnects a client that gave up reconnecting before sending", async () => {
    const calls: string[] = [];
    const client: RedisQueueClient = {
      connected: false,
      connect: async () => {
        calls.push("connect");
        (client as { connected: boolean }).connected = true;
      },
      send: async (command) => {
        calls.push(command);
        return 1;
      },
    };
    const program = Effect.gen(function* () {
      const queue = yield* RedisQueueService;
      yield* queue.enqueue("q", { id: 1 });
      yield* queue.enqueue("q", { id: 2 });
    });
    await Effect.runPromise(program.pipe(Effect.provide(RedisQueueServiceTest(client))));
    expect(calls).toEqual(["connect", "LPUSH", "LPUSH"]);
  });
});
