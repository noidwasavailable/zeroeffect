import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { afterAll, describe, expect, test } from "bun:test";
import { RegistryDb, RegistryDbTest } from "../src/server/services/RegistryDb";
import { GoogleOAuth2, GoogleOAuth2Live } from "../src/server/services/GoogleOAuth2";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { createDevServer } from "../src/server/dev-server";

const temporaryDirectories: string[] = [];
const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterAll(async () => {
  for (const server of servers) server.stop(true);
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

describe("local account setup", () => {
  test("encrypts credentials and rejects tampered token envelopes", () => {
    const vault = OAuthTokenVault.fromKey(new Uint8Array(32).fill(7));
    const token = { accessToken: "sensitive", refreshToken: "also-sensitive" };
    const encrypted = vault.encrypt(token);
    expect(new TextDecoder().decode(encrypted)).not.toContain(token.accessToken);
    expect(vault.decrypt(encrypted)).toEqual(token);
    const tampered = new Uint8Array(encrypted);
    tampered.set([tampered.at(-1)! ^ 1], tampered.length - 1);
    expect(() => vault.decrypt(tampered)).toThrow();
  });

  test("binds an OAuth callback to its browser state and syncs into the account silo", async () => {
    const tokenRequests: URLSearchParams[] = [];
    const provider = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/token" && request.method === "POST") {
          tokenRequests.push(new URLSearchParams(await request.text()));
          return Response.json({ access_token: "local-access", refresh_token: "local-refresh", expires_in: 3600 });
        }
        if (request.headers.get("authorization") !== "Bearer local-access") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (url.pathname === "/gmail/v1/users/me/profile") {
          return Response.json({ emailAddress: "personal@example.test", historyId: "history-1" });
        }
        if (url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [] });
        if (url.pathname === "/gmail/v1/users/me/settings/sendAs") {
          return Response.json({ sendAs: [{ sendAsEmail: "personal@example.test", isPrimary: true, verificationStatus: "accepted" }] });
        }
        return Response.json({ error: `unexpected request: ${url.pathname}` }, { status: 404 });
      },
    });
    servers.push(provider);

    const workDirectory = await mkdtemp(join(tmpdir(), "zeroeffect-auth-test-"));
    temporaryDirectories.push(workDirectory);
    const registryDatabase = new Database(":memory:");
    const registryLayer = RegistryDbTest(registryDatabase);
    const registry = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(registryLayer)));
    const oauthLayer = GoogleOAuth2Live({
      clientId: "local-client",
      clientSecret: "local-secret",
      redirectUri: "http://127.0.0.1:3000/auth/google/callback",
      authorizationEndpoint: `${provider.url}authorize`,
      tokenEndpoint: `${provider.url}token`,
    });
    const oauth = Effect.runSync(Effect.gen(function* () { return yield* GoogleOAuth2; }).pipe(Effect.provide(oauthLayer)));
    const app = createDevServer({
      registry,
      oauth,
      encryptionKey: new Uint8Array(32).fill(9),
      accountDataDirectory: workDirectory,
      gmailApiBaseUrl: `${provider.url}gmail/v1`,
      port: 0,
    });
    servers.push(app);

    const page = await fetch(app.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect Gmail accounts");

    const start = await fetch(new URL("/auth/google/start?accountId=personal", app.url), { redirect: "manual" });
    expect(start.status).toBe(302);
    const authorizationUrl = new URL(start.headers.get("location")!);
    const state = authorizationUrl.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const badCookieCallback = await fetch(new URL(`/auth/google/callback?code=offline-code&state=${encodeURIComponent(state)}`, app.url), {
      headers: { cookie: "ze_oauth_state=incorrect" },
      redirect: "manual",
    });
    expect(badCookieCallback.status).toBe(400);
    expect(tokenRequests).toHaveLength(0);

    const callback = await fetch(new URL(`/auth/google/callback?code=offline-code&state=${encodeURIComponent(state)}`, app.url), {
      headers: { cookie },
      redirect: "manual",
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toContain("connected=personal");
    expect(tokenRequests[0]?.get("client_secret")).toBe("local-secret");

    const accountResponse = await fetch(new URL("/api/accounts", app.url));
    expect(await accountResponse.json()).toEqual({
      accounts: [{ id: "personal", email: "personal@example.test", displayName: "Personal", colorTheme: "blue" }],
    });

    const origin = new URL(app.url).origin;
    const deniedSync = await fetch(new URL("/api/accounts/personal/sync", app.url), { method: "POST" });
    expect(deniedSync.status).toBe(403);
    const sync = await fetch(new URL("/api/accounts/personal/sync", app.url), {
      method: "POST",
      headers: { Origin: origin, "X-ZeroEffect-Local": "1" },
    });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ mode: "initial", messagesUpserted: 0, messagesDeleted: 0 });

    const accountDatabase = new Database(join(workDirectory, "personal.sqlite"));
    try {
      expect((accountDatabase.prepare("SELECT history_id FROM gmail_sync_state WHERE id = 1").get() as { history_id: string }).history_id).toBe("history-1");
      expect((accountDatabase.prepare("SELECT COUNT(*) AS count FROM send_as_aliases").get() as { count: number }).count).toBe(1);
    } finally {
      accountDatabase.close();
      registryDatabase.close();
    }
  });
});
