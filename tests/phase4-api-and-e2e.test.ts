import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createDevServer } from "../src/server/dev-server";
import { createApiHandler, type ApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { AccountDb, AccountDbTest, type AccountDbService } from "../src/server/services/AccountDb";
import { BooleanFilter, BooleanFilterLive } from "../src/server/services/BooleanFilter";
import { createGmailAccessTokenProvider, type StoredTokens } from "../src/server/services/GmailAccessTokens";
import type { GoogleOAuth2Api } from "../src/server/services/GoogleOAuth2";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbTest, type RegistryDbService } from "../src/server/services/RegistryDb";
import {
  buildActions,
  matchesShortcut,
  shortcutLabel,
  TOOLBAR_ACTION_IDS,
  type ActionContext,
} from "../src/client/actions";
import { appendChild, fromBuilder, newCondition, removeNode, toBuilder, updateNode } from "../src/client/filterBuilderModel";
import { parseRoute, routePath } from "../src/client/router";
import { LOCAL_REQUEST_HEADER, type AccountId, type ThreadDetail, type ThreadPage, type ThreadSummary } from "../src/shared/api";
import { formatFilterExpr } from "../src/shared/filterDsl";
import { parseFilterDsl } from "../src/shared/filterParser";
import type { FilterExpr } from "../src/shared/schemas";
import { applyThreadAction } from "../src/shared/threadActions";
import { BUILT_IN_VIEWS } from "../src/shared/views";

const booleanFilter = Effect.runSync(Effect.gen(function* () { return yield* BooleanFilter; }).pipe(Effect.provide(BooleanFilterLive)));
const parse = (dsl: string): FilterExpr => Effect.runSync(booleanFilter.parse(dsl));
const serviceOf = (database: Database, accountId: string): AccountDbService =>
  Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(AccountDbTest(accountId, database))));

const closeables: Array<{ close: () => void }> = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
  for (const item of closeables) item.close();
});

describe("Phase 4: shared filter DSL formatting", () => {
  const expressions = [
    "is:unread",
    "label:INBOX AND is:unread",
    'is:unread AND (label:"Label A" OR label:"Label B" OR label:"Label C") AND NOT from:"noreply@"',
    "NOT (is:starred OR is:archived)",
    "NOT NOT label:x",
    '(label:a AND label:b) OR (label:c AND NOT label:d)',
    'subject:"quote \\" and \\\\ slash" OR from:"(paren)"',
    "label:A OR label:B AND label:C",
  ];

  test.each(expressions)("formatting %p parses back to the same AST", (dsl) => {
    const expression = parse(dsl);
    expect(parse(formatFilterExpr(expression))).toEqual(expression);
  });

  test("keeps nested same-operator groups and quotes values containing DSL syntax", () => {
    const nested: FilterExpr = {
      _tag: "And",
      expressions: [
        { _tag: "And", expressions: [{ _tag: "Label", value: "Label A" }, { _tag: "Is", value: "read" }] },
        { _tag: "Contains", field: "subject", value: "weekly (draft)" },
      ],
    };
    expect(formatFilterExpr(nested)).toBe('(label:"Label A" AND is:read) AND subject:"weekly (draft)"');
    expect(parse(formatFilterExpr(nested))).toEqual(nested);
  });
});

describe("Phase 4: shared parser and visual filter builder", () => {
  test("the browser-side parser reports the same errors and offsets as BooleanFilter", () => {
    for (const dsl of ["is:unread AND (", 'label:"open', "is:sleepy", "from:"]) {
      const shared = parseFilterDsl(dsl);
      const server = Effect.runSync(Effect.flip(booleanFilter.parse(dsl)));
      expect(shared).toEqual({ ok: false, message: server.message, offset: server.offset });
    }
    expect(parseFilterDsl("label:A OR label:B")).toEqual({ ok: true, expression: parse("label:A OR label:B") });
  });

  const expressions = [
    "is:unread",
    'is:unread AND (label:"Label A" OR label:"Label B" OR label:"Label C") AND NOT from:"noreply@"',
    "NOT (is:starred OR is:archived)",
    "(label:a AND label:b) OR (label:c AND NOT label:d)",
    'subject:"weekly (draft)" AND NOT (from:boss OR label:Later)',
  ];
  test.each(expressions)("builder tree for %p converts back to the same AST", (dsl) => {
    expect(fromBuilder(toBuilder(parse(dsl)))).toEqual({ ok: true, expression: parse(dsl) });
  });

  test("double negation collapses and an empty builder means no filter", () => {
    expect(fromBuilder(toBuilder(parse("NOT NOT label:x")))).toEqual({ ok: true, expression: parse("label:x") });
    expect(fromBuilder(toBuilder(null))).toEqual({ ok: true, expression: null });
  });

  test("edits produce DSL, and incomplete conditions block conversion until filled in", () => {
    let tree = toBuilder(parse("is:unread"));
    const condition = newCondition("label");
    tree = appendChild(tree, tree.id, condition);
    expect(fromBuilder(tree)).toEqual({ ok: false, nodeId: condition.id, error: "Enter a value." });
    tree = updateNode(tree, condition.id, (node) => ({ ...node, value: "Label A", negated: true }));
    tree = updateNode(tree, tree.id, (node) => ({ ...node, operator: "Or" }));
    const built = fromBuilder(tree);
    expect(built.ok && built.expression && formatFilterExpr(built.expression)).toBe('is:unread OR NOT label:"Label A"');
    tree = removeNode(tree, condition.id);
    expect(fromBuilder(tree)).toEqual({ ok: true, expression: parse("is:unread") });
    const emptyGroup = { ...toBuilder(null), id: "inner" };
    expect(fromBuilder(appendChild(toBuilder(null), toBuilder(null).id, emptyGroup)).ok).toBe(true);
  });
});

describe("Phase 4: label renames reach saved views and AI rules", () => {
  test("rewrites saved view ASTs and DSL, rule preconditions and rule actions", async () => {
    const database = new Database(":memory:");
    closeables.push(database);
    const db = serviceOf(database, "personal");
    await Effect.runPromise(db.replaceLabels([{ id: "Label_1", name: "Receipts", type: "user", colorBg: null, colorText: null }]));
    const viewAst = parse('label:receipts OR (is:unread AND label:"Other")');
    database.prepare("INSERT INTO saved_views (id, name, sort_order, filter_ast_json, dsl_string) VALUES ('v', 'Money', 1, ?, ?)")
      .run(JSON.stringify(viewAst), formatFilterExpr(viewAst));
    database.prepare(`INSERT INTO ai_rules (id, name, precondition_ast_json, system_prompt, actions_json, llm_endpoint_id)
      VALUES ('r', 'Receipts', ?, '', ?, 'e')`).run(
      JSON.stringify(parse("NOT label:Receipts")),
      JSON.stringify({ addLabels: ["Receipts"], removeLabels: ["Other"], archive: true }),
    );

    await Effect.runPromise(db.replaceLabels([{ id: "Label_1", name: "Finance/Receipts", type: "user", colorBg: null, colorText: null }]));

    expect(await Effect.runPromise(db.listSavedViews())).toEqual([
      { id: "v", name: "Money", dsl: "label:Finance/Receipts OR (is:unread AND label:Other)", builtIn: false },
    ]);
    const rule = database.prepare("SELECT precondition_ast_json AS ast, actions_json AS actions FROM ai_rules").get() as { ast: string; actions: string };
    expect(JSON.parse(rule.ast)).toEqual(parse('NOT label:"Finance/Receipts"'));
    expect(JSON.parse(rule.actions)).toEqual({ addLabels: ["Finance/Receipts"], removeLabels: ["Other"], archive: true });
  });
});

describe("Phase 4: one action registry drives the palette, toolbar and Vim keys", () => {
  const thread: ThreadSummary = {
    id: "t1", subject: "Hello", snippet: "", senderSummary: "a@example.com", lastMessageAt: 1,
    labels: ["INBOX", "UNREAD"], ghostLabels: [], isUnread: true, isStarred: false, isArchived: false, aiStatus: "pending",
  };
  const calls: string[] = [];
  const context: ActionContext = {
    accounts: [
      { id: "personal", email: "me@example.com", displayName: "Personal", colorTheme: "blue" },
      { id: "work", email: "me@work.example", displayName: "Work", colorTheme: "violet" },
    ],
    accountId: "personal",
    views: BUILT_IN_VIEWS,
    viewId: "inbox",
    selectedThread: thread,
    threadOpen: true,
    canSelectNext: true,
    canSelectPrevious: false,
    syncing: false,
    builderOpen: false,
    savedViewPosition: null,
    moveSelection: (delta) => calls.push(`move:${delta}`),
    openSelectedThread: () => calls.push("open"),
    closeThread: () => calls.push("close"),
    focusSearch: () => calls.push("search"),
    runThreadAction: (action) => calls.push(`action:${action.type}`),
    openLabelPicker: () => calls.push("labels"),
    switchAccount: (id) => calls.push(`account:${id}`),
    goToView: (id) => calls.push(`view:${id}`),
    sync: () => calls.push("sync"),
    toggleBuilder: () => calls.push("builder"),
    saveView: () => calls.push("save-view"),
    editView: () => calls.push("edit-view"),
    deleteView: () => calls.push("delete-view"),
    moveView: (delta) => calls.push(`move-view:${delta}`),
  };
  const actions = buildActions(context);
  const keyEvent = (key: string, extra: Partial<Pick<KeyboardEvent, "code" | "altKey" | "metaKey" | "ctrlKey">> = {}) =>
    ({ key, code: "", altKey: false, metaKey: false, ctrlKey: false, ...extra });

  test("every action has a unique shortcut and the toolbar only references registered actions", () => {
    const shortcuts = actions.flatMap((action) => action.shortcut ? [`${action.shortcut.alt ? "alt+" : ""}${action.shortcut.key}`] : []);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    // Only rare or destructive view management is palette + button only.
    expect(actions.filter((action) => !action.shortcut).map((action) => action.id).sort())
      .toEqual(["views.delete", "views.edit", "views.moveDown", "views.moveUp"]);
    const ids = new Set(actions.map((action) => action.id));
    for (const id of TOOLBAR_ACTION_IDS) expect(ids.has(id)).toBe(true);
  });

  test("PRD keys map to the expected actions", () => {
    const byKey = (key: string, alt = false) =>
      actions.find((action) => action.shortcut && matchesShortcut(keyEvent(key, alt ? { altKey: true, code: `Digit${key}` } : {}), action.shortcut))?.id;
    expect(byKey("j")).toBe("navigation.next");
    expect(byKey("k")).toBe("navigation.previous");
    expect(byKey("e")).toBe("thread.archive");
    expect(byKey("l")).toBe("thread.label");
    expect(byKey("u")).toBe("thread.toggleRead");
    expect(byKey("S")).toBe("account.sync");
    expect(byKey("1")).toBe("views.go.inbox");
    expect(byKey("f")).toBe("filter.builder");
    expect(byKey("v")).toBe("views.save");
    expect(byKey("2", true)).toBe("account.switch.work");
    expect(actions.find((action) => action.id === "thread.toggleRead")?.label).toBe("Mark as read");
  });

  test("shortcuts ignore Cmd/Ctrl chords and Alt shortcuts match the physical key", () => {
    const archive = actions.find((action) => action.id === "thread.archive")!.shortcut!;
    expect(matchesShortcut(keyEvent("e", { metaKey: true }), archive)).toBe(false);
    const work = actions.find((action) => action.id === "account.switch.work")!.shortcut!;
    // Option+2 types "™" on a US Mac layout.
    expect(matchesShortcut(keyEvent("™", { altKey: true, code: "Digit2" }), work)).toBe(true);
    expect(shortcutLabel(work)).toBe("⌥2");
    expect(shortcutLabel({ key: "S" })).toBe("⇧S");
  });

  test("running actions calls the context with the selected thread's state", () => {
    calls.length = 0;
    for (const id of ["thread.archive", "thread.toggleRead", "thread.toggleStar", "account.switch.work", "views.go.starred", "filter.builder", "views.save"]) {
      actions.find((action) => action.id === id)!.run();
    }
    expect(calls).toEqual(["action:archive", "action:markRead", "action:star", "account:work", "view:starred", "builder", "save-view"]);
    expect(actions.find((action) => action.id === "account.switch.personal")?.enabled).toBe(false);
    // Built-in views cannot be edited, deleted or moved.
    for (const id of ["views.edit", "views.delete", "views.moveUp", "views.moveDown"]) {
      expect(actions.find((action) => action.id === id)?.enabled).toBe(false);
    }
    const saved = buildActions({ ...context, savedViewPosition: { index: 0, count: 2 } });
    expect(saved.filter((action) => action.id.startsWith("views.move") && action.enabled).map((action) => action.id)).toEqual(["views.moveDown"]);
  });

  test("routes round-trip through /a/:accountId/views/:viewId[/t/:threadId]", () => {
    const route = { accountId: "work", viewId: "inbox", threadId: "thread/1" };
    expect(parseRoute(routePath(route))).toEqual(route);
    expect(parseRoute("/a/personal/views/starred")).toEqual({ accountId: "personal", viewId: "starred", threadId: null });
    expect(parseRoute("/setup")).toBeNull();
  });

  test("optimistic action results match the server's label rules", () => {
    expect(applyThreadAction(thread, { type: "archive" })).toMatchObject({ labels: ["UNREAD"], isArchived: true });
    expect(applyThreadAction(thread, { type: "setLabels", add: ["Receipts"], remove: ["UNREAD"] }))
      .toMatchObject({ labels: ["INBOX", "Receipts"], isUnread: false });
  });
});

interface GmailCall {
  readonly method: string;
  readonly path: string;
  readonly token: string | null;
  readonly body: unknown;
}

const vault = OAuthTokenVault.fromKey(new Uint8Array(32).fill(9));
const unusedOAuth: GoogleOAuth2Api = {
  authorizationUrl: () => new URL("http://127.0.0.1/unused"),
  exchangeCode: () => Effect.die("unused"),
  refreshAccessToken: () => Effect.die("unused"),
};

/** A mock Gmail API, an in-memory registry with both accounts connected, and isolated in-memory silos. */
const makeEnvironment = async (options: { readonly connectWork?: boolean } = {}) => {
  const gmailCalls: GmailCall[] = [];
  let failModify = false;
  const gmail = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      gmailCalls.push({ method: request.method, path: url.pathname, token: request.headers.get("authorization"), body });
      if (url.pathname.endsWith("/modify")) {
        return failModify
          ? Response.json({ error: { code: 400, message: "Invalid label", errors: [{ reason: "invalidArgument" }] } }, { status: 400 })
          : Response.json({});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && request.method === "POST") {
        return Response.json({ id: "Label_new", name: (body as { name: string }).name, type: "user" });
      }
      return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(gmail);

  const registryDatabase = new Database(":memory:");
  closeables.push(registryDatabase);
  const registry: RegistryDbService = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(RegistryDbTest(registryDatabase))));
  const connect = (id: AccountId, email: string) => Effect.runPromise(registry.upsertAccount({
    id, email, displayName: id === "personal" ? "Personal" : "Work", colorTheme: id === "personal" ? "blue" : "violet",
    oauthTokensEnc: vault.encrypt({ tokens: { accessToken: `token-${id}` }, expiresAt: Date.now() + 3_600_000 } satisfies StoredTokens),
    createdAt: Date.now(),
  }));
  await connect("personal", "me@example.com");
  if (options.connectWork !== false) await connect("work", "me@work.example");

  const silos = { personal: new Database(":memory:"), work: new Database(":memory:") };
  closeables.push(silos.personal, silos.work);
  const personal = serviceOf(silos.personal, "personal");
  const work = serviceOf(silos.work, "work");
  await Effect.runPromise(personal.replaceLabels([
    { id: "INBOX", name: "INBOX", type: "system", colorBg: null, colorText: null },
    { id: "Label_1", name: "Receipts", type: "user", colorBg: null, colorText: null },
  ]));
  const seed = async (db: AccountDbService, id: string, labels: string[], lastMessageAt: number, messageIds: string[]) => {
    await Effect.runPromise(db.upsertThread({
      id, subject: `Subject ${id}`, senderSummary: `Sender <${id}@example.com>`, labels, snippet: `snippet ${id}`, lastMessageAt,
      isUnread: labels.includes("UNREAD"), isStarred: labels.includes("STARRED"), isArchived: !labels.includes("INBOX"),
    }));
    for (const messageId of messageIds) {
      await Effect.runPromise(db.upsertMessage({
        id: messageId, threadId: id, fromAddress: `Sender <${id}@example.com>`, toAddresses: ["me@example.com"], ccAddresses: [],
        deliveredTo: null, dateTs: lastMessageAt, bodyMarkdown: `Body ${messageId}`, bodyHtmlSanitized: `<p>Body ${messageId}</p>`, rawHeaders: {},
      }));
    }
  };
  await seed(personal, "p-new", ["INBOX", "UNREAD"], 300, ["p-new-1", "p-new-2"]);
  await seed(personal, "p-old", ["INBOX", "Receipts"], 200, ["p-old-1"]);
  await seed(personal, "p-archived", ["Receipts"], 100, ["p-archived-1"]);
  await seed(work, "w-1", ["INBOX"], 50, ["w-1-1"]);

  const events = createAccountEventBus();
  const api = createApiHandler({
    registry,
    tokens: createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault }),
    events,
    gmailApiBaseUrl: `${gmail.url}gmail/v1`,
    accountDbLayer: (accountId) => AccountDbTest(accountId, silos[accountId]),
  });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => (await api.handle(request, new URL(request.url))) ?? new Response("Not found", { status: 404 }),
  });
  servers.push(server);
  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, server.url), init);
  const post = (path: string, body: unknown, headers: Record<string, string> = { [LOCAL_REQUEST_HEADER]: "1" }) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { api, events, registry, personal, work, gmailCalls, setFailModify: (value: boolean) => { failModify = value; }, call, post, server };
};

describe("Phase 4: account-scoped HTTP API", () => {
  let env: Awaited<ReturnType<typeof makeEnvironment>>;
  beforeEach(async () => {
    env = await makeEnvironment();
  });
  afterAll(async () => {
    await env?.api.close();
  });

  test("lists a view's threads newest first, pages them and applies DSL filters", async () => {
    const inbox = await (await env.call("/api/a/personal/threads?view=inbox&limit=1")).json() as ThreadPage;
    expect(inbox.threads.map((thread) => thread.id)).toEqual(["p-new"]);
    expect(inbox.hasMore).toBe(true);
    const second = await (await env.call("/api/a/personal/threads?view=inbox&limit=1&offset=1")).json() as ThreadPage;
    expect(second).toEqual({ threads: [expect.objectContaining({ id: "p-old", labels: ["INBOX", "Receipts"] })], hasMore: false });

    const filtered = await (await env.call(`/api/a/personal/threads?view=all&q=${encodeURIComponent("label:receipts AND NOT is:archived")}`)).json() as ThreadPage;
    expect(filtered.threads.map((thread) => thread.id)).toEqual(["p-old"]);

    const invalid = await env.call(`/api/a/personal/threads?view=inbox&q=${encodeURIComponent("is:unread AND (")}`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ offset: expect.any(Number) });
    expect((await env.call("/api/a/personal/threads?view=nope")).status).toBe(404);
  });

  test("keeps Personal and Work physically isolated", async () => {
    const work = await (await env.call("/api/a/work/threads?view=all")).json() as ThreadPage;
    expect(work.threads.map((thread) => thread.id)).toEqual(["w-1"]);
    expect((await env.call("/api/a/work/threads/p-new")).status).toBe(404);
    expect((await env.post("/api/a/work/threads/p-new/actions", { type: "archive" })).status).toBe(404);
    expect((await env.call("/api/a/shared/threads")).status).toBe(400);
  });

  test("returns a thread with its messages, labels and views", async () => {
    const { thread } = await (await env.call("/api/a/personal/threads/p-new")).json() as { thread: ThreadDetail };
    expect(thread.messages.map((message) => message.id)).toEqual(["p-new-1", "p-new-2"]);
    expect(thread.messages[0]).toMatchObject({ bodyHtmlSanitized: "<p>Body p-new-1</p>", toAddresses: ["me@example.com"] });
    expect(await (await env.call("/api/a/personal/labels")).json()).toMatchObject({ labels: expect.arrayContaining([expect.objectContaining({ name: "Receipts" })]) });
    const { views } = await (await env.call("/api/a/personal/views")).json() as { views: Array<{ id: string }> };
    expect(views.map((view) => view.id)).toEqual(BUILT_IN_VIEWS.map((view) => view.id));
  });

  test("rejects mutations without the client header or from another site", async () => {
    expect((await env.post("/api/a/personal/threads/p-new/actions", { type: "archive" }, {})).status).toBe(403);
    expect((await env.post("/api/a/personal/threads/p-new/actions", { type: "archive" }, {
      [LOCAL_REQUEST_HEADER]: "1", Origin: "https://evil.example",
    })).status).toBe(403);
    expect((await env.post("/api/a/personal/threads/p-new/actions", { type: "explode" })).status).toBe(400);
    expect(env.gmailCalls).toHaveLength(0);
  });

  test("archives in Gmail first, then locally, and notifies the account's event stream", async () => {
    const received: string[] = [];
    const unsubscribe = env.events.subscribe("personal", (event) => received.push(event.type));
    const otherAccount: string[] = [];
    const unsubscribeWork = env.events.subscribe("work", (event) => otherAccount.push(event.type));

    const response = await env.post("/api/a/personal/threads/p-new/actions", { type: "archive" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ thread: { id: "p-new", isArchived: true, labels: ["UNREAD"] } });
    expect(env.gmailCalls.map((call) => [call.path, call.token, call.body])).toEqual([
      ["/gmail/v1/users/me/messages/p-new-1/modify", "Bearer token-personal", { addLabelIds: [], removeLabelIds: ["INBOX"] }],
      ["/gmail/v1/users/me/messages/p-new-2/modify", "Bearer token-personal", { addLabelIds: [], removeLabelIds: ["INBOX"] }],
    ]);
    const inbox = await (await env.call("/api/a/personal/threads?view=inbox")).json() as ThreadPage;
    expect(inbox.threads.map((thread) => thread.id)).toEqual(["p-old"]);
    expect(received).toEqual(["threads-changed"]);
    expect(otherAccount).toEqual([]);
    unsubscribe();
    unsubscribeWork();
  });

  test("sends label IDs to Gmail and creates labels that do not exist yet", async () => {
    const response = await env.post("/api/a/personal/threads/p-old/actions", { type: "setLabels", add: ["Travel"], remove: ["Receipts"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ thread: { labels: ["INBOX", "Travel"] } });
    expect(env.gmailCalls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/gmail/v1/users/me/labels", { name: "Travel", labelListVisibility: "labelShow", messageListVisibility: "show" }],
      ["POST", "/gmail/v1/users/me/messages/p-old-1/modify", { addLabelIds: ["Label_new"], removeLabelIds: ["Label_1"] }],
    ]);
    expect((await Effect.runPromise(env.personal.listLabels())).map((label) => label.name)).toContain("Travel");
  });

  test("leaves the local thread untouched when Gmail rejects the change", async () => {
    env.setFailModify(true);
    const response = await env.post("/api/a/personal/threads/p-new/actions", { type: "markRead" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ retryable: false });
    expect(await Effect.runPromise(env.personal.getThread("p-new"))).toMatchObject({ isUnread: true, labels: ["INBOX", "UNREAD"] });
  });

  test("creates, edits, reorders and deletes saved split views per account", async () => {
    const events: string[] = [];
    env.events.subscribe("personal", (event) => events.push(event.type));
    const send = (method: string, path: string, body?: unknown) => env.call(path, {
      method,
      headers: { "Content-Type": "application/json", [LOCAL_REQUEST_HEADER]: "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const created = await env.post("/api/a/personal/views", { name: " Receipts ", dsl: "label:receipts  AND   NOT is:archived" });
    expect(created.status).toBe(201);
    const { view } = await created.json() as { view: { id: string; name: string; dsl: string } };
    expect(view).toMatchObject({ name: "Receipts", dsl: "label:receipts AND NOT is:archived", builtIn: false });
    const listed = await (await env.call(`/api/a/personal/threads?view=${view.id}`)).json() as ThreadPage;
    expect(listed.threads.map((thread) => thread.id)).toEqual(["p-old"]);

    expect((await env.post("/api/a/personal/views", { name: "receipts", dsl: "is:unread" })).status).toBe(409);
    expect((await env.post("/api/a/personal/views", { name: "inbox", dsl: "is:unread" })).status).toBe(409);
    const invalid = await env.post("/api/a/personal/views", { name: "Broken", dsl: "is:unread AND (" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ offset: expect.any(Number) });
    expect((await env.post("/api/a/personal/views", { name: "", dsl: "is:unread" })).status).toBe(400);
    expect((await env.post("/api/a/personal/views", { name: "No header", dsl: "is:unread" }, {})).status).toBe(403);

    const second = await (await env.post("/api/a/personal/views", { name: "Needs reading", dsl: "is:unread" })).json() as { view: { id: string } };
    const renamed = await send("PATCH", `/api/a/personal/views/${view.id}`, { name: "Money", dsl: "label:Receipts" });
    expect(await renamed.json()).toMatchObject({ view: { id: view.id, name: "Money", dsl: "label:Receipts" } });
    expect((await send("PATCH", "/api/a/personal/views/inbox", { name: "Mine" })).status).toBe(400);
    expect((await send("PATCH", "/api/a/personal/views/v-missing", { name: "Ghost" })).status).toBe(404);

    expect((await send("PUT", "/api/a/personal/views/order", { ids: [second.view.id] })).status).toBe(400);
    const reordered = await (await send("PUT", "/api/a/personal/views/order", { ids: [second.view.id, view.id] })).json() as { views: Array<{ id: string }> };
    expect(reordered.views.map((entry) => entry.id).slice(-2)).toEqual([second.view.id, view.id]);

    // Saved views live in the account's own silo.
    const workViews = await (await env.call("/api/a/work/views")).json() as { views: Array<{ builtIn: boolean }> };
    expect(workViews.views.every((entry) => entry.builtIn)).toBe(true);

    expect((await send("DELETE", "/api/a/personal/views/inbox")).status).toBe(400);
    expect((await send("DELETE", `/api/a/personal/views/${view.id}`)).status).toBe(200);
    expect((await send("DELETE", `/api/a/personal/views/${view.id}`)).status).toBe(404);
    const { views } = await (await env.call("/api/a/personal/views")).json() as { views: Array<{ id: string }> };
    expect(views.map((entry) => entry.id)).toEqual([...BUILT_IN_VIEWS.map((entry) => entry.id), second.view.id]);
    expect(events.filter((type) => type === "views-changed")).toHaveLength(5);
  });

  test("streams account events over SSE", async () => {
    const controller = new AbortController();
    const response = await env.call("/api/a/personal/events", { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain(": connected");
    env.events.publish("personal", { type: "sync", status: "completed" });
    while (!text.includes("event: sync")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('data: {"type":"sync","status":"completed"}');
    controller.abort();
  });
});

describe("Phase 4: web client hosting", () => {
  test("reports accounts that are not connected", async () => {
    const env = await makeEnvironment({ connectWork: false });
    const response = await env.call("/api/a/work/threads");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("/setup") });
    await env.api.close();
  });

  test("serves the bundled React client under /a/* and redirects / to the first account", async () => {
    const env = await makeEnvironment();
    const app = createDevServer({
      registry: env.registry,
      oauth: unusedOAuth,
      api: env.api,
      events: env.events,
      encryptionKey: new Uint8Array(32).fill(9),
      redirectUri: "http://127.0.0.1:3000/auth/google/callback",
      port: 0,
    });
    servers.push(app);

    const root = await fetch(app.url, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/a/personal/views/inbox");

    const page = await fetch(new URL("/a/personal/views/inbox/t/p-new", app.url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<div id="root"></div>');
    const scriptPath = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(scriptPath).toBeDefined();
    const script = await fetch(new URL(scriptPath!, app.url));
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("Command palette");
    // Tailwind runs through bunfig's [serve.static] plugin; compiled utilities prove it did.
    const stylesheetPath = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
    const stylesheet = await (await fetch(new URL(stylesheetPath!, app.url))).text();
    expect(stylesheet).toContain("bg-violet-600");

    // The API is mounted on the same server.
    expect((await fetch(new URL("/api/a/personal/threads?view=inbox", app.url))).status).toBe(200);
    await env.api.close();
  });
});
