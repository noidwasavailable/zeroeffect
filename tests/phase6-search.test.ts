import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { readUnicode61Runs } from "../scripts/generate-unicode61-table";
import { fromBuilder, toBuilder } from "../src/client/filterBuilderModel";
import { createApiHandler } from "../src/server/routes/api";
import { createAccountEventBus } from "../src/server/routes/sse";
import { AccountDb, AccountDbTest, type AccountDbService, type MessageRecord } from "../src/server/services/AccountDb";
import { BooleanFilter, BooleanFilterLive, type BooleanFilterService } from "../src/server/services/BooleanFilter";
import { createGmailAccessTokenProvider } from "../src/server/services/GmailAccessTokens";
import type { GoogleOAuth2Api } from "../src/server/services/GoogleOAuth2";
import type { AttachmentRecord } from "../src/server/services/MimeParser";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbTest } from "../src/server/services/RegistryDb";
import type { AccountId, ThreadSummary } from "../src/shared/api";
import { containsTextSearch, formatFilterExpr } from "../src/shared/filterDsl";
import { parseFilterDsl } from "../src/shared/filterParser";
import { FilterExprSchema, type FilterExpr, type FilterThread } from "../src/shared/schemas";
import { threadMatchesSearch, tokenizeSearchText, toFtsMatchQuery } from "../src/shared/searchText";
import { RUN_STARTS, RUN_VALUES } from "../src/shared/unicode61Table";

const closeables: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const item of closeables) item.close();
});

const serviceOf = (database: Database, accountId = "personal"): AccountDbService =>
  Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(AccountDbTest(accountId, database))));

const filter: BooleanFilterService = Effect.runSync(
  Effect.gen(function* () { return yield* BooleanFilter; }).pipe(Effect.provide(BooleanFilterLive)),
);

const parse = (dsl: string): FilterExpr => {
  const result = parseFilterDsl(dsl);
  if (!result.ok) throw new Error(`${dsl}: ${result.message}`);
  return result.expression;
};

const attachment = (filename: string, inline = false): AttachmentRecord =>
  ({ partId: filename, filename, mimeType: "application/octet-stream", size: 1, contentId: inline ? filename : null, inline, attachmentId: null });

interface SeedThread {
  readonly id: string;
  readonly subject: string;
  readonly labels?: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<{ readonly from: string; readonly body: string; readonly attachments?: ReadonlyArray<AttachmentRecord> }>;
}

/** Synthetic threads covering English, Hangul with particles, accents, unusual case folds and attachments. */
const CORPUS: ReadonlyArray<SeedThread> = [
  {
    id: "s1", subject: "Quarterly Report", labels: ["INBOX", "UNREAD"],
    messages: [
      { from: "Alex <alex@acme.example>", body: "Please review the quarterly report draft before Friday." },
      { from: "Me <me@example.com>", body: "Budget numbers attached.", attachments: [attachment("Budget-2026.xlsx"), attachment("logo.png", true)] },
    ],
  },
  { id: "s2", subject: "보고서 제출", labels: ["INBOX"], messages: [{ from: "김민수 <minsu@work.example>", body: "보고서를 보냈습니다. 확인 부탁드립니다." }] },
  { id: "s3", subject: "Café meeting", labels: ["INBOX", "UNREAD"], messages: [{ from: "Zoë <zoe@example.com>", body: "Meet at the CAFÉ by the Crème Brûlée shop. Naïve résumé attached." }] },
  { id: "s4", subject: "Invoice #4521", labels: ["Paid"], messages: [{ from: "billing@vendor.example", body: "Your invoice is due. Unsubscribe here." }] },
  { id: "s5", subject: "Invoice #4522", labels: ["INBOX"], messages: [{ from: "billing@vendor.example", body: "A new invoice is ready." }] },
  { id: "s6", subject: "Report quarterly", labels: ["INBOX"], messages: [{ from: "Sam <sam@example.com>", body: "The report is quarterly." }] },
  { id: "s7", subject: "Notes quarterly", labels: ["INBOX"], messages: [{ from: "Sam <sam@example.com>", body: "report attached" }] },
  {
    id: "s8", subject: "Split words", labels: ["INBOX"],
    messages: [{ from: "Kai <kai@example.com>", body: "alpha" }, { from: "Kai <kai@example.com>", body: "beta" }],
  },
  { id: "s9", subject: "İSTANBUL trip", labels: ["INBOX"], messages: [{ from: "Ayşe <ayse@example.com>", body: "STRASSE or straße, ǅemal and ΆΘΗΝΑ." }] },
  // A thread without messages has no text to match.
  { id: "s10", subject: "quarterly report placeholder", labels: ["INBOX"], messages: [] },
];

const seed = async (db: AccountDbService, threads: ReadonlyArray<SeedThread>) => {
  for (const thread of threads) {
    const labels = thread.labels ?? [];
    await Effect.runPromise(db.upsertThread({
      id: thread.id, subject: thread.subject, senderSummary: thread.messages[0]?.from ?? "", labels, snippet: "",
      lastMessageAt: thread.messages.length, isUnread: labels.includes("UNREAD"), isStarred: false, isArchived: !labels.includes("INBOX"),
    }));
    for (const [index, message] of thread.messages.entries()) {
      const record: MessageRecord = {
        id: `${thread.id}-m${index}`, threadId: thread.id, fromAddress: message.from, toAddresses: ["me@example.com"], ccAddresses: [],
        deliveredTo: null, dateTs: index + 1, bodyMarkdown: message.body, bodyHtmlSanitized: "", rawHeaders: { subject: thread.subject },
        labels: [...labels], attachments: message.attachments ?? [],
      };
      await Effect.runPromise(db.upsertMessage(record));
    }
  }
};

/** The in-memory side of the law: each thread with its indexed text, as the AI worker loads it. */
const hydrate = async (db: AccountDbService): Promise<ReadonlyArray<FilterThread>> => {
  const threads = await Effect.runPromise(db.queryThreads({ sql: "1", params: [] }));
  return Promise.all(threads.map(async (thread) => ({ ...thread, searchDocuments: await Effect.runPromise(db.getThreadSearchDocuments(thread.id)) })));
};

const sqlMatches = async (db: AccountDbService, expression: FilterExpr) =>
  (await Effect.runPromise(db.queryThreads(filter.compile(expression)))).map((thread) => thread.id).sort();

const memoryMatches = (threads: ReadonlyArray<FilterThread>, expression: FilterExpr) =>
  threads.filter((thread) => filter.evaluate(expression, thread)).map((thread) => thread.id).sort();

describe("Phase 6: the search tokenizer is SQLite's unicode61", () => {
  test("the committed per-code-point table matches SQLite's tokenizer for every code point", () => {
    const runs = readUnicode61Runs();
    expect(runs.starts).toEqual([...RUN_STARTS]);
    expect(runs.values).toEqual([...RUN_VALUES]);
  });

  test("folds case and Latin diacritics, keeps Hangul syllables whole and splits on everything else", () => {
    expect(tokenizeSearchText("Crème BRÛLÉE, naïve—coöperate")).toEqual(["creme", "brulee", "naive", "cooperate"]);
    expect(tokenizeSearchText("보고서를 보냈습니다.")).toEqual(["보고서를", "보냈습니다"]);
    expect(tokenizeSearchText("İSTANBUL straße ǅemal ΆΘΗΝΑ")).toEqual(["istanbul", "straße", "ǆemal", "άθηνα"]);
    expect(tokenizeSearchText("foo_bar-baz.qux 😀 école")).toEqual(["foo", "bar", "baz", "qux", "ecole"]);
    expect(tokenizeSearchText("!!! ---")).toEqual([]);
  });

  test("builds phrase-of-prefix MATCH queries that hold only token characters", () => {
    expect(toFtsMatchQuery("Quarterly rep")).toBe('"quarterly"* + "rep"*');
    expect(toFtsMatchQuery('x" OR 1=1 -- NEAR(a b) ^c*')).toBe('"x"* + "or"* + "1"* + "1"* + "near"* + "a"* + "b"* + "c"*');
    expect(toFtsMatchQuery("***")).toBeNull();
    expect(threadMatchesSearch("보고서", [["", "", "보고서를 보냈습니다", ""]])).toBe(true);
    expect(threadMatchesSearch("고서", [["", "", "보고서를 보냈습니다", ""]])).toBe(false);
  });
});

describe("Phase 6: Text in the shared DSL, formatter, schema and builder", () => {
  test("bare words, quoted phrases and text: parse to Text nodes, side by side meaning AND", () => {
    expect(parse("invoice")).toEqual({ _tag: "Text", value: "invoice" });
    expect(parse('"quarterly report" OR budget')).toEqual({ _tag: "Or", expressions: [{ _tag: "Text", value: "quarterly report" }, { _tag: "Text", value: "budget" }] });
    expect(parse('text:"quarterly report"')).toEqual({ _tag: "Text", value: "quarterly report" });
    expect(parse("invoice AND from:\"acme\" AND NOT label:Paid")).toEqual({
      _tag: "And",
      expressions: [{ _tag: "Text", value: "invoice" }, { _tag: "Contains", field: "from", value: "acme" }, { _tag: "Not", expression: { _tag: "Label", value: "Paid" } }],
    });
    expect(parse("invoice from:acme OR budget")).toEqual({
      _tag: "Or",
      expressions: [{ _tag: "And", expressions: [{ _tag: "Text", value: "invoice" }, { _tag: "Contains", field: "from", value: "acme" }] }, { _tag: "Text", value: "budget" }],
    });
    // Quoted keywords, colons and parentheses are search text, not syntax.
    expect(parse('"not" AND "from:x"')).toEqual({ _tag: "And", expressions: [{ _tag: "Text", value: "not" }, { _tag: "Text", value: "from:x" }] });
    expect(parse('"(a)"')).toEqual({ _tag: "Text", value: "(a)" });
  });

  test("rejects search text without letters or digits and unknown fields, with offsets", () => {
    expect(parseFilterDsl("label:Work AND !!!")).toEqual({ ok: false, message: "Search text needs at least one letter or digit.", offset: 15 });
    expect(parseFilterDsl('text:"..."')).toMatchObject({ ok: false, offset: 0 });
    expect(parseFilterDsl("has:attachment")).toMatchObject({ ok: false, message: "Unsupported filter field 'has'. Quote the text to search for it." });
    expect(parseFilterDsl("invoice OR")).toMatchObject({ ok: false, offset: 10 });
  });

  test("the formatter writes text:… and round-trips through the parser", () => {
    for (const dsl of ["invoice", '"quarterly report"', "보고서 OR 확인", 'NOT (text:"due. unsubscribe" AND label:Paid)', '"not" "from:x"', "naïve résumé", '"a \\"quoted\\" word"']) {
      const expression = parse(dsl);
      expect(parse(formatFilterExpr(expression)), dsl).toEqual(expression);
    }
    expect(formatFilterExpr(parse('invoice "quarterly report"'))).toBe('text:invoice AND text:"quarterly report"');
    expect(containsTextSearch(parse("label:A OR NOT (is:unread AND invoice)"))).toBe(true);
    expect(containsTextSearch(parse("label:A OR NOT is:unread"))).toBe(false);
  });

  test("the Effect Schema and the visual builder carry Text nodes", () => {
    const decode = Schema.decodeUnknownSync(FilterExprSchema);
    expect(decode({ _tag: "Text", value: "invoice" })).toEqual({ _tag: "Text", value: "invoice" });
    expect(() => decode({ _tag: "Text" })).toThrow();

    const expression = parse('NOT "quarterly report" AND label:Work');
    const tree = toBuilder(expression);
    expect(tree.children[0]).toMatchObject({ kind: "condition", field: "text", value: "quarterly report", negated: true });
    expect(fromBuilder(tree)).toEqual({ ok: true, expression });
    const blank = { ...tree, children: [{ ...tree.children[0]!, value: "…" }] };
    expect(fromBuilder(blank)).toMatchObject({ ok: false, error: "Enter a letter or digit to search for." });
  });
});

/** Text expressions for the equivalence law, with what they must match in CORPUS. */
const TEXT_MATRIX: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["quarterly", ["s1", "s6", "s7"]],
  ["QUART", ["s1", "s6", "s7"]],
  ['"quarterly report"', ["s1"]],
  ['"quarterly rep"', ["s1"]],
  ['"report quarterly"', ["s6"]],
  ['"uarterly"', []],
  ["보고서", ["s2"]],
  ["보고", ["s2"]],
  ['"보고서를 보냈"', ["s2"]],
  ["확인", ["s2"]],
  ["고서", []],
  ["cafe", ["s3"]],
  ["CAFÉ", ["s3"]],
  ['"creme brulee"', ["s3"]],
  ['"Crème Brûlée"', ["s3"]],
  ["naive resume", ["s3"]],
  ["zoe", ["s3"]],
  ["budget-2026", ["s1"]],
  ["xlsx", ["s1"]],
  ["logo", []],
  ["alex", ["s1"]],
  ["acme.example", ["s1"]],
  ["invoice", ["s4", "s5"]],
  ["4521", ["s4"]],
  ['text:"due. unsubscribe"', ["s4"]],
  ['"alpha beta"', []],
  ["alpha beta", ["s8"]],
  ["alpha AND beta", ["s8"]],
  ["istanbul", ["s9"]],
  ["strasse", ["s9"]],
  ["straße", ["s9"]],
  ["ǅemal", ["s9"]],
  ["άθηνα", ["s9"]],
  ["αθηνα", []],
  ["placeholder", []],
  ["zzz", []],
  ['"NEAR(a b)" OR "x\\" OR 1=1"', []],
];

/** Text mixed with every other node type and with NOT. */
const MIXED_MATRIX: ReadonlyArray<string> = [
  "NOT quarterly",
  "NOT (report OR 보고서)",
  "invoice AND NOT label:Paid",
  "invoice AND label:Paid",
  "is:unread AND (report OR cafe)",
  "NOT NOT budget",
  "(quarterly OR invoice) AND NOT (from:vendor AND due)",
  "label:INBOX AND NOT (alpha OR istanbul OR 보고)",
  'subject:invoice AND NOT "new invoice"',
  "is:archived OR (NOT is:unread AND (text:report OR subject:split))",
  "NOT (quarterly AND NOT (is:unread OR label:Paid))",
];

describe("Phase 6: AST equivalence law for Text (AGENTS.md §3.3)", () => {
  const database = new Database(":memory:");
  closeables.push(database);
  const db = serviceOf(database);

  test("SQLite MATCH and the in-memory evaluator agree on every expression and thread", async () => {
    await seed(db, CORPUS);
    const threads = await hydrate(db);
    expect(threads).toHaveLength(CORPUS.length);

    for (const [dsl, expected] of TEXT_MATRIX) {
      const expression = parse(dsl);
      expect(await sqlMatches(db, expression), dsl).toEqual([...expected].sort());
      expect(memoryMatches(threads, expression), dsl).toEqual([...expected].sort());
    }
    for (const dsl of MIXED_MATRIX) {
      const expression = parse(dsl);
      expect(memoryMatches(threads, expression), dsl).toEqual(await sqlMatches(db, expression));
    }
    // Every Text value, negated and combined with each other one, still agrees.
    const values = TEXT_MATRIX.map(([dsl]) => parse(dsl));
    for (const left of values) {
      for (const right of values.slice(0, 8)) {
        for (const expression of [
          { _tag: "Or", expressions: [left, { _tag: "Not", expression: right }] },
          { _tag: "And", expressions: [{ _tag: "Not", expression: left }, right] },
        ] satisfies FilterExpr[]) {
          expect(memoryMatches(threads, expression), formatFilterExpr(expression)).toEqual(await sqlMatches(db, expression));
        }
      }
    }
  });

  test("Text nodes without tokens (e.g. from a decoded AST) match nothing in either target", async () => {
    const threads = await hydrate(db);
    for (const expression of [{ _tag: "Text", value: "!!!" }, { _tag: "Text", value: "" }] satisfies FilterExpr[]) {
      expect(filter.compile(expression)).toEqual({ sql: "(0)", params: [] });
      expect(memoryMatches(threads, expression)).toEqual([]);
      expect(await sqlMatches(db, { _tag: "Not", expression })).toHaveLength(CORPUS.length);
    }
  });

  test("search values are bound as quoted prefix queries, never interpolated", () => {
    const compiled = filter.compile(parse('text:"x\\" OR 1=1; DROP TABLE threads --"'));
    expect(compiled.sql).toBe("(threads.id IN (SELECT thread_id FROM messages_fts WHERE messages_fts MATCH ?))");
    expect(compiled.params).toEqual(['"x"* + "or"* + "1"* + "1"* + "drop"* + "table"* + "threads"*']);
  });
});

describe("Phase 6: the search index", () => {
  test("attachment names and subject changes are reindexed; inline images are not searchable", async () => {
    const database = new Database(":memory:");
    closeables.push(database);
    const db = serviceOf(database);
    await seed(db, [CORPUS[0]!]);
    const ids = async (dsl: string) => sqlMatches(db, parse(dsl));

    expect(await ids("logo")).toEqual([]);
    await Effect.runPromise(db.setMessageAttachments("s1-m0", [attachment("Contract_signed.pdf")]));
    expect(await ids('"contract signed"')).toEqual(["s1"]);

    await Effect.runPromise(db.upsertThread({
      id: "s1", subject: "Renamed thread", senderSummary: "Alex", labels: ["INBOX"], snippet: "",
      lastMessageAt: 10, isUnread: false, isStarred: false, isArchived: false,
    }));
    expect(await ids("renamed")).toEqual(["s1"]);
    expect(await ids('"quarterly report" AND NOT draft')).toEqual([]);
  });

  test("databases with the v1 index are rebuilt with the shared tokenizer and attachment names", async () => {
    const database = new Database(":memory:");
    closeables.push(database);
    await seed(serviceOf(database), [CORPUS[0]!, CORPUS[2]!]);
    // Recreate the pre-Phase 6 index: default tokenizer options, no attachment names.
    database.exec(`
      DROP TABLE messages_fts;
      CREATE VIRTUAL TABLE messages_fts USING fts5(thread_id UNINDEXED, subject, from_address, body_markdown);
      INSERT INTO messages_fts (thread_id, subject, from_address, body_markdown)
        SELECT messages.thread_id, threads.subject, messages.from_address, messages.body_markdown
        FROM messages JOIN threads ON threads.id = messages.thread_id;
      DELETE FROM schema_migrations WHERE id = 'messages-fts-v2';
    `);

    const db = serviceOf(database);
    const sql = (database.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").get() as { sql: string }).sql;
    expect(sql).toContain("attachment_names");
    expect(sql).toContain("remove_diacritics 2");
    expect(await sqlMatches(db, parse("xlsx"))).toEqual(["s1"]);
    expect(await sqlMatches(db, parse('"creme brulee"'))).toEqual(["s3"]);
    expect(await Effect.runPromise(db.getThreadSearchDocuments("s1"))).toEqual([
      ["Quarterly Report", "Alex <alex@acme.example>", "Please review the quarterly report draft before Friday.", ""],
      ["Quarterly Report", "Me <me@example.com>", "Budget numbers attached.", "Budget-2026.xlsx"],
    ]);
  });
});

describe("Phase 6: search through the API stays inside the account's silo", () => {
  test("plain words in q search the view; parse errors are 400s", async () => {
    const vault = OAuthTokenVault.fromKey(new Uint8Array(32).fill(6));
    const registryDatabase = new Database(":memory:");
    const silos = { personal: new Database(":memory:"), work: new Database(":memory:") };
    closeables.push(registryDatabase, silos.personal, silos.work);
    const registry = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(RegistryDbTest(registryDatabase))));
    for (const id of ["personal", "work"] as const) {
      await Effect.runPromise(registry.upsertAccount({ id, email: `${id}@example.com`, displayName: id, colorTheme: "blue", createdAt: 1, oauthTokensEnc: vault.encrypt({}) }));
    }
    await seed(serviceOf(silos.personal, "personal"), CORPUS);
    await seed(serviceOf(silos.work, "work"), [{ id: "w1", subject: "Work 보고서", labels: ["INBOX"], messages: [{ from: "boss@work.example", body: "주간 보고서" }] }]);
    const unusedOAuth: GoogleOAuth2Api = {
      authorizationUrl: () => new URL("http://127.0.0.1/unused"),
      exchangeCode: () => Effect.die("unused"),
      refreshAccessToken: () => Effect.die("unused"),
    };
    const api = createApiHandler({
      registry,
      tokens: createGmailAccessTokenProvider({ registry, oauth: unusedOAuth, vault }),
      events: createAccountEventBus(),
      gmailApiBaseUrl: "http://127.0.0.1:9/gmail/v1",
      accountDbLayer: (accountId: AccountId) => AccountDbTest(accountId, silos[accountId]),
    });
    const list = async (accountId: AccountId, view: string, q: string) => {
      const url = new URL(`http://localhost/api/a/${accountId}/threads?view=${view}&q=${encodeURIComponent(q)}`);
      return (await api.handle(new Request(url), url))!;
    };
    const ids = async (accountId: AccountId, view: string, q: string) =>
      ((await (await list(accountId, view, q)).json()) as { threads: ThreadSummary[] }).threads.map((thread) => thread.id).sort();

    expect(await ids("personal", "all", "보고서")).toEqual(["s2"]);
    expect(await ids("work", "all", "보고서")).toEqual(["w1"]);
    expect(await ids("personal", "all", "invoice NOT label:Paid")).toEqual(["s5"]);
    expect(await ids("personal", "inbox", "quarterly")).toEqual(["s1", "s6", "s7"]);
    const invalid = await list("personal", "all", "!!!");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("letter or digit"), offset: 0 });
  });
});
