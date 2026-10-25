import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createGmailAccountOperations } from "../src/server/services/GmailAccountOperations";
import { RegistryDb, RegistryDbTest } from "../src/server/services/RegistryDb";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import type { GoogleOAuth2Api } from "../src/server/services/GoogleOAuth2";

const database = new Database(":memory:");
afterAll(() => database.close());

const registry = Effect.runSync(Effect.gen(function* () {
  return yield* RegistryDb;
}).pipe(Effect.provide(RegistryDbTest(database))));
const vault = OAuthTokenVault.fromKey(new Uint8Array(32).fill(19));
const tokens = (accessToken: string) => vault.encrypt({
  tokens: { accessToken, refreshToken: `${accessToken}-refresh` },
  expiresAt: Date.now() + 60 * 60_000,
});
const putAccount = (id: "personal" | "work", email: string, expiration?: number): Promise<void> =>
  Effect.runPromise(registry.upsertAccount({
    id,
    email,
    displayName: id,
    colorTheme: id === "personal" ? "blue" : "violet",
    oauthTokensEnc: tokens(`${id}-token`),
    ...(expiration === undefined ? {} : { pubsubTopic: "projects/demo/topics/gmail", watchExpirationTs: expiration }),
    createdAt: Date.now(),
  }));

const oauth: GoogleOAuth2Api = {
  authorizationUrl: () => new URL("http://localhost/"),
  exchangeCode: () => Effect.die("not used"),
  refreshAccessToken: () => Effect.die("not used"),
};

const watchRequests: Array<{ authorization: string; topicName: string }> = [];
const watchServer = Bun.serve({
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname !== "/gmail/v1/users/me/watch") return new Response("not found", { status: 404 });
    const body = await request.json() as { topicName: string };
    const authorization = request.headers.get("authorization") ?? "";
    watchRequests.push({ authorization, topicName: body.topicName });
    const expiration = String(Date.now() + 7 * 24 * 60 * 60_000);
    return Response.json({ historyId: `history-${authorization.slice(7)}`, expiration, topicName: body.topicName });
  },
});
afterAll(() => watchServer.stop(true));

describe("Gmail account watch and notification operations", () => {
  test("creates and renews account-isolated Gmail watches and persists expiration", async () => {
    watchRequests.length = 0;
    await putAccount("personal", "personal@example.com", Date.now() - 1);
    await putAccount("work", "work@example.com");
    const operations = createGmailAccountOperations({
      registry,
      oauth,
      vault,
      gmailApiBaseUrl: `${watchServer.url}gmail/v1`,
      syncAccount: async () => ({ mode: "incremental", messagesUpserted: 0, messagesDeleted: 0 }),
    });
    const topic = "projects/demo/topics/gmail";

    await operations.ensureWatch("personal", topic);
    await operations.ensureWatch("work", topic);
    await putAccount("personal", "personal@example.com", Date.now() - 1);
    await operations.renewWatches(topic);

    const personal = await Effect.runPromise(registry.getAccount("personal"));
    const work = await Effect.runPromise(registry.getAccount("work"));
    expect(personal?.pubsubTopic).toBe(topic);
    expect(personal?.watchExpirationTs).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
    expect(work?.watchExpirationTs).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
    expect(watchRequests).toEqual([
      { authorization: "Bearer personal-token", topicName: topic },
      { authorization: "Bearer work-token", topicName: topic },
      { authorization: "Bearer personal-token", topicName: topic },
    ]);
  });

  test("routes valid notifications to the matching Gmail account and leaves failures retryable", async () => {
    await putAccount("personal", "personal@example.com");
    await putAccount("work", "work@example.com");
    const calls: Array<{ accountId: string; accessToken: string }> = [];
    let failOnce = true;
    const operations = createGmailAccountOperations({
      registry,
      oauth,
      vault,
      syncAccount: async (accountId, accessToken) => {
        calls.push({ accountId, accessToken });
        if (accountId === "work" && failOnce) {
          failOnce = false;
          throw new Error("temporary Gmail sync failure");
        }
        return { mode: "incremental", messagesUpserted: 2, messagesDeleted: 1 };
      },
    });

    await expect(operations.processNotification("not-json")).resolves.toBe("ignored");
    await expect(operations.processNotification("null")).resolves.toBe("ignored");
    await expect(operations.processNotification(JSON.stringify({ emailAddress: "", historyId: "123" }))).resolves.toBe("ignored");
    await expect(operations.processNotification(JSON.stringify({ emailAddress: "nobody@example.com", historyId: "123" }))).resolves.toBe("ignored");
    const notification = JSON.stringify({ emailAddress: " WORK@example.com ", historyId: "999999" });
    await expect(operations.processNotification(notification)).rejects.toThrow("temporary Gmail sync failure");
    await expect(operations.processNotification(notification)).resolves.toBe("synced");

    expect(calls).toEqual([
      { accountId: "work", accessToken: "work-token" },
      { accountId: "work", accessToken: "work-token" },
    ]);
  });
});
