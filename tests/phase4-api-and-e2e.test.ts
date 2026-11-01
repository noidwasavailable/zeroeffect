import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createDevServer } from "../src/server/dev-server";
import { createApiHandler, type ApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { formatRulesFile } from "../src/server/services/AiRules";
import { createAiRunner } from "../src/server/services/AiRunner";
import { AccountDb, AccountDbTest, type AccountDbService } from "../src/server/services/AccountDb";
import { BooleanFilter, BooleanFilterLive } from "../src/server/services/BooleanFilter";
import { labelColorFor } from "../src/server/services/GmailLabels";
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
import { keycapParts } from "../src/client/components/Keycap";
import { allMessagesExpanded, foldLayout, initialFold, toggleAllMessages, toggleMessage, type FoldItem } from "../src/client/threadFolding";
import { LOCAL_REQUEST_HEADER, type AccountId, type ThreadDetail, type ThreadMessage, type ThreadPage, type ThreadSummary } from "../src/shared/api";
import { formatFilterExpr } from "../src/shared/filterDsl";
import { parseFilterDsl } from "../src/shared/filterParser";
import { copyableOtp, extractOtpCode, otpLabelNames } from "../src/shared/otp";
import type { FilterExpr } from "../src/shared/schemas";
import { applyThreadAction } from "../src/shared/threadActions";
import { BUILT_IN_VIEWS, orderViews } from "../src/shared/views";

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
  test("rewrites saved view ASTs and DSL (rule files: see Phase 3)", async () => {
    const database = new Database(":memory:");
    closeables.push(database);
    const db = serviceOf(database, "personal");
    await Effect.runPromise(db.replaceLabels([{ id: "Label_1", name: "Receipts", type: "user", colorBg: null, colorText: null }]));
    const viewAst = parse('label:receipts OR (is:unread AND label:"Other")');
    database.prepare("INSERT INTO saved_views (id, name, sort_order, filter_ast_json, dsl_string) VALUES ('v', 'Money', 1, ?, ?)")
      .run(JSON.stringify(viewAst), formatFilterExpr(viewAst));

    await Effect.runPromise(db.replaceLabels([{ id: "Label_1", name: "Finance/Receipts", type: "user", colorBg: null, colorText: null }]));

    expect(await Effect.runPromise(db.listSavedViews())).toEqual([
      { id: "v", name: "Money", dsl: "label:Finance/Receipts OR (is:unread AND label:Other)", builtIn: false },
    ]);
  });

  test("sync keeps AI state, never rolls a thread back to an older message, and unions message labels", async () => {
    const database = new Database(":memory:");
    closeables.push(database);
    const db = serviceOf(database, "personal");
    const upsert = (labels: string[], at: number, subject: string) => Effect.runPromise(db.upsertThread({
      id: "t", subject, senderSummary: "a@example.com", labels, snippet: subject, lastMessageAt: at,
      isUnread: false, isStarred: false, isArchived: false,
    }));
    const message = (id: string, labels: string[], at: number) => Effect.runPromise(db.upsertMessage({
      id, threadId: "t", fromAddress: "a@example.com", toAddresses: [], ccAddresses: [], deliveredTo: null, dateTs: at,
      bodyMarkdown: "", bodyHtmlSanitized: "", rawHeaders: {}, labels,
    }));
    await upsert(["INBOX", "Receipts"], 100, "First");
    await message("m1", ["INBOX", "Receipts"], 100);
    await Effect.runPromise(db.setGhostLabels("t", ["Travel"]));
    await upsert(["INBOX", "UNREAD"], 200, "Reply");
    await message("m2", ["INBOX", "UNREAD"], 200);
    await Effect.runPromise(db.refreshThreadLabelsFromMessages("t"));
    // A label change on the older message arrives later in history.
    await upsert(["INBOX", "Receipts", "STARRED"], 100, "First");
    await message("m1", ["INBOX", "Receipts", "STARRED"], 100);
    await Effect.runPromise(db.refreshThreadLabelsFromMessages("t"));
    const thread = (await Effect.runPromise(db.getAiThreadContext("t")))!;
    expect(thread.thread).toMatchObject({
      subject: "Reply", lastMessageAt: 200, ghostLabels: ["Travel"], isUnread: true, isStarred: true,
      labels: ["INBOX", "Receipts", "STARRED", "UNREAD"],
    });
    await Effect.runPromise(db.applyThreadLabelChange("t", ["Done"], ["INBOX", "UNREAD"]));
    expect((await Effect.runPromise(db.getAiThreadContext("t")))!.messages.map((entry) => entry.labels)).toEqual([
      ["Receipts", "STARRED", "Done"], ["Done"],
    ]);
  });
});

describe("Phase 4: one-time codes", () => {
  test("finds the code near an OTP keyword and ignores other numbers", () => {
    expect(extractOtpCode("197565 - Your Spotify login code", "")).toBe("197565");
    expect(extractOtpCode("Your sign-in code", "Enter this code to sign in: 1470. It expires in 15 minutes.")).toBe("1470");
    expect(extractOtpCode("[네이버] 인증번호", "인증번호 [384 921]를 입력해 주세요.")).toBe("384921");
    expect(extractOtpCode("Verify your account", "Your verification code is G-552190")).toBe("552190");
    expect(extractOtpCode("Order 1123144770487302 shipped", "Total $1299. Track order 77812.")).toBeNull();
    expect(extractOtpCode("Verify your email", "Click https://example.com/verify/123456 to continue.")).toBeNull();
    // "pin" inside "shipping" is not a keyword.
    expect(extractOtpCode("Shipping update", "Shipping 445566 arrives Friday.")).toBeNull();
    expect(extractOtpCode("Your code", "Use code 2026 in your account settings.")).toBeNull();
  });

  test("only OTP-labelled threads offer a code; the label comes from the account's OTP rules", () => {
    const rules = [{ systemType: "OTP", actions: [{ type: "LABEL", label: "Codes" }] }, { systemType: "NEWSLETTER", actions: [{ type: "LABEL", label: "News" }] }];
    expect([...otpLabelNames(rules)]).toEqual(["Codes"]);
    expect([...otpLabelNames([])]).toEqual(["OTP"]);
    expect(copyableOtp({ otpCode: "123456", labels: ["INBOX", "Codes"] }, otpLabelNames(rules))).toBe("123456");
    expect(copyableOtp({ otpCode: "123456", labels: ["INBOX"] }, otpLabelNames(rules))).toBeNull();
    expect(copyableOtp({ otpCode: null, labels: ["Codes"] }, otpLabelNames(rules))).toBeNull();
  });

  test("stores the newest message's code on the thread and backfills databases from before it", async () => {
    const database = new Database(":memory:");
    const open = () => Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(AccountDbTest("personal", database))));
    const db = open();
    const upsert = (id: string, at: number, otpCode: string | null, body: string) => Effect.runPromise(Effect.gen(function* () {
      yield* db.upsertThread({ id: "t-otp", subject: "Your login code", senderSummary: "a@x.example", labels: ["INBOX", "OTP"], lastMessageAt: at, isUnread: true, isStarred: false, isArchived: false, otpCode });
      yield* db.upsertMessage({ id, threadId: "t-otp", fromAddress: "a@x.example", toAddresses: [], ccAddresses: [], deliveredTo: null, dateTs: at, bodyMarkdown: body, bodyHtmlSanitized: "", rawHeaders: {} });
    }));
    await upsert("m2", 20, "222222", "Your code is 222222");
    // An older message synced later must not replace the newest message's code.
    await upsert("m1", 10, "111111", "Your code is 111111");
    const filter = Effect.runSync(Effect.gen(function* () { return (yield* BooleanFilter).compile({ _tag: "Label", value: "OTP" }); }).pipe(Effect.provide(BooleanFilterLive)));
    expect((await Effect.runPromise(db.listThreadSummaries(filter, { limit: 5, offset: 0 })))[0]?.otpCode).toBe("222222");

    database.exec("ALTER TABLE threads DROP COLUMN otp_code");
    const migrated = open();
    expect((await Effect.runPromise(migrated.listThreadSummaries(filter, { limit: 5, offset: 0 })))[0]?.otpCode).toBe("222222");
    database.close();
  });
});

describe("Phase 4: reading a conversation from its latest reply", () => {
  const message = (id: string, isUnread = false): ThreadMessage => ({
    id, fromAddress: `${id}@example.com`, toAddresses: [], ccAddresses: [], deliveredTo: null, dateTs: 1,
    bodyMarkdown: id, bodyHtmlSanitized: "", bodyHtml: null, isUnread, attachments: [],
  });
  const shown = (items: ReadonlyArray<FoldItem>) =>
    items.map((item) => item.kind === "hidden" ? `+${item.count}` : `${item.index}${item.expanded ? "*" : ""}`);

  test("only the newest and unread messages start expanded; long collapsed runs hide their middle", () => {
    const messages = ["a", "b", "c", "d", "e", "f"].map((id) => message(id, id === "e"));
    const fold = initialFold("t");
    expect(shown(foldLayout(fold, messages))).toEqual(["0", "+2", "3", "4*", "5*"]);
    expect(shown(foldLayout({ ...fold, revealed: true }, messages))).toEqual(["0", "1", "2", "3", "4*", "5*"]);
    // Three or fewer collapsed messages are all listed.
    expect(shown(foldLayout(fold, messages.slice(2)))).toEqual(["0", "1", "2*", "3*"]);
  });

  test("messages toggle one by one, expand all and back, and new replies still arrive expanded", () => {
    const messages = [message("a"), message("b"), message("c")];
    let fold = toggleMessage(initialFold("t"), messages, 0);
    expect(shown(foldLayout(fold, messages))).toEqual(["0*", "1", "2*"]);
    fold = toggleMessage(fold, messages, 2);
    expect(shown(foldLayout(fold, messages))).toEqual(["0*", "1", "2"]);
    fold = toggleAllMessages(fold, messages);
    expect(allMessagesExpanded(fold, messages)).toBe(true);
    expect(toggleAllMessages(fold, messages)).toEqual(initialFold("t"));
    const withReply = [...messages, message("d")];
    expect(shown(foldLayout(toggleMessage(initialFold("t"), messages, 0), withReply))).toEqual(["0*", "1", "2", "3*"]);
  });

  test("keycaps split modifiers from the key", () => {
    expect(keycapParts("⌘K")).toEqual(["⌘", "K"]);
    expect(keycapParts("⇧S")).toEqual(["⇧", "S"]);
    expect(keycapParts("⌘↵")).toEqual(["⌘", "↵"]);
    expect(keycapParts("Esc")).toEqual(["Esc"]);
    expect(keycapParts("⇧")).toEqual(["⇧"]);
  });
});

describe("Phase 4: one action registry drives the palette, toolbar and Vim keys", () => {
  const thread: ThreadSummary = {
    id: "t1", subject: "Hello", snippet: "", senderSummary: "a@example.com", lastMessageAt: 1,
    labels: ["INBOX", "UNREAD"], ghostLabels: [], isUnread: true, isStarred: false, isArchived: false, aiStatus: "pending", otpCode: null,
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
    targets: [thread],
    checkedCount: 0,
    loadedCount: 3,
    viewName: "Inbox",
    moveSelectionTo: (position) => calls.push(`move-to:${position}`),
    moveMessage: (delta) => calls.push(`message:${delta}`),
    toggleChecked: () => calls.push("check"),
    checkAll: () => calls.push("check-all"),
    clearChecked: () => calls.push("clear-checked"),
    markAllRead: () => calls.push("mark-all-read"),
    openForward: () => calls.push("forward"),
    openInGmail: () => calls.push("gmail"),
    copyLink: () => calls.push("copy-link"),
    openLabelJump: () => calls.push("label-jump"),
    openLabelManager: () => calls.push("label-manage"),
    openAliases: () => calls.push("aliases"),
    refreshAliases: () => calls.push("refresh-aliases"),
    toggleHelp: () => calls.push("help"),
    selectedOtpCode: null,
    threadOpen: true,
    canSelectNext: true,
    canSelectPrevious: false,
    syncing: false,
    builderOpen: false,
    auditOpen: false,
    composerOpen: false,
    aiBusy: false,
    rules: [{ name: "Newsletter", automate: true }],
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
    runAi: () => calls.push("ai-run"),
    decideGhostLabels: (decision) => calls.push(`ghost:${decision}`),
    toggleAudit: () => calls.push("audit"),
    undoAi: () => calls.push("ai-undo"),
    openRules: (options) => calls.push(options?.newRule ? "rules:new" : "rules"),
    toggleRuleDryRun: (name) => calls.push(`dry-run:${name}`),
    openComposer: (options) => calls.push(`reply:${options.replyAll ? "all" : "one"}:${options.pickAlias ? "alias" : "auto"}`),
    changeAlias: () => calls.push("alias"),
    sendReply: () => calls.push("send"),
    discardReply: () => calls.push("discard"),
    copyOtp: () => calls.push("copy-otp"),
    openMessageCount: 3,
    allMessagesExpanded: false,
    toggleExpandAll: () => calls.push("expand-all"),
    newMessageOpen: false,
    openNewMessage: () => calls.push("new-message"),
    sendNewMessage: () => calls.push("send-new"),
    discardNewMessage: () => calls.push("discard-new"),
    openSetup: () => calls.push("setup"),
  };
  const actions = buildActions(context);
  const keyEvent = (key: string, extra: Partial<Pick<KeyboardEvent, "code" | "altKey" | "metaKey" | "ctrlKey">> = {}) =>
    ({ key, code: "", altKey: false, metaKey: false, ctrlKey: false, ...extra });

  test("every action has a unique shortcut and the toolbar only references registered actions", () => {
    const shortcuts = actions.flatMap((action) => action.shortcut ? [`${action.shortcut.alt ? "alt+" : ""}${action.shortcut.key}`] : []);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    // Only rare or destructive view management is palette + button only.
    expect(actions.filter((action) => !action.shortcut).map((action) => action.id).sort())
      .toEqual([
        "account.aliases", "account.refreshAliases",
        "ai.createRule", "ai.dryRun.Newsletter", "compose.discardNew", "compose.sendNew", "composer.changeAlias", "composer.discard", "composer.send",
        "labels.manage", "views.delete", "views.edit", "views.go.spam", "views.go.trash", "views.moveDown", "views.moveUp",
      ]);
    const ids = new Set(actions.map((action) => action.id));
    for (const id of TOOLBAR_ACTION_IDS) expect(ids.has(id)).toBe(true);
  });

  test("the toolbar carries the PRD's buttons: Archive, Label, Reply, Run AI and AI Audit", () => {
    for (const id of ["thread.archive", "thread.label", "thread.reply", "ai.run", "ai.audit"]) {
      expect(TOOLBAR_ACTION_IDS).toContain(id as (typeof TOOLBAR_ACTION_IDS)[number]);
    }
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
    expect(byKey("a")).toBe("ai.run");
    expect(byKey("y")).toBe("ai.acceptGhost");
    expect(byKey("n")).toBe("ai.rejectGhost");
    expect(byKey("w")).toBe("ai.audit");
    expect(byKey("z")).toBe("ai.undo");
    expect(byKey(",")).toBe("ai.rules");
    expect(byKey("r")).toBe("thread.reply");
    expect(byKey("R")).toBe("thread.replyAlias");
    expect(byKey("A")).toBe("thread.replyAll");
    expect(byKey("2", true)).toBe("account.switch.work");
    expect(byKey("c")).toBe("compose.new");
    expect(byKey("p")).toBe("thread.copyOtp");
    expect(byKey("G")).toBe("account.setup");
    expect(byKey(";")).toBe("thread.toggleExpandAll");
    expect(actions.find((action) => action.id === "thread.toggleRead")?.label).toBe("Mark as read");
  });

  test("new message, setup and copy-code actions reach the context; copying needs a code", () => {
    calls.length = 0;
    for (const id of ["compose.new", "account.setup"]) actions.find((action) => action.id === id)!.run();
    expect(calls).toEqual(["new-message", "setup"]);
    expect(actions.find((action) => action.id === "thread.copyOtp")?.enabled).toBe(false);
    expect(actions.find((action) => action.id === "compose.sendNew")?.enabled).toBe(false);
    const withCode = buildActions({ ...context, selectedOtpCode: "482913", newMessageOpen: true });
    const copy = withCode.find((action) => action.id === "thread.copyOtp")!;
    expect(copy).toMatchObject({ enabled: true, label: "Copy code 482913 and mark read" });
    expect(withCode.find((action) => action.id === "compose.new")?.enabled).toBe(false);
    expect(withCode.find((action) => action.id === "compose.sendNew")?.enabled).toBe(true);
    copy.run();
    expect(calls.at(-1)).toBe("copy-otp");
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
    calls.length = 0;
    for (const id of ["ai.run", "ai.audit", "ai.undo", "ai.rules", "ai.createRule", "ai.dryRun.Newsletter"]) actions.find((action) => action.id === id)!.run();
    expect(calls).toEqual(["ai-run", "audit", "ai-undo", "rules", "rules:new", "dry-run:Newsletter"]);
    expect(actions.find((action) => action.id === "ai.dryRun.Newsletter")?.label).toBe("Turn on dry-run: Newsletter");
    // Suggestions can only be decided when the thread has some.
    expect(actions.find((action) => action.id === "ai.acceptGhost")?.enabled).toBe(false);
    const withGhosts = buildActions({ ...context, selectedThread: { ...thread, ghostLabels: ["Travel"] } });
    withGhosts.find((action) => action.id === "ai.acceptGhost")!.run();
    expect(calls.at(-1)).toBe("ghost:accept");
    calls.length = 0;
    for (const id of ["thread.reply", "thread.replyAlias", "thread.replyAll"]) actions.find((action) => action.id === id)!.run();
    expect(calls).toEqual(["reply:one:auto", "reply:one:alias", "reply:all:auto"]);
    // Composer actions only work while a reply is open; replying again is disabled then.
    expect(actions.find((action) => action.id === "composer.send")?.enabled).toBe(false);
    const composing = buildActions({ ...context, composerOpen: true });
    expect(composing.find((action) => action.id === "composer.send")?.enabled).toBe(true);
    expect(composing.find((action) => action.id === "thread.reply")?.enabled).toBe(false);
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
const makeEnvironment = async (options: { readonly connectWork?: boolean; readonly withAi?: boolean } = {}) => {
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
      if (url.pathname === "/gmail/v1/users/me/messages/send") {
        return Response.json({ id: "sent-1", threadId: (body as { threadId?: string }).threadId ?? "new-thread" });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && request.method === "POST") {
        return Response.json({ id: "Label_new", name: (body as { name: string }).name, type: "user" });
      }
      const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
      if (messageMatch && request.method === "GET") {
        // Original HTML for messages stored before it was kept (see the thread backfill test).
        const html = `<html><head><style>.hero { color: #c00 }</style></head><body><p class="hero">Rich ${messageMatch[1]}</p><img src="https://img.example/${messageMatch[1]}.png"></body></html>`;
        return Response.json({
          id: messageMatch[1], threadId: "p-new",
          payload: { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } },
        });
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

  // A mock LLM that files everything under "Receipts", for the AI routes.
  const llmCalls: unknown[] = [];
  const llm = Bun.serve({
    port: 0,
    async fetch(request) {
      llmCalls.push(await request.json());
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        reasoning: "An order receipt.", matchedRules: [{ ruleName: "Receipts", isPrimary: true }], noMatchFound: false, conversationStatus: null,
      }) } }] });
    },
  });
  servers.push(llm);
  await Effect.runPromise(registry.upsertLlmEndpoint({
    id: "mock", name: "Mock", baseUrl: `${llm.url}v1`, apiKeyEnc: vault.encrypt("key"), modelId: "mock-model", apiMode: "chat_completions",
  }));
  await Effect.runPromise(personal.writeRulesFile(formatRulesFile({
    version: 1, llmEndpointId: "mock",
    rules: [{
      name: "Receipts", instructions: "Purchase receipts", enabled: true, automate: true, runOnThreads: false, systemType: "RECEIPT",
      conditionalOperator: "AND", from: null, to: null, subject: null, body: null, actions: [{ type: "LABEL", label: "Receipts" }, { type: "ARCHIVE" }],
    }],
  })));

  const repliesSent: string[] = [];
  const events = createAccountEventBus();
  const tokens = createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault });
  const accountDbLayer = (accountId: AccountId) => AccountDbTest(accountId, silos[accountId]);
  const aiRunner = options.withAi === false ? undefined : createAiRunner({
    registry, tokens, vault, events, gmailApiBaseUrl: `${gmail.url}gmail/v1`, accountDbLayer: (accountId) => accountDbLayer(accountId as AccountId),
  });
  const api = createApiHandler({
    registry,
    tokens,
    events,
    gmailApiBaseUrl: `${gmail.url}gmail/v1`,
    accountDbLayer,
    vault,
    onReplySent: (accountId) => repliesSent.push(accountId),
    ...(aiRunner ? { aiRunner } : {}),
  });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => (await api.handle(request, new URL(request.url))) ?? new Response("Not found", { status: 404 }),
  });
  servers.push(server);
  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, server.url), init);
  const post = (path: string, body: unknown, headers: Record<string, string> = { [LOCAL_REQUEST_HEADER]: "1" }) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { api, events, registry, personal, work, gmailCalls, llmCalls, repliesSent, setFailModify: (value: boolean) => { failModify = value; }, call, post, server };
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

  test("fetches the original HTML of messages stored without it once, when the thread is opened", async () => {
    const open = async () => ((await (await env.call("/api/a/personal/threads/p-new")).json()) as { thread: ThreadDetail }).thread;
    const first = await open();
    expect(first.messages[0]!.bodyHtml).toContain('<style>.hero { color: #c00 }</style>');
    expect(first.messages[1]!.bodyHtml).toContain('<img src="https://img.example/p-new-2.png">');
    expect(env.gmailCalls.map((call) => call.path).sort()).toEqual([
      "/gmail/v1/users/me/messages/p-new-1",
      "/gmail/v1/users/me/messages/p-new-2",
    ]);
    // Stored: opening it again needs no Gmail request, and the reduced copy is unchanged.
    const second = await open();
    expect(second.messages.map((message) => message.bodyHtml)).toEqual(first.messages.map((message) => message.bodyHtml));
    expect(second.messages[0]).toMatchObject({ bodyHtmlSanitized: "<p>Body p-new-1</p>" });
    expect(env.gmailCalls).toHaveLength(2);
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
    // One threads.modify call covers every message in the thread.
    expect(env.gmailCalls.map((call) => [call.path, call.token, call.body])).toEqual([
      ["/gmail/v1/users/me/threads/p-new/modify", "Bearer token-personal", { addLabelIds: [], removeLabelIds: ["INBOX"] }],
    ]);
    const inbox = await (await env.call("/api/a/personal/threads?view=inbox")).json() as ThreadPage;
    expect(inbox.threads.map((thread) => thread.id)).toEqual(["p-old"]);
    expect(received).toEqual(["threads-changed"]);
    expect(otherAccount).toEqual([]);
    unsubscribe();
    unsubscribeWork();
  });

  test("sends label IDs to Gmail and creates labels that do not exist yet, colored from Gmail's palette", async () => {
    const response = await env.post("/api/a/personal/threads/p-old/actions", { type: "setLabels", add: ["Travel"], remove: ["Receipts"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ thread: { labels: ["INBOX", "Travel"] } });
    expect(env.gmailCalls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/gmail/v1/users/me/labels", {
        name: "Travel", labelListVisibility: "labelShow", messageListVisibility: "show", color: labelColorFor("Travel"),
      }],
      ["POST", "/gmail/v1/users/me/threads/p-old/modify", { addLabelIds: ["Label_new"], removeLabelIds: ["Label_1"] }],
    ]);
    expect((await Effect.runPromise(env.personal.listLabels())).map((label) => label.name)).toContain("Travel");
    // Inbox Zero's colors for its rule labels; any other name always gets the same palette color.
    expect(labelColorFor("Receipt")).toEqual({ backgroundColor: "#fdedc1", textColor: "#000000" });
    expect(labelColorFor("Travel")).toEqual(labelColorFor("Travel"));
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
    // Saved views sit between the primary built-ins and Trash / Spam.
    expect(reordered.views.map((entry) => entry.id).slice(-4)).toEqual([second.view.id, view.id, "trash", "spam"]);

    // Saved views live in the account's own silo.
    const workViews = await (await env.call("/api/a/work/views")).json() as { views: Array<{ builtIn: boolean }> };
    expect(workViews.views.every((entry) => entry.builtIn)).toBe(true);

    expect((await send("DELETE", "/api/a/personal/views/inbox")).status).toBe(400);
    expect((await send("DELETE", `/api/a/personal/views/${view.id}`)).status).toBe(200);
    expect((await send("DELETE", `/api/a/personal/views/${view.id}`)).status).toBe(404);
    const { views } = await (await env.call("/api/a/personal/views")).json() as { views: Array<{ id: string }> };
    expect(views.map((entry) => entry.id)).toEqual(orderViews([{ id: second.view.id, name: "Needs reading", dsl: "is:unread", builtIn: false }]).map((entry) => entry.id));
    expect(events.filter((type) => type === "views-changed")).toHaveLength(5);
  });

  test("runs the AI labeller on demand, lists its audit trail and undoes it", async () => {
    const rules = await (await env.call("/api/a/personal/rules")).json() as { rules: { llmEndpointId: string; rules: Array<{ name: string }> }; problems: unknown[] };
    expect(rules).toMatchObject({ rules: { llmEndpointId: "mock", rules: [{ name: "Receipts" }] }, problems: [] });
    expect(await (await env.call("/api/a/work/rules")).json()).toMatchObject({ rules: { rules: [] } });

    const run = await env.post("/api/a/personal/threads/p-new/ai", {});
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ result: { status: "processed", llmCalled: true, appliedRules: ["Receipts"] } });
    expect(env.llmCalls).toHaveLength(1);
    expect(env.gmailCalls.map((call) => [call.path, call.body])).toEqual([
      ["/gmail/v1/users/me/threads/p-new/modify", { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] }],
    ]);
    const { audits } = await (await env.call("/api/a/personal/threads/p-new/ai")).json() as { audits: Array<Record<string, unknown>> };
    expect(audits).toMatchObject([{ trigger: "manual", ruleNames: ["Receipts"], reasoning: "An order receipt.", modelUsed: "mock-model", reverted: false }]);

    expect(await (await env.post("/api/a/personal/ai/undo", {})).json()).toMatchObject({ reverted: true, threadId: "p-new" });
    expect([...(await Effect.runPromise(env.personal.getThread("p-new")))!.labels].sort()).toEqual(["INBOX", "UNREAD"]);
    expect((await env.post("/api/a/personal/threads/nope/ai", {})).status).toBe(404);
    expect((await env.post("/api/a/personal/threads/p-new/ai", {}, {})).status).toBe(403);
  });

  test("accepting suggested labels applies them in Gmail; rejecting just clears them", async () => {
    await Effect.runPromise(env.personal.setGhostLabels("p-new", ["Receipts"]));
    const accepted = await env.post("/api/a/personal/threads/p-new/ghost", { decision: "accept" });
    expect(await accepted.json()).toMatchObject({ thread: { ghostLabels: [], labels: expect.arrayContaining(["Receipts", "INBOX"]) } });
    expect(env.gmailCalls.map((call) => [call.path, call.body])).toEqual([
      ["/gmail/v1/users/me/threads/p-new/modify", { addLabelIds: ["Label_1"], removeLabelIds: [] }],
    ]);
    await Effect.runPromise(env.personal.setGhostLabels("p-old", ["Travel"]));
    expect(await (await env.post("/api/a/personal/threads/p-old/ghost", { decision: "reject" })).json())
      .toMatchObject({ thread: { ghostLabels: [], labels: ["INBOX", "Receipts"] } });
    expect(env.gmailCalls).toHaveLength(1);
    expect((await env.post("/api/a/personal/threads/p-old/ghost", { decision: "maybe" })).status).toBe(400);
  });

  test("saves rules only when every rule is valid, and imports Inbox Zero exports", async () => {
    const send = (method: string, path: string, body: unknown) => env.call(path, {
      method, headers: { "Content-Type": "application/json", [LOCAL_REQUEST_HEADER]: "1" }, body: JSON.stringify(body),
    });
    const { rules } = await (await env.call("/api/a/personal/rules")).json() as { rules: { rules: Array<Record<string, unknown>> } };
    const invalid = await send("PUT", "/api/a/personal/rules", { rules: { ...rules, rules: [...rules.rules, { ...rules.rules[0], actions: [] }] } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ problems: [
      { rule: "Receipts", message: "Rule has no actions." },
      { rule: "Receipts", message: "Another rule already uses this name." },
    ] });

    const events: string[] = [];
    env.events.subscribe("personal", (event) => events.push(event.type));
    const valid = await send("PUT", "/api/a/personal/rules", { rules: { ...rules, rules: [{ ...rules.rules[0], automate: false }] } });
    expect(await valid.json()).toMatchObject({ rules: { rules: [{ name: "Receipts", automate: false }] }, problems: [] });
    expect(events).toEqual(["rules-changed"]);

    const exported = [
      { name: "Newsletter", instructions: "Newsletters", enabled: true, automate: true, runOnThreads: false, systemType: "NEWSLETTER", conditionalOperator: "AND", actions: [{ type: "LABEL", label: "Newsletter" }] },
      { name: "Receipts", instructions: "Duplicate of an existing rule", enabled: true, automate: true, runOnThreads: false, systemType: null, conditionalOperator: "AND", actions: [{ type: "ARCHIVE" }] },
      { name: "Webhook", instructions: "x", actions: [{ type: "CALL_WEBHOOK", url: "https://example.com" }] },
    ];
    const appended = await (await env.post("/api/a/personal/rules/import", { export: exported, mode: "append" })).json() as Record<string, unknown>;
    expect(appended).toMatchObject({ imported: ["Newsletter", "Receipts"], skipped: [{ rule: "Webhook" }, { rule: "Webhook" }] });
    expect((appended.rules as { rules: Array<{ name: string }>; llmEndpointId: string }).rules.map((rule) => rule.name)).toEqual(["Receipts", "Newsletter"]);
    expect((appended.rules as { llmEndpointId: string }).llmEndpointId).toBe("mock");
    const replaced = await (await env.post("/api/a/work/rules/import", { export: exported, mode: "replace" })).json() as { rules: { rules: Array<{ name: string }> } };
    expect(replaced.rules.rules.map((rule) => rule.name)).toEqual(["Newsletter", "Receipts"]);
    // Each account keeps its own copy.
    expect((await (await env.call("/api/a/personal/rules")).json() as { rules: { rules: unknown[] } }).rules.rules).toHaveLength(2);

    await Effect.runPromise(env.personal.writeRulesFile('{"version":1,"llmEndpointId":null,"rules":[{"name":"Broken"}]}'));
    expect((await env.post("/api/a/personal/rules/import", { export: exported, mode: "append" })).status).toBe(409);
    expect((await env.post("/api/a/personal/rules/import", { export: { not: "an array" } })).status).toBe(400);
  });

  test("LLM endpoints are shared, and API keys are write-only", async () => {
    const send = (body: unknown, headers: Record<string, string> = { [LOCAL_REQUEST_HEADER]: "1" }) =>
      env.call("/api/llm-endpoints", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await send({ id: "x", baseUrl: "https://api.example.com/v1", modelId: "m", apiMode: "responses", apiKey: "k" }, {})).status).toBe(403);
    expect((await send({ id: "new", baseUrl: "https://api.example.com/v1", modelId: "m", apiMode: "responses" })).status).toBe(400);
    expect((await send({ id: "bad id!", baseUrl: "https://api.example.com/v1", modelId: "m", apiMode: "responses", apiKey: "k" })).status).toBe(400);
    expect((await send({ id: "x", baseUrl: "file:///etc", modelId: "m", apiMode: "responses", apiKey: "k" })).status).toBe(400);

    const created = await send({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelId: "gpt-x", apiMode: "responses", apiKey: "sk-secret" });
    const body = await created.text();
    expect(created.status).toBe(200);
    expect(body).not.toContain("sk-secret");
    expect(body).not.toContain("apiKey");
    expect(JSON.parse(body).endpoints.map((endpoint: { id: string }) => endpoint.id).sort()).toEqual(["mock", "openai"]);
    // Updating without a key keeps the stored one.
    await send({ id: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-y", apiMode: "chat_completions" });
    const stored = await Effect.runPromise(env.registry.getLlmEndpoint("openai"));
    expect(stored).toMatchObject({ modelId: "gpt-y", apiMode: "chat_completions" });
    expect(vault.decrypt<string>(stored!.apiKeyEnc)).toBe("sk-secret");
  });

  test("suggests replies with Gmail's reply / reply-all rules and the alias the mail was sent to", async () => {
    await Effect.runPromise(env.personal.replaceSendAsAliases([
      // Gmail reports no verification status for the primary address.
      { sendAsEmail: "me@example.com", displayName: "Me", replyToAddress: null, signatureHtml: null, isPrimary: true, isDefault: true, verificationStatus: "unknown" },
      { sendAsEmail: "support@example.com", displayName: "Support", replyToAddress: null, signatureHtml: "<p>-- The team</p>", isPrimary: false, isDefault: false, verificationStatus: "accepted" },
      { sendAsEmail: "pending@example.com", displayName: "Pending", replyToAddress: null, signatureHtml: null, isPrimary: false, isDefault: false, verificationStatus: "pending" },
    ]));
    await Effect.runPromise(env.personal.upsertThread({
      id: "t-help", subject: "Need help", senderSummary: "Ann <ann@client.example>", labels: ["INBOX"], lastMessageAt: 10,
      isUnread: false, isStarred: false, isArchived: false,
    }));
    await Effect.runPromise(env.personal.upsertMessage({
      id: "help-1", threadId: "t-help", fromAddress: "Ann <ann@client.example>", toAddresses: ["support@example.com"],
      ccAddresses: ["Bob <bob@client.example>", "me@example.com"], deliveredTo: "support@example.com", dateTs: 10,
      bodyMarkdown: "Can you help?\nThanks", bodyHtmlSanitized: "", labels: ["INBOX"],
      rawHeaders: { "message-id": "<help-1@client.example>", references: "<earlier@client.example>", subject: "Need help" },
    }));

    const { draft } = await (await env.call("/api/a/personal/threads/t-help/reply")).json() as { draft: Record<string, unknown> };
    expect(draft).toEqual({
      messageId: "help-1",
      to: ["Ann <ann@client.example>"],
      cc: [],
      // Your own addresses (primary and aliases) never end up on reply-all.
      replyAllCc: ["Bob <bob@client.example>"],
      subject: "Re: Need help",
      fromAlias: "support@example.com",
      aliasMatch: "recipient",
      aliases: [
        { sendAsEmail: "me@example.com", displayName: "Me", isDefault: true, isPrimary: true },
        { sendAsEmail: "support@example.com", displayName: "Support", isDefault: false, isPrimary: false },
      ],
    });

    const send = (body: unknown) => env.post("/api/a/personal/threads/t-help/reply", body);
    expect((await send({ messageId: "help-1", to: [], cc: [], subject: "Re: Need help", body: "Hi", fromAlias: "support@example.com" })).status).toBe(400);
    expect((await send({ messageId: "help-1", to: ["ann@client.example"], cc: [], subject: "Re: Need help", body: "Hi", fromAlias: "pending@example.com" })).status).toBe(400);
    expect(env.repliesSent).toEqual([]);

    const sent = await send({ messageId: "help-1", to: ["Ann <ann@client.example>"], cc: ["Bob <bob@client.example>"], subject: "Re: Need help", body: "Sure, call me.", fromAlias: "support@example.com" });
    expect(await sent.json()).toEqual({ sent: { id: "sent-1", threadId: "t-help" } });
    expect(env.repliesSent).toEqual(["personal"]);
    const call = env.gmailCalls.find((entry) => entry.path === "/gmail/v1/users/me/messages/send")!;
    expect((call.body as { threadId: string }).threadId).toBe("t-help");
    const raw = Buffer.from((call.body as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain("From: Support <support@example.com>");
    expect(raw).toContain("To: Ann <ann@client.example>");
    expect(raw).toContain("Cc: Bob <bob@client.example>");
    expect(raw).toContain("In-Reply-To: <help-1@client.example>");
    expect(raw).toContain("References: <earlier@client.example> <help-1@client.example>");
    const plain = [...raw.matchAll(/text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)]
      .map((match) => Buffer.from(match[1]!.replace(/\r\n/g, ""), "base64").toString("utf8"))[0]!;
    expect(plain).toContain("Sure, call me.\n\n-- The team");
    expect(plain).toContain("Ann <ann@client.example> wrote:\n> Can you help?\n> Thanks");
  });

  test("sends a new message from the chosen alias as its own conversation, with Bcc", async () => {
    await Effect.runPromise(env.personal.replaceSendAsAliases([
      { sendAsEmail: "me@example.com", displayName: "Me", replyToAddress: null, signatureHtml: null, isPrimary: true, isDefault: true, verificationStatus: "unknown" },
      { sendAsEmail: "support@example.com", displayName: "Support", replyToAddress: null, signatureHtml: "<p>-- The team</p>", isPrimary: false, isDefault: false, verificationStatus: "accepted" },
      { sendAsEmail: "pending@example.com", displayName: "Pending", replyToAddress: null, signatureHtml: null, isPrimary: false, isDefault: false, verificationStatus: "pending" },
    ]));
    const { draft } = await (await env.call("/api/a/personal/compose")).json() as { draft: { fromAlias: string; aliases: Array<{ sendAsEmail: string }> } };
    expect(draft.fromAlias).toBe("me@example.com");
    expect(draft.aliases.map((alias) => alias.sendAsEmail)).toEqual(["me@example.com", "support@example.com"]);

    expect((await env.post("/api/a/personal/messages", { to: [], cc: [], bcc: [], subject: "x", body: "hi", fromAlias: "me@example.com" })).status).toBe(400);
    expect((await env.post("/api/a/personal/messages", { to: ["a@b.example"], subject: "x", body: "hi", fromAlias: "me@example.com" }, {})).status).toBe(403);

    const sent = await env.post("/api/a/personal/messages", {
      to: ["Ann <ann@client.example>"], cc: [], bcc: ["audit@example.com"], subject: "Kickoff", body: "Hello Ann.", fromAlias: "support@example.com",
    });
    expect(sent.status).toBe(200);
    expect(env.repliesSent).toEqual(["personal"]);
    const call = env.gmailCalls.find((entry) => entry.path === "/gmail/v1/users/me/messages/send")!;
    expect((call.body as { threadId?: string }).threadId).toBeUndefined();
    const raw = Buffer.from((call.body as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain("From: Support <support@example.com>");
    expect(raw).toContain("To: Ann <ann@client.example>");
    expect(raw).toContain("Bcc: audit@example.com");
    expect(raw).toContain("Subject: Kickoff");
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("Cc:");
  });

  test("a follow-up to your own message goes back to its recipients", async () => {
    await Effect.runPromise(env.personal.upsertThread({
      id: "t-mine", subject: "Re: Plans", senderSummary: "me@example.com", labels: ["SENT"], lastMessageAt: 10,
      isUnread: false, isStarred: false, isArchived: true,
    }));
    await Effect.runPromise(env.personal.upsertMessage({
      id: "mine-1", threadId: "t-mine", fromAddress: "me@example.com", toAddresses: ["Kim <kim@example.org>"], ccAddresses: [],
      deliveredTo: null, dateTs: 10, bodyMarkdown: "Still on?", bodyHtmlSanitized: "", labels: ["SENT"], rawHeaders: {},
    }));
    const { draft } = await (await env.call("/api/a/personal/threads/t-mine/reply")).json() as { draft: { to: string[]; subject: string } };
    expect(draft).toMatchObject({ to: ["Kim <kim@example.org>"], subject: "Re: Plans" });
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
  test("AI routes answer 503 when the labeller is not configured", async () => {
    const env = await makeEnvironment({ withAi: false });
    expect((await env.post("/api/a/personal/threads/p-new/ai", {})).status).toBe(503);
    expect((await env.post("/api/a/personal/ai/undo", {})).status).toBe(503);
    await env.api.close();
  });

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
      redirectUri: "http://127.0.0.1:3838/auth/google/callback",
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
