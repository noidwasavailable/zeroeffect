// Serves the web client against seeded, in-memory Personal and Work silos and a mock Gmail API,
// so the UI can be tried without connecting real accounts. Nothing is written to ./data.
//   bun run scripts/ui-demo.ts            → http://127.0.0.1:3001/
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createDevServer } from "../src/server/dev-server";
import { createApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { AccountDb, AccountDbTest, type AccountDbService } from "../src/server/services/AccountDb";
import { createGmailAccessTokenProvider } from "../src/server/services/GmailAccessTokens";
import type { GoogleOAuth2Api } from "../src/server/services/GoogleOAuth2";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbTest } from "../src/server/services/RegistryDb";
import { parseFilterDsl } from "../src/shared/filterParser";

const port = Number(process.env.PORT ?? 3001);
const vault = OAuthTokenVault.fromKey(crypto.getRandomValues(new Uint8Array(32)));

let nextLabel = 100;
const gmail = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : undefined;
    console.log(`[mock gmail] ${request.method} ${url.pathname} ${body ? JSON.stringify(body) : ""}`);
    if (url.pathname.endsWith("/labels") && request.method === "POST") {
      return Response.json({ id: `Label_${nextLabel++}`, name: (body as { name: string }).name, type: "user" });
    }
    return Response.json({});
  },
});

const registry = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(RegistryDbTest(new Database(":memory:")))));
const silos = { personal: new Database(":memory:"), work: new Database(":memory:") };
const silo = (accountId: "personal" | "work"): AccountDbService =>
  Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(AccountDbTest(accountId, silos[accountId]))));

const seed = async (accountId: "personal" | "work", email: string, threads: ReadonlyArray<{
  readonly subject: string; readonly from: string; readonly labels: ReadonlyArray<string>; readonly hoursAgo: number; readonly html: string;
}>) => {
  await Effect.runPromise(registry.upsertAccount({
    id: accountId, email, displayName: accountId === "personal" ? "Personal" : "Work",
    colorTheme: accountId === "personal" ? "blue" : "violet",
    oauthTokensEnc: vault.encrypt({ tokens: { accessToken: `demo-${accountId}` }, expiresAt: Date.now() + 24 * 3_600_000 }),
    createdAt: Date.now(),
  }));
  const db = silo(accountId);
  await Effect.runPromise(db.replaceLabels([
    { id: "INBOX", name: "INBOX", type: "system", colorBg: null, colorText: null },
    { id: "Label_1", name: "Receipts", type: "user", colorBg: "#b9e4d0", colorText: "#094228" },
    { id: "Label_2", name: "Travel", type: "user", colorBg: "#c9daf8", colorText: "#1c4587" },
    { id: "Label_3", name: "Newsletters", type: "user", colorBg: null, colorText: null },
  ]));
  for (const [index, thread] of threads.entries()) {
    const id = `${accountId}-${index}`;
    const at = Date.now() - thread.hoursAgo * 3_600_000;
    await Effect.runPromise(db.upsertThread({
      id, subject: thread.subject, senderSummary: thread.from, labels: thread.labels, snippet: thread.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
      lastMessageAt: at, isUnread: thread.labels.includes("UNREAD"), isStarred: thread.labels.includes("STARRED"),
      isArchived: !thread.labels.includes("INBOX"),
    }));
    await Effect.runPromise(db.upsertMessage({
      id: `${id}-m`, threadId: id, fromAddress: thread.from, toAddresses: [email], ccAddresses: [], deliveredTo: email,
      dateTs: at, bodyMarkdown: thread.html.replace(/<[^>]+>/g, ""), bodyHtmlSanitized: thread.html, rawHeaders: {},
    }));
  }
};

await seed("personal", "me@example.com", [
  { subject: "Your order has shipped", from: "Shop <orders@shop.example>", labels: ["INBOX", "UNREAD", "Receipts"], hoursAgo: 1, html: "<p>Your order <strong>#1042</strong> is on its way.</p><p><a href=\"https://example.com/track\">Track package</a></p>" },
  { subject: "Flight confirmation: ICN → SFO", from: "Airline <noreply@air.example>", labels: ["INBOX", "Travel", "STARRED"], hoursAgo: 5, html: "<h2>Booking confirmed</h2><table><tr><td>Departs</td><td>09:40</td></tr></table>" },
  { subject: "Weekly digest", from: "Newsletter <digest@news.example>", labels: ["INBOX", "UNREAD", "Newsletters"], hoursAgo: 30, html: "<p>Here is what happened this week…</p><blockquote>Quoted text</blockquote>" },
  { subject: "Dinner on Friday?", from: "Alex <alex@example.com>", labels: ["INBOX"], hoursAgo: 72, html: "<p>Are you free on Friday evening?</p>" },
  { subject: "Old receipt", from: "Shop <orders@shop.example>", labels: ["Receipts"], hoursAgo: 400, html: "<p>Archived receipt.</p>" },
]);
await seed("work", "me@work.example", [
  { subject: "Q4 planning doc", from: "Manager <boss@work.example>", labels: ["INBOX", "UNREAD"], hoursAgo: 2, html: "<p>Please review the Q4 plan before Thursday.</p>" },
  { subject: "Deploy finished", from: "CI <ci@work.example>", labels: ["INBOX"], hoursAgo: 8, html: "<p>Build <code>#881</code> deployed to production.</p>" },
]);

const receiptsAndTravel = parseFilterDsl('label:Receipts OR (label:Travel AND NOT is:archived)');
if (!receiptsAndTravel.ok) throw new Error(receiptsAndTravel.message);
await Effect.runPromise(silo("personal").createSavedView({ id: "v-demo", name: "Receipts & Travel", filter: receiptsAndTravel.expression }));

const events = createAccountEventBus();
const unusedOAuth: GoogleOAuth2Api = {
  authorizationUrl: () => new URL("http://127.0.0.1/demo"),
  exchangeCode: () => Effect.die("OAuth is disabled in the UI demo."),
  refreshAccessToken: () => Effect.die("OAuth is disabled in the UI demo."),
};
const api = createApiHandler({
  registry,
  tokens: createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault }),
  events,
  gmailApiBaseUrl: `${gmail.url}gmail/v1`,
  accountDbLayer: (accountId) => AccountDbTest(accountId, silos[accountId]),
});
const server = createDevServer({
  registry,
  oauth: unusedOAuth,
  api,
  events,
  encryptionKey: crypto.getRandomValues(new Uint8Array(32)),
  redirectUri: `http://127.0.0.1:${port}/auth/google/callback`,
  port,
});
console.log(`ZeroEffect UI demo (seeded data, mock Gmail): http://${server.hostname}:${server.port}/`);
