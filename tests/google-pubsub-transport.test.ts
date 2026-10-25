import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Message, Subscription } from "@google-cloud/pubsub";
import {
  GooglePubSubTransport,
  type GooglePubSubClient,
} from "../src/server/services/GooglePubSubTransport";

const makeClient = () => {
  const events = new EventEmitter();
  let closed = false;
  let clientClosed = false;
  let requestedSubscription = "";
  const subscription = Object.assign(events, {
    close: async () => {
      closed = true;
      events.emit("close");
    },
  }) as unknown as Subscription;
  const client: GooglePubSubClient = {
    subscription: (name) => {
      requestedSubscription = name;
      return subscription;
    },
    close: async () => { clientClosed = true; },
  };
  return {
    client,
    events,
    get closed() { return closed; },
    get clientClosed() { return clientClosed; },
    get requestedSubscription() { return requestedSubscription; },
  };
};

describe("Google Pub/Sub StreamingPull transport", () => {
  test("yields decoded Pub/Sub messages as listener deliveries and closes the subscription", async () => {
    const fake = makeClient();
    const transport = new GooglePubSubTransport("demo-project", fake.client);
    const iterator = transport.streamingPull("gmail-updates")[Symbol.asyncIterator]();
    const pending = iterator.next();
    const payload = Buffer.from('{"emailAddress":"me@example.com","historyId":"h2"}');
    fake.events.emit("message", {
      id: "message-1",
      data: payload,
      ack: () => {},
    } as Message);

    const result = await pending;
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      messageId: "message-1",
      data: payload.toString("base64"),
    });
    expect(fake.requestedSubscription).toBe("gmail-updates");
    await iterator.return?.();
    expect(fake.closed).toBe(true);
  });

  test("forwards acknowledgments to the Google Pub/Sub message", async () => {
    const fake = makeClient();
    const transport = new GooglePubSubTransport("demo-project", fake.client);
    const iterator = transport.streamingPull("gmail-updates")[Symbol.asyncIterator]();
    const pending = iterator.next();
    let acknowledged = false;
    fake.events.emit("message", {
      id: "message-ack",
      data: Buffer.from("notification"),
      ack: () => { acknowledged = true; },
    } as Message);

    const result = await pending;
    await result.value?.ack();
    expect(acknowledged).toBe(true);
    await iterator.return?.();
    expect(fake.closed).toBe(true);
  });

  test("closes the Pub/Sub client when the transport is shut down", async () => {
    const fake = makeClient();
    const transport = new GooglePubSubTransport("demo-project", fake.client);

    await transport.close();

    expect(fake.clientClosed).toBe(true);
    await expect(transport.streamingPull("gmail-updates")[Symbol.asyncIterator]().next()).rejects.toThrow("already closed");
  });

  test("propagates subscriber errors and releases the subscription", async () => {
    const fake = makeClient();
    const transport = new GooglePubSubTransport("demo-project", fake.client);
    const iterator = transport.streamingPull("gmail-updates")[Symbol.asyncIterator]();
    const pending = iterator.next();
    fake.events.emit("error", new Error("subscriber unavailable"));

    await expect(pending).rejects.toThrow("subscriber unavailable");
    expect(fake.closed).toBe(true);
  });

  test("ends cleanly when the subscriber closes", async () => {
    const fake = makeClient();
    const transport = new GooglePubSubTransport("demo-project", fake.client);
    const iterator = transport.streamingPull("gmail-updates")[Symbol.asyncIterator]();
    const pending = iterator.next();
    fake.events.emit("close");

    expect(await pending).toMatchObject({ done: true });
    expect(fake.closed).toBe(true);
  });
});
