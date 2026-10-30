// Serves the web client against seeded, in-memory Personal and Work silos and a mock Gmail API,
// so the UI can be tried without connecting real accounts. Nothing is written to ./data.
//   bun run scripts/ui-demo.ts            → http://127.0.0.1:3001/
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createDevServer } from "../src/server/dev-server";
import { createApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { AccountDb, AccountDbTest, type AccountDbService } from "../src/server/services/AccountDb";
import { formatRulesFile, importInboxZeroRules } from "../src/server/services/AiRules";
import { createAiRunner } from "../src/server/services/AiRunner";
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
    if (url.pathname.endsWith("/messages/send")) {
      const { raw, threadId } = body as { raw: string; threadId?: string };
      console.log(`[mock gmail] sent into thread ${threadId}:\n${Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n")[0]}`);
      return Response.json({ id: `sent-${Date.now()}`, threadId: threadId ?? "new-thread" });
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
  const [local, domain] = email.split("@");
  await Effect.runPromise(db.replaceSendAsAliases([
    { sendAsEmail: email, displayName: accountId === "personal" ? "Me" : "Me (Work)", replyToAddress: null, signatureHtml: null, isPrimary: true, isDefault: true, verificationStatus: "unknown" },
    { sendAsEmail: `${local}+hello@${domain}`, displayName: "Hello alias", replyToAddress: null, signatureHtml: "<p>— Sent from my alias</p>", isPrimary: false, isDefault: false, verificationStatus: "accepted" },
  ]));
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
      dateTs: at, bodyMarkdown: thread.html.replace(/<[^>]+>/g, ""), bodyHtmlSanitized: thread.html,
      rawHeaders: { "message-id": `<${id}@demo.example>`, subject: thread.subject }, labels: thread.labels,
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

// A stand-in LLM: picks an offered rule whose name appears in the thread, else "Conversations: To reply".
const llm = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as { messages?: Array<{ content: string }>; response_format?: { json_schema: { schema: DemoSchema } } };
    const schema = body.response_format!.json_schema.schema;
    const offered = schema.properties.matchedRules.items.properties.ruleName.enum;
    const thread = (body.messages?.[1]?.content ?? "").toLowerCase();
    const match = offered.find((name) => name !== "Conversations" && thread.includes(name.toLowerCase().split(" ")[0]!));
    const statuses = schema.properties.conversationStatus.enum ?? [];
    const conversation = !match && offered.includes("Conversations") && statuses.includes("TO_REPLY");
    const reply = {
      reasoning: match ? `The thread mentions "${match}" (demo LLM).` : conversation ? "A person is asking something (demo LLM)." : "Nothing fits (demo LLM).",
      matchedRules: match ? [{ ruleName: match, isPrimary: true }] : conversation ? [{ ruleName: "Conversations", isPrimary: true }] : [],
      noMatchFound: !match && !conversation,
      conversationStatus: conversation ? "TO_REPLY" : null,
    };
    console.log(`[mock llm] offered ${offered.join(", ")} → ${reply.matchedRules.map((rule) => rule.ruleName).join(", ") || "no match"}`);
    return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
  },
});
type DemoSchema = { properties: { matchedRules: { items: { properties: { ruleName: { enum: string[] } } } }; conversationStatus: { enum?: Array<string | null> } } };
await Effect.runPromise(registry.upsertLlmEndpoint({
  id: "demo", name: "Demo LLM", baseUrl: `${llm.url}v1`, apiKeyEnc: vault.encrypt("demo"), modelId: "demo-model", apiMode: "chat_completions",
}));
const demoRules = (systemType: string, name: string, extra: Record<string, unknown> = {}) => ({
  name, instructions: `${name} emails`, enabled: true, automate: true, runOnThreads: false, systemType, conditionalOperator: "AND",
  actions: [{ type: "LABEL", label: name }], ...extra,
});
const { file: rulesFile } = importInboxZeroRules([
  demoRules("TO_REPLY", "To Reply", { runOnThreads: true }),
  demoRules("AWAITING_REPLY", "Awaiting Reply", { runOnThreads: true }),
  demoRules("FYI", "FYI", { runOnThreads: true }),
  demoRules("ACTIONED", "Actioned", { runOnThreads: true }),
  demoRules("NEWSLETTER", "Newsletter"),
  demoRules("RECEIPT", "Order", { actions: [{ type: "LABEL", label: "Receipts" }, { type: "MARK_READ" }] }),
  demoRules("CALENDAR", "Flight", { automate: false, actions: [{ type: "LABEL", label: "Trips" }] }),
], "demo");
for (const accountId of ["personal", "work"] as const) await Effect.runPromise(silo(accountId).writeRulesFile(formatRulesFile(rulesFile)));

const events = createAccountEventBus();
const unusedOAuth: GoogleOAuth2Api = {
  authorizationUrl: () => new URL("http://127.0.0.1/demo"),
  exchangeCode: () => Effect.die("OAuth is disabled in the UI demo."),
  refreshAccessToken: () => Effect.die("OAuth is disabled in the UI demo."),
};
const tokens = createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault });
const accountDbLayer = (accountId: string) => AccountDbTest(accountId, silos[accountId as "personal" | "work"]);
const aiRunner = createAiRunner({ registry, tokens, vault, events, gmailApiBaseUrl: `${gmail.url}gmail/v1`, accountDbLayer });
const api = createApiHandler({
  registry,
  tokens,
  events,
  vault,
  aiRunner,
  gmailApiBaseUrl: `${gmail.url}gmail/v1`,
  accountDbLayer,
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
console.log(`ZeroEffect UI demo (seeded data, mock Gmail and LLM): http://${server.hostname}:${server.port}/`);
console.log("Try: A to run AI rules, W for the audit, Y / N on the flight email's suggestion, Z to undo, \",\" for the rules screen.");
console.log("Replies: R reply, Shift+R pick the alias, Shift+A reply all; sent messages are printed here instead of being sent.");
