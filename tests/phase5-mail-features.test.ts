import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { createApiHandler, contentDisposition, type ApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { AccountDb, AccountDbTest, type AccountDbService } from "../src/server/services/AccountDb";
import { createGmailAccessTokenProvider, type StoredTokens } from "../src/server/services/GmailAccessTokens";
import { GmailClient, GmailClientLive, type GmailClientService } from "../src/server/services/GmailClient";
import { GmailSyncService, GmailSyncServiceLive } from "../src/server/services/GmailSyncService";
import type { GoogleOAuth2Api } from "../src/server/services/GoogleOAuth2";
import { collectAttachments, findPart, parseMimeBody, type GmailMimePart } from "../src/server/services/MimeParser";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbTest, type RegistryDbService } from "../src/server/services/RegistryDb";
import { SendAsComposerService, SendAsComposerServiceLive } from "../src/server/services/SendAsComposerService";
import { buildActions, matchesShortcut, shortcutLabel, TOOLBAR_ACTION_IDS, type ActionContext } from "../src/client/actions";
import { resolveInlineImages } from "../src/client/emailHtml";
import { formatBytes } from "../src/client/format";
import { initialFold, isMessageExpanded, revealMessage } from "../src/client/threadFolding";
import { LOCAL_REQUEST_HEADER, type AccountId, type ForwardDraft, type ThreadDetail, type ThreadMessage, type ThreadSummary } from "../src/shared/api";
import { applyThreadAction, threadActionLabels } from "../src/shared/threadActions";
import { BUILT_IN_VIEWS, orderViews } from "../src/shared/views";
import { unusedGmailExtras } from "./helpers/TestLayers";

const closeables: Array<{ close: () => void }> = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
  for (const item of closeables) item.close();
});

const serviceOf = (database: Database, accountId: string): AccountDbService =>
  Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(AccountDbTest(accountId, database))));

const b64url = (text: string) => Buffer.from(text).toString("base64url");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A Gmail message with text, HTML (one inline image) and two attachments, one of them inline in the payload. */
const richPayload: GmailMimePart = {
  partId: "",
  mimeType: "multipart/mixed",
  parts: [
    {
      partId: "0",
      mimeType: "multipart/related",
      parts: [
        {
          partId: "0.0",
          mimeType: "multipart/alternative",
          parts: [
            { partId: "0.0.0", mimeType: "text/plain", body: { data: b64url("Hello plain") } },
            { partId: "0.0.1", mimeType: "text/html", body: { data: b64url('<p>Hello <img src="cid:logo@x"></p>') } },
          ],
        },
        {
          partId: "0.1", mimeType: "image/png", filename: "logo.png",
          headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: "inline" }],
          body: { attachmentId: "att-logo", size: PNG_BYTES.byteLength },
        },
      ],
    },
    {
      partId: "1", mimeType: "application/pdf", filename: "invoice.pdf",
      headers: [{ name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' }],
      body: { attachmentId: "att-invoice", size: 2048 },
    },
    {
      partId: "2", mimeType: "text/html", filename: "page.html",
      headers: [{ name: "Content-Disposition", value: "attachment" }],
      body: { data: b64url("<script>alert(1)</script>"), size: 25 },
    },
  ],
};

describe("Phase 5: MIME attachments", () => {
  test("collects attachments (inline images included) without mixing them into the body", () => {
    expect(collectAttachments(richPayload)).toEqual([
      { partId: "0.1", filename: "logo.png", mimeType: "image/png", size: PNG_BYTES.byteLength, contentId: "logo@x", inline: true, attachmentId: "att-logo" },
      { partId: "1", filename: "invoice.pdf", mimeType: "application/pdf", size: 2048, contentId: null, inline: false, attachmentId: "att-invoice" },
      { partId: "2", filename: "page.html", mimeType: "text/html", size: 25, contentId: null, inline: false, attachmentId: null },
    ]);
    const body = parseMimeBody(richPayload);
    expect(body.bodyMarkdown).toBe("Hello plain");
    expect(body.bodyHtml).toContain("cid:logo@x");
    expect(body.bodyHtml).not.toContain("script");
    expect(findPart(richPayload, "2")?.filename).toBe("page.html");
    expect(findPart(richPayload, "0.0")).toBeNull();
  });

  test("the reader points cid: images at the attachment route and lists only the rest", () => {
    const attachments = collectAttachments(richPayload);
    const { html, referenced } = resolveInlineImages('<img src="cid:logo@x"><img src="cid:missing">', attachments, (attachment) => `/file/${attachment.partId}`);
    expect(html).toBe('<img src="/file/0.1"><img src="cid:missing">');
    expect([...referenced]).toEqual(["logo@x"]);
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(contentDisposition("attachment", "Résumé \"final\".pdf")).toBe(`attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`);
  });
});

describe("Phase 5: sending attachments and forwards", () => {
  const aliasesDb = () => {
    const database = new Database(":memory:");
    closeables.push(database);
    const db = serviceOf(database, "personal");
    Effect.runSync(db.replaceSendAsAliases([
      { sendAsEmail: "me@example.com", displayName: "Me", replyToAddress: null, signatureHtml: null, isPrimary: true, isDefault: true, verificationStatus: "accepted" },
    ]));
    return db;
  };
  const composerWith = (db: AccountDbService, gmail: GmailClientService) => Effect.runSync(Effect.gen(function* () { return yield* SendAsComposerService; }).pipe(
    Effect.provide(Layer.provide(SendAsComposerServiceLive, Layer.merge(Layer.succeed(AccountDb, db), Layer.succeed(GmailClient, gmail)))),
  ));
  const sends: Array<{ via: "raw" | "upload"; mime: string; threadId?: string }> = [];
  const gmail: GmailClientService = {
    ...unusedGmailExtras,
    getProfile: () => Effect.die("unused"), listMessages: () => Effect.die("unused"), getMessage: () => Effect.die("unused"),
    listThreads: () => Effect.die("unused"), getThread: () => Effect.die("unused"), listHistory: () => Effect.die("unused"),
    listSendAs: () => Effect.die("unused"), listLabels: () => Effect.die("unused"), createLabel: () => Effect.die("unused"),
    watch: () => Effect.die("unused"), modifyMessage: () => Effect.die("unused"), modifyThread: () => Effect.die("unused"),
    sendRaw: (raw, threadId) => Effect.sync(() => {
      sends.push({ via: "raw", mime: Buffer.from(raw, "base64url").toString(), ...(threadId ? { threadId } : {}) });
      return { id: "sent", threadId: threadId ?? "new" };
    }),
    sendMime: (mime, threadId) => Effect.sync(() => {
      sends.push({ via: "upload", mime: Buffer.from(mime).toString(), ...(threadId ? { threadId } : {}) });
      return { id: "sent", threadId: threadId ?? "new" };
    }),
  };

  test("attachments make a multipart/mixed message sent through the upload endpoint", async () => {
    sends.length = 0;
    const composer = composerWith(aliasesDb(), gmail);
    await Effect.runPromise(composer.send({ to: ["you@example.com"], subject: "Plain", text: "No files" }));
    expect(sends[0]).toMatchObject({ via: "raw" });
    expect(sends[0]!.mime).toContain("Content-Type: multipart/alternative");

    await Effect.runPromise(composer.send({
      to: ["you@example.com"], subject: "Files", text: "See attached",
      attachments: [
        { filename: "notes.txt", mimeType: "text/plain", data: new TextEncoder().encode("hello file") },
        { filename: "보고서.pdf", mimeType: "application/pdf", data: new Uint8Array([1, 2, 3]) },
      ],
    }));
    const mime = sends[1]!.mime;
    expect(sends[1]!.via).toBe("upload");
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="(zeroeffect_mixed_\w+)"/);
    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain('Content-Disposition: attachment; filename="notes.txt"');
    expect(mime).toContain(Buffer.from("hello file").toString("base64"));
    expect(mime).toContain(`filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`);
    expect(mime).not.toMatch(/[^\x00-\x7f]/);
  });

  test("forwards include Gmail's forwarded-message header, the original HTML body and kept Content-IDs", async () => {
    sends.length = 0;
    const composer = composerWith(aliasesDb(), gmail);
    await Effect.runPromise(composer.send({
      to: ["friend@example.com"], subject: "Fwd: Trip", text: "", threadId: "t-1",
      forward: {
        from: "Alice <alice@example.com>", dateTs: Date.UTC(2026, 0, 2), subject: "Trip", to: ["me@example.com"], cc: [],
        text: "Original text", html: '<html><head><style>p{}</style></head><body><p>Original <img src="cid:logo@x"></p></body></html>',
      },
      attachments: [{ filename: "logo.png", mimeType: "image/png", data: PNG_BYTES, contentId: "logo@x" }],
    }));
    const { mime, threadId } = sends[0]!;
    expect(threadId).toBe("t-1");
    const parts = mime.split(/\r\n--zeroeffect_\w+/);
    const decoded = (contentType: string) => {
      const part = parts.find((candidate) => candidate.includes(`Content-Type: ${contentType}`))!;
      return Buffer.from(part.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString();
    };
    expect(decoded("text/plain")).toBe(
      "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>\nDate: Fri, 02 Jan 2026 00:00:00 GMT\nSubject: Trip\nTo: me@example.com\n\nOriginal text",
    );
    expect(decoded("text/html")).toContain('<p>Original <img src="cid:logo@x"></p>');
    expect(decoded("text/html")).not.toContain("<head>");
    expect(mime).toContain("Content-Disposition: inline; filename=\"logo.png\"");
    expect(mime).toContain("Content-ID: <logo@x>");
  });

  test("the Gmail client uploads MIME as multipart/related to the upload endpoint", async () => {
    let seen: { path: string; query: string; contentType: string | null; body: string } | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen = { path: url.pathname, query: url.search, contentType: request.headers.get("content-type"), body: await request.text() };
        return Response.json({ id: "m-up", threadId: "t-up" });
      },
    });
    servers.push(server);
    const client = Effect.runSync(Effect.gen(function* () { return yield* GmailClient; }).pipe(
      Effect.provide(GmailClientLive({ accessToken: "token", apiBaseUrl: `${server.url}gmail/v1` })),
    ));
    expect(await Effect.runPromise(client.sendMime(new TextEncoder().encode("Subject: Hi\r\n\r\nBody"), "t-1"))).toEqual({ id: "m-up", threadId: "t-up" });
    expect(seen!.path).toBe("/upload/gmail/v1/users/me/messages/send");
    expect(seen!.query).toBe("?uploadType=multipart");
    expect(seen!.contentType).toMatch(/^multipart\/related; boundary=/);
    expect(seen!.body).toContain('{"threadId":"t-1"}');
    expect(seen!.body).toContain("Content-Type: message/rfc822\r\n\r\nSubject: Hi\r\n\r\nBody");
  });
});

describe("Phase 5: catch-up polling", () => {
  test("an incremental-only sync skips accounts that never synced and runs history.list for the rest", async () => {
    const database = new Database(":memory:");
    closeables.push(database);
    const calls: string[] = [];
    const gmail: GmailClientService = {
      ...unusedGmailExtras,
      getProfile: () => Effect.sync(() => { calls.push("profile"); return { emailAddress: "me@example.com", historyId: "10" }; }),
      listMessages: () => Effect.die("unused"), getMessage: () => Effect.die("unused"), listThreads: () => Effect.die("unused"),
      getThread: () => Effect.die("unused"),
      listHistory: (start) => Effect.sync(() => { calls.push(`history:${start}`); return { historyId: "11" }; }),
      listSendAs: () => Effect.sync(() => { calls.push("sendAs"); return []; }),
      listLabels: () => Effect.sync(() => { calls.push("labels"); return []; }),
      createLabel: () => Effect.die("unused"), watch: () => Effect.die("unused"), sendRaw: () => Effect.die("unused"),
      modifyMessage: () => Effect.die("unused"), modifyThread: () => Effect.die("unused"),
    };
    const sync = Effect.runSync(Effect.gen(function* () { return yield* GmailSyncService; }).pipe(
      Effect.provide(Layer.provide(GmailSyncServiceLive, Layer.merge(AccountDbTest("personal", database), Layer.succeed(GmailClient, gmail)))),
    ));
    expect(await Effect.runPromise(sync.sync({ incrementalOnly: true }))).toMatchObject({ skipped: true });
    expect(calls).toEqual([]);

    await Effect.runPromise(serviceOf(database, "personal").setHistoryId("10"));
    expect(await Effect.runPromise(sync.sync({ incrementalOnly: true, includeAliases: false }))).toMatchObject({ mode: "incremental", messagesUpserted: 0 });
    expect(calls).toEqual(["labels", "history:10"]);
  });
});

interface GmailCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const vault = OAuthTokenVault.fromKey(new Uint8Array(32).fill(5));
const unusedOAuth: GoogleOAuth2Api = {
  authorizationUrl: () => new URL("http://127.0.0.1/unused"),
  exchangeCode: () => Effect.die("unused"),
  refreshAccessToken: () => Effect.die("unused"),
};

/** A mock Gmail API with attachments, labels and aliases, both accounts connected, and isolated in-memory silos. */
const makeEnvironment = async () => {
  const gmailCalls: GmailCall[] = [];
  // Gmail's label catalog, changed by the label routes.
  const gmailLabels = new Map([["INBOX", { id: "INBOX", name: "INBOX", type: "system" }], ["Label_1", { id: "Label_1", name: "Bills", type: "user" }]]);
  const gmail = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      const body = text && request.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text || undefined;
      gmailCalls.push({ method: request.method, path: url.pathname, body });
      const path = url.pathname.replace(/^\/(upload\/)?gmail\/v1\/users\/me/, "");
      if (path === "/messages/batchModify" || path.endsWith("/modify")) return Response.json({});
      if (path === "/messages/send") return Response.json({ id: "sent-1", threadId: "p-1" });
      if (path === "/messages/m-1/attachments/att-invoice") return Response.json({ data: b64url("%PDF invoice"), size: 12 });
      if (path === "/messages/m-1/attachments/att-logo") return Response.json({ data: PNG_BYTES.toString("base64url"), size: PNG_BYTES.byteLength });
      if (path === "/messages/m-1") return Response.json({ id: "m-1", threadId: "p-1", payload: richPayload });
      if (path === "/labels" && request.method === "POST") {
        const label = { id: "Label_9", name: (body as { name: string }).name, type: "user" };
        gmailLabels.set(label.id, label);
        return Response.json(label);
      }
      if (path === "/labels/Label_1" && request.method === "PATCH") {
        const label = { id: "Label_1", name: (body as { name: string }).name, type: "user" };
        gmailLabels.set(label.id, label);
        return Response.json(label);
      }
      if (path === "/labels/Label_1" && request.method === "DELETE") {
        gmailLabels.delete("Label_1");
        return new Response(null, { status: 204 });
      }
      if (path === "/labels") return Response.json({ labels: [...gmailLabels.values()] });
      if (path === "/settings/sendAs") {
        return Response.json({ sendAs: [
          { sendAsEmail: "me@example.com", displayName: "Me", isPrimary: true, isDefault: true },
          { sendAsEmail: "pending@example.com", displayName: "Pending", verificationStatus: "pending" },
        ] });
      }
      return Response.json({ error: `unexpected ${request.method} ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(gmail);

  const registryDatabase = new Database(":memory:");
  closeables.push(registryDatabase);
  const registry: RegistryDbService = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(RegistryDbTest(registryDatabase))));
  for (const [id, email] of [["personal", "me@example.com"], ["work", "me@work.example"]] as const) {
    await Effect.runPromise(registry.upsertAccount({
      id, email, displayName: id, colorTheme: "blue", createdAt: Date.now(),
      oauthTokensEnc: vault.encrypt({ tokens: { accessToken: `token-${id}` }, expiresAt: Date.now() + 3_600_000 } satisfies StoredTokens),
    }));
  }
  const silos = { personal: new Database(":memory:"), work: new Database(":memory:") };
  closeables.push(silos.personal, silos.work);
  const personal = serviceOf(silos.personal, "personal");
  const work = serviceOf(silos.work, "work");
  await Effect.runPromise(personal.replaceLabels([
    { id: "INBOX", name: "INBOX", type: "system", colorBg: null, colorText: null },
    { id: "Label_1", name: "Bills", type: "user", colorBg: null, colorText: null },
  ]));
  await Effect.runPromise(personal.replaceSendAsAliases([
    { sendAsEmail: "me@example.com", displayName: "Me", replyToAddress: null, signatureHtml: null, isPrimary: true, isDefault: true, verificationStatus: "accepted" },
  ]));
  const seed = async (db: AccountDbService, id: string, messages: ReadonlyArray<{ id: string; labels: string[]; at: number; attachments?: boolean }>) => {
    for (const message of messages) {
      await Effect.runPromise(db.upsertThread({
        id, subject: `Subject ${id}`, senderSummary: "Alice <alice@example.com>", labels: message.labels, snippet: "", lastMessageAt: message.at,
        isUnread: message.labels.includes("UNREAD"), isStarred: false, isArchived: !message.labels.includes("INBOX"),
      }));
      await Effect.runPromise(db.upsertMessage({
        id: message.id, threadId: id, fromAddress: "Alice <alice@example.com>", toAddresses: ["me@example.com"], ccAddresses: [],
        deliveredTo: null, dateTs: message.at, bodyMarkdown: `Body ${message.id}`, bodyHtmlSanitized: "", bodyHtml: null,
        rawHeaders: { subject: `Subject ${id}`, "message-id": `<${message.id}@mail>` }, labels: message.labels,
        // Without `attachments` the message looks like one stored before attachments were recorded.
        ...(message.attachments === false ? { attachments: [] } : {}),
      }));
      await Effect.runPromise(db.refreshThreadLabelsFromMessages(id));
    }
  };
  // p-1: an unread thread whose message (m-1) has attachments not yet recorded locally.
  await seed(personal, "p-1", [{ id: "m-1", labels: ["INBOX", "UNREAD"], at: 300 }]);
  await seed(personal, "p-2", [
    { id: "m-2a", labels: ["INBOX"], at: 100, attachments: false },
    { id: "m-2b", labels: ["INBOX", "UNREAD"], at: 200, attachments: false },
  ]);
  await seed(personal, "p-3", [{ id: "m-3", labels: ["INBOX"], at: 50, attachments: false }]);
  await seed(work, "w-1", [{ id: "w-m", labels: ["INBOX", "UNREAD"], at: 10, attachments: false }]);

  const events = createAccountEventBus();
  const sent: string[] = [];
  const api: ApiHandler = createApiHandler({
    registry,
    tokens: createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault }),
    events,
    gmailApiBaseUrl: `${gmail.url}gmail/v1`,
    accountDbLayer: (accountId: AccountId) => AccountDbTest(accountId, silos[accountId]),
    onReplySent: (accountId) => sent.push(accountId),
  });
  const server = Bun.serve({ port: 0, fetch: async (request) => (await api.handle(request, new URL(request.url))) ?? new Response("Not found", { status: 404 }) });
  servers.push(server);
  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, server.url), init);
  const send = (method: string, path: string, body?: unknown) => call(path, {
    method,
    headers: { "Content-Type": "application/json", [LOCAL_REQUEST_HEADER]: "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const thread = async (id: string) => ((await (await call(`/api/a/personal/threads/${id}`)).json()) as { thread: ThreadDetail }).thread;
  return { api, events, personal, work, gmailCalls, sent, call, send, thread };
};

describe("Phase 5: attachment, bulk, forward, label and alias routes", () => {
  let env: Awaited<ReturnType<typeof makeEnvironment>>;
  beforeEach(async () => {
    env = await makeEnvironment();
  });

  test("records attachments of older messages when their thread opens, then serves them safely", async () => {
    const { messages } = await env.thread("p-1");
    expect(messages[0]!.attachments.map((attachment) => [attachment.partId, attachment.filename, attachment.inline])).toEqual([
      ["0.1", "logo.png", true], ["1", "invoice.pdf", false], ["2", "page.html", false],
    ]);
    expect(messages[0]!.attachments[0]).not.toHaveProperty("attachmentId");
    expect(env.gmailCalls.map((call) => call.path)).toEqual(["/gmail/v1/users/me/messages/m-1"]);
    // Recorded: opening again costs no Gmail request.
    await env.thread("p-1");
    expect(env.gmailCalls).toHaveLength(1);

    const pdf = await env.call("/api/a/personal/messages/m-1/attachments/1");
    expect(pdf.status).toBe(200);
    expect(await pdf.text()).toBe("%PDF invoice");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toStartWith('attachment; filename="invoice.pdf"');
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdf.headers.get("content-security-policy")).toContain("sandbox");

    // Raster images may display inline; HTML is always a download (and its data came inline in the payload).
    const logo = await env.call("/api/a/personal/messages/m-1/attachments/0.1?inline=1");
    expect(logo.headers.get("content-disposition")).toStartWith("inline;");
    expect(Buffer.from(await logo.arrayBuffer())).toEqual(PNG_BYTES);
    const page = await env.call("/api/a/personal/messages/m-1/attachments/2?inline=1");
    expect(page.headers.get("content-disposition")).toStartWith("attachment;");
    expect(await page.text()).toBe("<script>alert(1)</script>");

    // Other accounts' messages and unknown parts are not found.
    expect((await env.call("/api/a/work/messages/m-1/attachments/1")).status).toBe(404);
    expect((await env.call("/api/a/personal/messages/m-1/attachments/9")).status).toBe(404);
  });

  test("bulk actions batch-modify only the messages they change, and mark-all-read covers the whole view", async () => {
    const archived = await env.send("POST", "/api/a/personal/threads/bulk", { action: { type: "archive" }, threadIds: ["p-1", "p-2", "w-1", "nope"] });
    expect(await archived.json()).toEqual({ threadsUpdated: 2, messagesUpdated: 3 });
    expect(env.gmailCalls).toEqual([
      { method: "POST", path: "/gmail/v1/users/me/messages/batchModify", body: { ids: ["m-1", "m-2a", "m-2b"], addLabelIds: [], removeLabelIds: ["INBOX"] } },
    ]);
    expect(await Effect.runPromise(env.personal.getThread("p-2"))).toMatchObject({ isArchived: true, labels: ["UNREAD"] });
    // The work silo is untouched.
    expect(await Effect.runPromise(env.work.getThread("w-1"))).toMatchObject({ isArchived: false });

    env.gmailCalls.length = 0;
    const read = await env.send("POST", "/api/a/personal/threads/bulk", { action: { type: "markRead" }, view: "all" });
    expect(await read.json()).toEqual({ threadsUpdated: 2, messagesUpdated: 2 });
    expect(env.gmailCalls).toEqual([
      { method: "POST", path: "/gmail/v1/users/me/messages/batchModify", body: { ids: ["m-1", "m-2b"], addLabelIds: [], removeLabelIds: ["UNREAD"] } },
    ]);
    const unread = await (await env.call("/api/a/personal/threads?view=all&q=is:unread")).json() as { threads: ThreadSummary[] };
    expect(unread.threads).toEqual([]);

    // Nothing left to change: no Gmail request at all.
    env.gmailCalls.length = 0;
    expect(await (await env.send("POST", "/api/a/personal/threads/bulk", { action: { type: "markRead" }, view: "all" })).json())
      .toEqual({ threadsUpdated: 0, messagesUpdated: 0 });
    expect(env.gmailCalls).toEqual([]);
    expect((await env.send("POST", "/api/a/personal/threads/bulk", { action: { type: "explode" }, threadIds: ["p-1"] })).status).toBe(400);
    expect((await env.send("POST", "/api/a/personal/threads/bulk", { action: { type: "archive" }, view: "nope" })).status).toBe(404);
  });

  test("trash and spam are thread actions with their own views", async () => {
    const trashed = await env.send("POST", "/api/a/personal/threads/p-3/actions", { type: "trash" });
    expect(await trashed.json()).toMatchObject({ thread: { labels: ["TRASH"], isArchived: true } });
    expect(env.gmailCalls.at(-1)).toMatchObject({ path: "/gmail/v1/users/me/threads/p-3/modify", body: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] } });
    const trash = await (await env.call("/api/a/personal/threads?view=trash")).json() as { threads: ThreadSummary[] };
    expect(trash.threads.map((thread) => thread.id)).toEqual(["p-3"]);
    const all = await (await env.call("/api/a/personal/threads?view=all")).json() as { threads: ThreadSummary[] };
    expect(all.threads.map((thread) => thread.id)).not.toContain("p-3");
    await env.send("POST", "/api/a/personal/threads/p-3/actions", { type: "untrash" });
    expect(await Effect.runPromise(env.personal.getThread("p-3"))).toMatchObject({ labels: ["INBOX"] });

    expect(threadActionLabels({ type: "spam" })).toEqual({ add: ["SPAM"], remove: ["INBOX", "TRASH"] });
    expect(threadActionLabels({ type: "notSpam" })).toEqual({ add: ["INBOX"], remove: ["SPAM"] });
  });

  test("forwards the newest message with its attachments, minus the ones left out", async () => {
    const draft = ((await (await env.call("/api/a/personal/threads/p-1/forward")).json()) as { draft: ForwardDraft }).draft;
    expect(draft).toMatchObject({ messageId: "m-1", subject: "Fwd: Subject p-1", fromAlias: "me@example.com" });
    expect(draft.attachments.map((attachment) => attachment.filename)).toEqual(["logo.png", "invoice.pdf", "page.html"]);

    env.gmailCalls.length = 0;
    const response = await env.send("POST", "/api/a/personal/threads/p-1/forward", {
      messageId: "m-1", to: ["friend@example.com"], cc: [], bcc: [], subject: draft.subject, body: "FYI", fromAlias: "me@example.com",
      excludeAttachments: ["2"],
      attachments: [{ filename: "extra.txt", mimeType: "text/plain", dataBase64: Buffer.from("extra").toString("base64") }],
    });
    expect(response.status).toBe(200);
    const upload = env.gmailCalls.find((call) => call.path === "/upload/gmail/v1/users/me/messages/send")!;
    const body = upload.body as string;
    expect(body).toContain('{"threadId":"p-1"}');
    expect(body).toContain("In-Reply-To: <m-1@mail>");
    for (const name of ["logo.png", "invoice.pdf", "extra.txt"]) expect(body).toContain(`filename="${name}"`);
    expect(body).not.toContain("page.html");
    expect(body).toContain(b64url("%PDF invoice").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""));
    expect(env.sent).toEqual(["personal"]);

    const tooBig = await env.send("POST", "/api/a/personal/messages", {
      to: ["friend@example.com"], cc: [], bcc: [], subject: "Big", body: "x", fromAlias: "me@example.com",
      attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", dataBase64: Buffer.alloc(26 * 1024 * 1024).toString("base64") }],
    });
    expect(tooBig.status).toBe(400);
  });

  test("creates, renames and deletes labels in Gmail and the silo; refreshes Send As aliases", async () => {
    expect((await env.send("POST", "/api/a/personal/labels", { name: "bills" })).status).toBe(409);
    const created = await env.send("POST", "/api/a/personal/labels", { name: "Travel" });
    expect(await created.json()).toMatchObject({ label: { id: "Label_9", name: "Travel", type: "user" } });
    expect(env.gmailCalls.at(-1)).toMatchObject({ method: "POST", path: "/gmail/v1/users/me/labels", body: { name: "Travel" } });

    await env.send("POST", "/api/a/personal/threads/p-3/actions", { type: "setLabels", add: ["Bills"], remove: [] });
    const renamed = await env.send("PATCH", "/api/a/personal/labels/Label_1", { name: "Invoices" });
    expect(renamed.status).toBe(200);
    expect(await Effect.runPromise(env.personal.getThread("p-3"))).toMatchObject({ labels: ["INBOX", "Invoices"] });

    const deleted = await env.send("DELETE", "/api/a/personal/labels/Label_1");
    expect(deleted.status).toBe(200);
    expect((await Effect.runPromise(env.personal.getThread("p-3")))!.labels).toEqual(["INBOX"]);
    expect((await Effect.runPromise(env.personal.listLabels())).map((label) => label.name).sort()).toEqual(["INBOX", "Travel"]);
    expect((await env.send("PATCH", "/api/a/personal/labels/INBOX", { name: "Mine" })).status).toBe(400);

    const aliases = await (await env.send("POST", "/api/a/personal/aliases/refresh", {})).json() as { aliases: Array<{ sendAsEmail: string; sendable: boolean }> };
    expect(aliases.aliases.map((alias) => [alias.sendAsEmail, alias.sendable])).toEqual([["me@example.com", true], ["pending@example.com", false]]);
    expect(await (await env.call("/api/a/personal/aliases")).json()).toEqual(aliases);
  });
});

describe("Phase 5: commands, bulk targets and views", () => {
  const thread = (id: string, labels: string[]): ThreadSummary => ({
    id, subject: id, snippet: "", senderSummary: "a@example.com", lastMessageAt: 1, labels, ghostLabels: [],
    isUnread: labels.includes("UNREAD"), isStarred: labels.includes("STARRED"), isArchived: !labels.includes("INBOX"), aiStatus: "pending", otpCode: null,
  });
  const calls: string[] = [];
  const noop = (name: string) => () => { calls.push(name); };
  const base: ActionContext = {
    accounts: [{ id: "personal", email: "me@example.com", displayName: "Personal", colorTheme: "blue" }],
    accountId: "personal", views: orderViews([{ id: "v-1", name: "Bills", dsl: "label:Bills", builtIn: false }]), viewId: "inbox",
    selectedThread: thread("t1", ["INBOX", "UNREAD"]), targets: [thread("t1", ["INBOX", "UNREAD"])],
    checkedCount: 0, loadedCount: 2, viewName: "Inbox", searchActive: false, selectedOtpCode: null, threadOpen: false,
    canSelectNext: true, canSelectPrevious: true, syncing: false, builderOpen: false, auditOpen: false, composerOpen: false, aiBusy: false,
    rules: [], savedViewPosition: null, openMessageCount: 3, allMessagesExpanded: false, newMessageOpen: false,
    moveSelection: noop("move"), moveSelectionTo: (position) => calls.push(`to:${position}`), moveMessage: (delta) => calls.push(`message:${delta}`),
    toggleChecked: noop("check"), checkAll: noop("check-all"), clearChecked: noop("clear"), markAllRead: noop("mark-all-read"),
    openForward: noop("forward"), openInGmail: noop("gmail"), copyLink: noop("copy-link"), openLabelJump: noop("jump"),
    openLabelManager: noop("manage"), openAliases: noop("aliases"), refreshAliases: noop("refresh-aliases"), toggleHelp: noop("help"),
    openSelectedThread: noop("open"), closeThread: noop("close"), focusSearch: noop("search"),
    runThreadAction: (action) => calls.push(`action:${action.type}`), copyOtp: noop("otp"), toggleExpandAll: noop("expand"),
    openNewMessage: noop("new"), sendNewMessage: noop("send-new"), discardNewMessage: noop("discard-new"), openSetup: noop("setup"),
    openLabelPicker: noop("labels"), switchAccount: noop("switch"), goToView: (id) => calls.push(`view:${id}`), sync: noop("sync"),
    toggleBuilder: noop("builder"), saveView: noop("save"), editView: noop("edit"), deleteView: noop("delete"), moveView: noop("move-view"),
    runAi: noop("ai"), decideGhostLabels: noop("ghost"), toggleAudit: noop("audit"), undoAi: noop("undo"), openRules: noop("rules"),
    toggleRuleDryRun: noop("dry"), openComposer: noop("reply"), changeAlias: noop("alias"), sendReply: noop("send"), discardReply: noop("discard"),
  };
  const key = (actions: ReturnType<typeof buildActions>, pressed: string) =>
    actions.find((action) => action.shortcut && matchesShortcut({ key: pressed, code: "", altKey: false, metaKey: false, ctrlKey: false }, action.shortcut));

  test("new commands have their keys, and every shortcut is still unique", () => {
    const actions = buildActions(base);
    const shortcuts = actions.flatMap((action) => action.shortcut ? [`${action.shortcut.alt ? "alt+" : ""}${action.shortcut.key}`] : []);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    const expected: Record<string, string> = {
      "#": "thread.trash", "!": "thread.spam", F: "thread.forward", O: "thread.openInGmail", Y: "thread.copyLink",
      " ": "selection.toggle", "*": "selection.all", X: "selection.clear", U: "view.markAllRead", L: "labels.jump",
      "{": "navigation.first", "}": "navigation.last", "]": "navigation.nextMessage", "[": "navigation.previousMessage", "?": "help.shortcuts",
    };
    for (const [pressed, id] of Object.entries(expected)) expect(key(actions, pressed)?.id).toBe(id);
    calls.length = 0;
    for (const pressed of ["}", "]", "U", "F", "?"]) key(actions, pressed)!.run();
    expect(calls).toEqual(["to:last", "message:1", "mark-all-read", "forward", "help"]);
    // The toolbar has an Open button (and the new mail actions).
    for (const id of ["navigation.open", "thread.trash", "thread.forward", "view.markAllRead"]) expect(TOOLBAR_ACTION_IDS).toContain(id as never);
    expect(actions.find((action) => action.id === "navigation.open")).toMatchObject({ label: "Open", enabled: true, shortcut: { key: "o" } });
    expect(shortcutLabel({ key: " " })).toBe("Space");
    // With a conversation open, o closes it (the same action, so the toolbar button flips too).
    const reading = buildActions({ ...base, threadOpen: true });
    expect(reading.find((action) => action.id === "navigation.open")).toMatchObject({ label: "Close", enabled: true });
    calls.length = 0;
    key(reading, "o")!.run();
    expect(calls).toEqual(["open"]);
  });

  test("digit keys skip Trash and Spam, which stay reachable from the palette", () => {
    const actions = buildActions(base);
    expect(key(actions, "6")?.id).toBe("views.go.v-1");
    expect(key(actions, "7")).toBeUndefined();
    expect(actions.find((action) => action.id === "views.go.trash")).toMatchObject({ label: "Go to Trash" });
    expect(base.views.map((view) => view.id)).toEqual(["inbox", "unread", "starred", "sent", "all", "v-1", "trash", "spam"]);
    expect(BUILT_IN_VIEWS.filter((view) => view.secondary).map((view) => view.id)).toEqual(["trash", "spam"]);
  });

  test("the current view's digit key clears an active search", () => {
    const viewKey = (searchActive: boolean) => key(buildActions({ ...base, searchActive }), "1")!;
    expect(viewKey(false)).toMatchObject({ id: "views.go.inbox", enabled: false });
    expect(viewKey(true)).toMatchObject({ id: "views.go.inbox", enabled: true });
    calls.length = 0;
    viewKey(true).run();
    expect(calls).toEqual(["view:inbox"]);
  });

  test("Esc closes the AI audit drawer, then the filter builder, then the reader", () => {
    const esc = (overrides: Partial<ActionContext>) => key(buildActions({ ...base, ...overrides }), "Escape")!;
    expect(esc({}).enabled).toBe(false);
    calls.length = 0;
    esc({ auditOpen: true, builderOpen: true, threadOpen: true }).run();
    esc({ builderOpen: true, threadOpen: true }).run();
    esc({ threadOpen: true }).run();
    expect(calls).toEqual(["audit", "builder", "close"]);
    expect(esc({ auditOpen: true }).label).toBe("Close AI audit");
  });

  test("with checked threads, thread actions describe and act on all of them", () => {
    const targets = [thread("t1", ["INBOX", "UNREAD"]), thread("t2", ["INBOX", "STARRED"])];
    const actions = buildActions({ ...base, targets, checkedCount: 2 });
    const byId = (id: string) => actions.find((action) => action.id === id)!;
    expect(byId("thread.archive").label).toBe("Archive (2)");
    expect(byId("thread.toggleRead").label).toBe("Mark as read (2)");
    expect(byId("thread.toggleStar").label).toBe("Star (2)");
    expect(byId("ai.run")).toMatchObject({ label: "Run AI (2)", enabled: true, shortcut: { key: "a" } });
    expect(byId("selection.clear").enabled).toBe(true);
    expect(byId("selection.all")).toMatchObject({ label: "Check all loaded threads (2)", enabled: false });
    const trashed = buildActions({ ...base, targets: targets.map((target) => applyThreadAction(target, { type: "trash" })), checkedCount: 2 });
    expect(trashed.find((action) => action.id === "thread.trash")!.label).toBe("Restore from Trash (2)");
    expect(trashed.find((action) => action.id === "thread.archive")!.label).toBe("Move to Inbox (2)");
    calls.length = 0;
    trashed.find((action) => action.id === "thread.trash")!.run();
    expect(calls).toEqual(["action:untrash"]);
    const none = buildActions({ ...base, selectedThread: null, targets: [] });
    expect(none.find((action) => action.id === "thread.archive")!.enabled).toBe(false);
    expect(none.find((action) => action.id === "ai.run")!.enabled).toBe(false);
  });

  test("moving between messages expands the one reached and reveals hidden runs", () => {
    const messages: ThreadMessage[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id, fromAddress: id, toAddresses: [], ccAddresses: [], deliveredTo: null, dateTs: 1, bodyMarkdown: id,
      bodyHtmlSanitized: "", bodyHtml: null, isUnread: false, attachments: [],
    }));
    const fold = revealMessage(initialFold("t"), messages, 2);
    expect(fold.revealed).toBe(true);
    expect(isMessageExpanded(fold, messages, 2)).toBe(true);
    expect(revealMessage(fold, messages, 2)).toEqual(fold);
  });
});
