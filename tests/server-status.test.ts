import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import type { Subscription } from "@google-cloud/pubsub";
import { Effect } from "effect";
import { isRejectedGrant, supervisePubSub } from "../src/server/pubSubSupervisor";
import { createApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { createServerStatusStore } from "../src/server/serverStatus";
import { createGmailAccessTokenProvider } from "../src/server/services/GmailAccessTokens";
import { GooglePubSubTransport, type GooglePubSubClient } from "../src/server/services/GooglePubSubTransport";
import type { GoogleOAuth2Api } from "../src/server/services/GoogleOAuth2";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbTest } from "../src/server/services/RegistryDb";
import { serverHealth } from "../src/client/components/ServerStatusPanel";
import { LOCAL_REQUEST_HEADER, type ServerStatus } from "../src/shared/api";

const quietLog = { error: () => {}, log: () => {} };
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe("server status store", () => {
  test("keeps one entry per source and account, counts repeats and resolves on success", () => {
    let clock = 1_000;
    const store = createServerStatusStore(() => clock);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.report("catch_up", "personal", new Error("token expired"));
    clock = 2_000;
    store.report("catch_up", "personal", { _tag: "GmailApiError", message: "token still expired" });
    store.report("catch_up", "work", "rate limited");
    expect(store.snapshot().problems.map((problem) => [problem.id, problem.count, problem.message])).toEqual([
      ["catch_up:personal", 2, "token still expired"],
      ["catch_up:work", 1, "rate limited"],
    ]);
    expect(store.snapshot().problems[0]).toMatchObject({ firstAt: 1_000, lastAt: 2_000, resolvedAt: null });

    clock = 3_000;
    store.report("catch_up", "personal", null);
    store.report("ai", "personal", null); // Nothing to resolve: no entry, no notification.
    const [ongoing, resolved] = store.snapshot().problems;
    expect(ongoing).toMatchObject({ id: "catch_up:work", resolvedAt: null });
    expect(resolved).toMatchObject({ id: "catch_up:personal", resolvedAt: 3_000 });
    expect(serverHealth(store.snapshot())).toEqual({ tone: "warn", ongoing: 1 });

    // A resolved problem that recurs starts over.
    store.report("catch_up", "personal", "again");
    expect(store.snapshot().problems.find((problem) => problem.id === "catch_up:personal")).toMatchObject({ count: 1, firstAt: 3_000, resolvedAt: null });
    store.report("catch_up", "personal", null);
    store.dismissResolved();
    expect(store.snapshot().problems.map((problem) => problem.id)).toEqual(["catch_up:work"]);
    expect(notifications).toBe(7);
  });

  test("tracks Pub/Sub state changes and how long a state has lasted", () => {
    let clock = 10;
    const store = createServerStatusStore(() => clock);
    expect(store.snapshot().pubSub).toEqual({ state: "disabled", detail: null, since: 10 });
    clock = 20;
    store.setPubSub("retrying", "first failure");
    clock = 30;
    store.setPubSub("retrying", "second failure");
    expect(store.snapshot().pubSub).toEqual({ state: "retrying", detail: "second failure", since: 20 });
    expect(serverHealth(store.snapshot()).tone).toBe("warn");
    store.setPubSub("listening");
    expect(serverHealth(store.snapshot())).toEqual({ tone: "ok", ongoing: 0 });
  });
});

describe("Pub/Sub supervisor", () => {
  const invalidGrant = new Error("GCP Pub/Sub StreamingPull failed: Error: Getting metadata from plugin failed with error: invalid_grant");

  test("stops retrying on invalid_grant and reconnects as soon as Pub/Sub is reauthorized", async () => {
    const status = createServerStatusStore();
    let attempts = 0;
    let replaced = 0;
    let endStream: (() => void) | undefined;
    const supervisor = supervisePubSub({
      status,
      retryMs: 1,
      log: quietLog,
      replaceClient: async () => {
        replaced += 1;
        endStream?.();
      },
      listen: async () => {
        attempts += 1;
        if (attempts === 1) throw invalidGrant;
        status.setPubSub("listening");
        await new Promise<void>((resolve) => { endStream = resolve; });
      },
    });

    await until(() => status.snapshot().pubSub.state === "needs_reauthorization");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1); // No retry loop against a rejected grant.
    expect(isRejectedGrant(invalidGrant)).toBe(true);
    expect(status.snapshot().problems[0]).toMatchObject({ source: "pubsub", resolvedAt: null });
    expect(status.snapshot().problems[0]!.message).toContain("reconnect Pub/Sub from the setup page");

    await supervisor.reauthorized();
    await until(() => status.snapshot().pubSub.state === "listening");
    expect(attempts).toBe(2);

    // Reauthorizing while a stream is open replaces the client and reconnects without a retry delay.
    await supervisor.reauthorized();
    await until(() => attempts === 3);
    expect(replaced).toBe(2);
    supervisor.stop();
    endStream?.();
    await supervisor.task;
  });

  test("other failures retry with a delay and are counted, not logged every time", async () => {
    const status = createServerStatusStore();
    const logged: unknown[] = [];
    let attempts = 0;
    const supervisor = supervisePubSub({
      status,
      retryMs: 1,
      log: { error: (...args: unknown[]) => { logged.push(args[0]); }, log: () => {} },
      replaceClient: async () => {},
      listen: async () => {
        attempts += 1;
        throw new Error("UNAVAILABLE: connection reset");
      },
    });
    await until(() => attempts >= 4);
    supervisor.stop();
    await supervisor.task;
    expect(logged).toHaveLength(1);
    expect(status.snapshot().pubSub).toMatchObject({ state: "retrying", detail: "UNAVAILABLE: connection reset" });
    expect(status.snapshot().problems[0]!.count).toBeGreaterThanOrEqual(3);
  });
});

describe("Google Pub/Sub transport client replacement", () => {
  const fakeClient = () => {
    const subscription = Object.assign(new EventEmitter(), {
      close: async () => { subscription.emit("close"); },
    }) as unknown as Subscription;
    let closed = false;
    const client: GooglePubSubClient = { subscription: () => subscription, close: async () => { closed = true; } };
    return { client, get closed() { return closed; } };
  };

  test("a failed client is not cached, and replaceClient ends streams and builds a new client", async () => {
    const clients = [fakeClient(), fakeClient()];
    let built = 0;
    let opened = 0;
    const transport = new GooglePubSubTransport("demo", async () => {
      built += 1;
      if (built === 1) throw new Error("invalid_grant");
      return clients[built - 2]!.client;
    }, { onStreamOpened: () => { opened += 1; } });

    const first = transport.streamingPull("sub")[Symbol.asyncIterator]();
    await expect(first.next()).rejects.toThrow("invalid_grant");

    const second = transport.streamingPull("sub")[Symbol.asyncIterator]();
    const pending = second.next();
    await until(() => opened === 1);
    await transport.replaceClient();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(clients[0]!.closed).toBe(true);

    const third = transport.streamingPull("sub")[Symbol.asyncIterator]();
    const next = third.next();
    await until(() => opened === 2);
    expect(built).toBe(3);
    await transport.close();
    await next;
    expect(clients[1]!.closed).toBe(true);
  });
});

describe("status API", () => {
  test("GET /api/status returns the snapshot; clearing resolved problems needs the client header", async () => {
    const registryDatabase = new Database(":memory:");
    const registry = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(RegistryDbTest(registryDatabase))));
    const unusedOAuth: GoogleOAuth2Api = {
      authorizationUrl: () => new URL("http://127.0.0.1/unused"),
      exchangeCode: () => Effect.die("unused"),
      refreshAccessToken: () => Effect.die("unused"),
    };
    const serverStatus = createServerStatusStore();
    serverStatus.setPubSub("needs_reauthorization", "invalid_grant");
    serverStatus.report("watch", "personal", "denied");
    serverStatus.report("watch", "personal", null);
    const api = createApiHandler({
      registry,
      tokens: createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault: OAuthTokenVault.fromKey(new Uint8Array(32).fill(3)) }),
      events: createAccountEventBus(),
      serverStatus,
    });
    const call = async (path: string, init?: RequestInit) => {
      const url = new URL(path, "http://localhost");
      return (await api.handle(new Request(url, init), url))!;
    };

    const status = (await (await call("/api/status")).json() as { status: ServerStatus }).status;
    expect(status.pubSub).toMatchObject({ state: "needs_reauthorization", detail: "invalid_grant" });
    expect(status.problems).toHaveLength(1);
    expect((await call("/api/status/dismiss", { method: "POST" })).status).toBe(403);
    const cleared = await call("/api/status/dismiss", { method: "POST", headers: { [LOCAL_REQUEST_HEADER]: "1" } });
    expect((await cleared.json() as { status: ServerStatus }).status.problems).toEqual([]);
    registryDatabase.close();
  });
});
