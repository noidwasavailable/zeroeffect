import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { AccountDb, AccountDbTest } from "../src/server/services/AccountDb";
import { GmailClient, GmailClientLive } from "../src/server/services/GmailClient";
import type { GmailClientService, GmailMessage } from "../src/server/services/GmailClient";
import { GmailSyncService, GmailSyncServiceLive } from "../src/server/services/GmailSyncService";
import { parseMimeBody, sanitizeHtml } from "../src/server/services/MimeParser";
import { GoogleOAuth2, GoogleOAuth2Live } from "../src/server/services/GoogleOAuth2";
import { PubSubListenerService, PubSubListenerServiceLive } from "../src/server/services/PubSubListenerService";
import type { PubSubDelivery } from "../src/server/services/PubSubListenerService";
import { RedisQueueService } from "../src/server/services/RedisQueue";
import { SendAsComposerService, SendAsComposerServiceLive } from "../src/server/services/SendAsComposerService";
import { GmailApiError, RedisQueueError } from "../src/shared/errors";

const closeables: Array<{ close: () => void }> = [];
afterAll(() => { for (const item of closeables) item.close(); });

const makeAccountDb = () => {
  const database = new Database(":memory:");
  closeables.push(database);
  const layer = AccountDbTest("personal", database);
  const service = Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(layer)));
  return { layer, service };
};

const mockMessage = (id: string, threadId = `thread-${id}`, labels = ["INBOX", "UNREAD"]): GmailMessage => ({
  id,
  threadId,
  snippet: `snippet ${id}`,
  internalDate: "1710000000000",
  labelIds: labels,
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "me@example.com" },
      { name: "Delivered-To", value: "alias@example.com" },
      { name: "Subject", value: `Message ${id}` },
    ],
    body: { data: Buffer.from(`Hello ${id}`).toString("base64url") },
  },
});

describe("Phase 2: Gmail sync, aliases and Pub/Sub", () => {
  test("sanitizes MIME HTML and prefers plain text alternatives", () => {
    const html = sanitizeHtml('<p onclick="evil()">Hi<script>alert(1)</script><a href="javascript:alert(1)">click</a><img src=x></p>');
    expect(html).toBe("<p>Hi<a>click</a></p>");
    const parsed = parseMimeBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Plain body").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from("<p>HTML body</p>").toString("base64url") } },
      ],
    });
    expect(parsed.bodyMarkdown).toBe("Plain body");
    expect(parsed.bodyHtmlSanitized).toBe("<p>HTML body</p>");
  });

  test("performs initial hydration, Send As sync and incremental history updates", async () => {
    const { layer: accountLayer, service: accountDb } = makeAccountDb();
    const messages = new Map([["m1", mockMessage("m1")], ["m2", mockMessage("m2")]]);
    let historyCalls = 0;
    const gmail: GmailClientService = {
      getProfile: () => Effect.succeed({ emailAddress: "personal@example.com", historyId: "h-2" }),
      listMessages: () => Effect.succeed({ messages: [{ id: "m1" }] }),
      getMessage: (id) => Effect.succeed(messages.get(id)! ),
      listThreads: () => Effect.succeed({ threads: [{ id: "thread-m1" }] }),
      getThread: (id) => Effect.succeed({ id, messages: [messages.get("m1")!] }),
      listHistory: () => {
        historyCalls++;
        return Effect.succeed({
          historyId: "h-3",
          history: [{ id: "h-3", messagesAdded: [{ message: { id: "m2" } }] }],
        });
      },
      listSendAs: () => Effect.succeed([{ sendAsEmail: "alias@example.com", displayName: "Alias", isDefault: true, isPrimary: false, verificationStatus: "accepted" }]),
      watch: (topicName) => Effect.succeed({ historyId: `watch-${topicName}`, expiration: "1710000000000" }),
      sendRaw: () => Effect.succeed({ id: "sent", threadId: "thread-sent" }),
    };
    const gmailLayer = Layer.succeed(GmailClient, gmail);
    const syncLayer = Layer.provide(GmailSyncServiceLive, Layer.merge(accountLayer, gmailLayer));
    const sync = Effect.runSync(Effect.gen(function* () { return yield* GmailSyncService; }).pipe(Effect.provide(syncLayer)));

    expect(await Effect.runPromise(sync.watch("projects/demo/topics/gmail"))).toEqual({
      historyId: "watch-projects/demo/topics/gmail", expiration: "1710000000000",
    });
    const initial = await Effect.runPromise(sync.sync());
    expect(initial).toEqual({ mode: "initial", messagesUpserted: 1, messagesDeleted: 0 });
    expect(await Effect.runPromise(accountDb.getHistoryId())).toBe("h-2");
    expect(await Effect.runPromise(accountDb.getThread("thread-m1"))).toMatchObject({
      subject: "Message m1", labels: ["INBOX", "UNREAD"], isUnread: true,
    });
    expect(await Effect.runPromise(accountDb.listSendAsAliases())).toHaveLength(1);

    const incremental = await Effect.runPromise(sync.sync());
    expect(incremental).toEqual({ mode: "incremental", messagesUpserted: 1, messagesDeleted: 0 });
    expect(await Effect.runPromise(accountDb.getHistoryId())).toBe("h-3");
    expect(await Effect.runPromise(accountDb.getThread("thread-m2"))).not.toBeNull();
    expect(historyCalls).toBe(1);
  });

  test("bounds initial hydration by conversation count and reports progress", async () => {
    const { layer: accountLayer, service: accountDb } = makeAccountDb();
    const pages: Array<{ pageToken?: string; maxResults?: number }> = [];
    const requestedThreads: string[] = [];
    const threadMessages = new Map([
      ["t1", [mockMessage("t1-a", "t1"), mockMessage("t1-b", "t1")]],
      ["t2", [mockMessage("t2-a", "t2")]],
      ["t3", [mockMessage("t3-a", "t3")]],
    ]);
    const gmail: GmailClientService = {
      getProfile: () => Effect.succeed({ emailAddress: "me@example.com", historyId: "initial-history" }),
      listMessages: () => Effect.succeed({ messages: [] }),
      getMessage: () => Effect.fail({} as never),
      listThreads: (pageToken, maxResults) => {
        pages.push({ ...(pageToken === undefined ? {} : { pageToken }), ...(maxResults === undefined ? {} : { maxResults }) });
        return Effect.succeed(pageToken
          ? { threads: [{ id: "t2" }, { id: "t3" }] }
          : { threads: [{ id: "t1" }], nextPageToken: "next" });
      },
      getThread: (id) => {
        requestedThreads.push(id);
        return Effect.succeed({ id, messages: threadMessages.get(id)! });
      },
      listHistory: () => Effect.succeed({ historyId: "initial-history", history: [] }),
      listSendAs: () => Effect.succeed([]),
      watch: () => Effect.succeed({ historyId: "initial-history", expiration: "1710000000000" }),
      sendRaw: () => Effect.succeed({ id: "sent", threadId: "sent" }),
    };
    const layer = Layer.provide(GmailSyncServiceLive, Layer.merge(accountLayer, Layer.succeed(GmailClient, gmail)));
    const service = Effect.runSync(Effect.gen(function* () { return yield* GmailSyncService; }).pipe(Effect.provide(layer)));
    const progress: Array<{ conversationsCompleted: number; messagesUpserted: number }> = [];

    const result = await Effect.runPromise(service.sync({
      initialConversationLimit: 2,
      onProgress: (update) => progress.push({ conversationsCompleted: update.conversationsCompleted, messagesUpserted: update.messagesUpserted }),
    }));

    expect(result).toEqual({ mode: "initial", messagesUpserted: 3, messagesDeleted: 0 });
    expect(pages).toEqual([{ maxResults: 2 }, { pageToken: "next", maxResults: 1 }]);
    expect(requestedThreads).toEqual(["t1", "t2"]);
    expect(progress).toEqual([
      { conversationsCompleted: 0, messagesUpserted: 0 },
      { conversationsCompleted: 1, messagesUpserted: 2 },
      { conversationsCompleted: 2, messagesUpserted: 3 },
    ]);
    expect(await Effect.runPromise(accountDb.getThread("t1"))).not.toBeNull();
    expect(await Effect.runPromise(accountDb.getThread("t2"))).not.toBeNull();
    expect(await Effect.runPromise(accountDb.getThread("t3"))).toBeNull();
  });

  test("recovers expired Gmail history cursors by rehydrating", async () => {
    const { layer: accountLayer, service: accountDb } = makeAccountDb();
    await Effect.runPromise(accountDb.setHistoryId("expired"));
    const gmail: GmailClientService = {
      getProfile: () => Effect.succeed({ emailAddress: "me@example.com", historyId: "fresh" }),
      listMessages: () => Effect.succeed({ messages: [{ id: "recovered" }] }),
      getMessage: () => Effect.succeed(mockMessage("recovered")),
      listThreads: () => Effect.succeed({ threads: [{ id: "recovered-thread" }] }),
      getThread: () => Effect.succeed({ id: "recovered-thread", messages: [mockMessage("recovered", "recovered-thread")] }),
      listHistory: () => Effect.fail(new GmailApiError({ message: "gone", status: 404, retryable: false })),
      listSendAs: () => Effect.succeed([]),
      watch: () => Effect.succeed({ historyId: "fresh", expiration: "1710000000000" }),
      sendRaw: () => Effect.succeed({ id: "sent", threadId: "sent" }),
    };
    const layer = Layer.provide(GmailSyncServiceLive, Layer.merge(accountLayer, Layer.succeed(GmailClient, gmail)));
    const service = Effect.runSync(Effect.gen(function* () { return yield* GmailSyncService; }).pipe(Effect.provide(layer)));
    expect(await Effect.runPromise(service.sync())).toMatchObject({ mode: "initial", messagesUpserted: 1 });
    expect(await Effect.runPromise(accountDb.getHistoryId())).toBe("fresh");
  });

  test("uses a local OAuth endpoint and binds token exchanges to an account", async () => {
    let parsedBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        parsedBody = await request.text();
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      },
    });
    try {
      const layer = GoogleOAuth2Live({
        clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/callback",
        authorizationEndpoint: `${server.url}authorize`, tokenEndpoint: `${server.url}token`,
      });
      const oauth = Effect.runSync(Effect.gen(function* () { return yield* GoogleOAuth2; }).pipe(Effect.provide(layer)));
      const url = oauth.authorizationUrl("personal", "csrf-state");
      expect(url.searchParams.get("state")).toBe("personal:csrf-state");
      expect(url.searchParams.get("access_type")).toBe("offline");
      const result = await Effect.runPromise(oauth.exchangeCode("personal", "auth-code"));
      expect(result).toEqual({ accountId: "personal", tokens: { accessToken: "access", refreshToken: "refresh", expiresIn: 3600 } });
      expect(new URLSearchParams(parsedBody).get("grant_type")).toBe("authorization_code");
    } finally {
      server.stop(true);
    }
  });

  test("calls Gmail endpoints with OAuth and detects retryable API errors", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const clientLayer = GmailClientLive({
      accessToken: "access-token",
      apiBaseUrl: "http://gmail.test/gmail/v1",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
        if (url.endsWith("/profile")) return Response.json({ historyId: "h1", emailAddress: "me@example.com" });
        if (url.includes("/threads/")) return Response.json({ id: "t1", messages: [mockMessage("m1", "t1")] });
        if (url.includes("/threads?")) return Response.json({ threads: [{ id: "t1" }] });
        return Response.json({ historyId: "watch-h1", expiration: "1710000000000" });
      },
    });
    const client = Effect.runSync(Effect.gen(function* () { return yield* GmailClient; }).pipe(Effect.provide(clientLayer)));
    expect(await Effect.runPromise(client.getProfile())).toEqual({ historyId: "h1", emailAddress: "me@example.com" });
    expect(await Effect.runPromise(client.watch("projects/demo/topics/gmail"))).toEqual({
      historyId: "watch-h1", expiration: "1710000000000",
    });
    expect(await Effect.runPromise(client.listThreads(undefined, 25))).toEqual({ threads: [{ id: "t1" }] });
    expect(await Effect.runPromise(client.getThread("t1"))).toMatchObject({ id: "t1" });
    expect(requests[0]?.authorization).toBe("Bearer access-token");
    expect(requests[0]?.url).toContain("/users/me/profile");
    expect(requests[1]?.url).toContain("/users/me/watch");
    expect(requests[2]?.url).toContain("/users/me/threads?maxResults=25");
    expect(requests[3]?.url).toContain("/users/me/threads/t1?format=full");
  });

  test("selects the matching Delivered-To alias and creates Gmail raw RFC 2822 data", async () => {
    const { layer: accountLayer, service: accountDb } = makeAccountDb();
    await Effect.runPromise(accountDb.replaceSendAsAliases([
      { sendAsEmail: "primary@example.com", displayName: "Primary", replyToAddress: null, signatureHtml: null, isPrimary: true, isDefault: true, verificationStatus: "accepted" },
      { sendAsEmail: "alias@example.com", displayName: "Support", replyToAddress: "reply@example.com", signatureHtml: "<b>Team</b>", isPrimary: false, isDefault: false, verificationStatus: "accepted" },
    ]));
    const gmailLayer = Layer.succeed(GmailClient, {
      getProfile: () => Effect.fail({} as never), listMessages: () => Effect.fail({} as never),
      getMessage: () => Effect.fail({} as never), listThreads: () => Effect.fail({} as never),
      getThread: () => Effect.fail({} as never), listHistory: () => Effect.fail({} as never),
      listSendAs: () => Effect.succeed([]), watch: () => Effect.succeed({ historyId: "h1", expiration: "1710000000000" }),
      sendRaw: () => Effect.succeed({ id: "sent", threadId: "t1" }),
    } satisfies GmailClientService);
    const layer = Layer.provide(SendAsComposerServiceLive, Layer.merge(accountLayer, gmailLayer));
    const composer = Effect.runSync(Effect.gen(function* () { return yield* SendAsComposerService; }).pipe(Effect.provide(layer)));
    const message = await Effect.runPromise(composer.compose({
      to: ["recipient@example.net"], subject: "Re: help", text: "Thanks", deliveredTo: "Support <alias@example.com>",
    }));
    const raw = Buffer.from(message.raw, "base64url").toString("utf8");
    expect(message.alias.sendAsEmail).toBe("alias@example.com");
    expect(raw).toContain("From: Support <alias@example.com>");
    expect(raw).toContain("Reply-To: reply@example.com");
    expect(raw).toContain("Subject: Re: help");
    expect(raw).toContain("Content-Type: multipart/alternative");
    const encodedBodies = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--zeroeffect_[^\r\n]+/g)]
      .map((match) => Buffer.from(match[1]!.replace(/\r\n/g, ""), "base64").toString("utf8"));
    expect(encodedBodies.some((body) => body.includes("Team"))).toBe(true);
  });

  test("queues StreamingPull deliveries before acknowledging Pub/Sub messages", async () => {
    const events: string[] = [];
    const delivery: PubSubDelivery = {
      messageId: "gcp-1",
      data: Buffer.from(JSON.stringify({ emailAddress: "me@example.com", historyId: "h2" })).toString("base64"),
      ack: async () => { events.push("ack"); },
    };
    const queueApi = {
      enqueue: (queue: string, payload: unknown): Effect.Effect<void, RedisQueueError> => Effect.sync(() => {
        events.push(`${queue}:${JSON.stringify(payload)}`);
      }),
    };
    const transport = { streamingPull: async function* () { yield delivery; } };
    const layer = Layer.provide(PubSubListenerServiceLive(transport), Layer.succeed(RedisQueueService, queueApi));
    const listener = Effect.runSync(Effect.gen(function* () { return yield* PubSubListenerService; }).pipe(Effect.provide(layer)));
    await Effect.runPromise(listener.listen("projects/demo/subscriptions/gmail"));
    expect(events[0]).toContain('gmail:notifications:{"messageId":"gcp-1"');
    const queued = JSON.parse(events[0]!.slice("gmail:notifications:".length)) as { data: string };
    expect(JSON.parse(queued.data)).toEqual({ emailAddress: "me@example.com", historyId: "h2" });
    expect(events[1]).toBe("ack");
  });
});
