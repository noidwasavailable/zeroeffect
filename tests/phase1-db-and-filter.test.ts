import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { AccountDb, AccountDbTest, type ThreadRecord } from "../src/server/services/AccountDb";
import { BooleanFilter, BooleanFilterLive } from "../src/server/services/BooleanFilter";
import type { BooleanFilterService } from "../src/server/services/BooleanFilter";
import { FilterExprSchema } from "../src/shared/schemas";
import { makeTestLayers } from "./helpers/TestLayers";

const layers = makeTestLayers();

const accountService = (layer: ReturnType<typeof AccountDbTest>) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* AccountDb;
    }).pipe(Effect.provide(layer)),
  );

const filter: BooleanFilterService = Effect.runSync(
  Effect.gen(function* () {
    return yield* BooleanFilter;
  }).pipe(Effect.provide(BooleanFilterLive)),
);

const threads: ReadonlyArray<ThreadRecord> = [
  {
    id: "t1", subject: "Quarterly receipt", snippet: "receipt", lastMessageAt: 6,
    senderSummary: "Billing at Example.com", labels: ["INBOX", "AI/Receipts"],
    isUnread: true, isStarred: false, isArchived: false,
  },
  {
    id: "t2", subject: "Project launch", snippet: "launch", lastMessageAt: 5,
    senderSummary: "Alex Smith", labels: ["INBOX", "Work"],
    isUnread: false, isStarred: true, isArchived: false,
  },
  {
    id: "t3", subject: "Re: quarterly planning", snippet: "planning", lastMessageAt: 4,
    senderSummary: "Morgan Example", labels: ["Work", "Important"],
    isUnread: true, isStarred: true, isArchived: true,
  },
  {
    id: "t4", subject: "Newsletter: weekly digest", snippet: "news", lastMessageAt: 3,
    senderSummary: "news@example.net", labels: ["INBOX", "News"],
    isUnread: false, isStarred: false, isArchived: false,
  },
  {
    id: "t5", subject: "Re: receipt for travel", snippet: "travel", lastMessageAt: 2,
    senderSummary: "Travel Desk", labels: ["AI/Receipts", "Work"],
    isUnread: true, isStarred: false, isArchived: true,
  },
  {
    id: "t6", subject: "Personal note", snippet: "note", lastMessageAt: 1,
    senderSummary: "Jamie Doe", labels: ["Personal"],
    isUnread: false, isStarred: false, isArchived: true,
  },
];

const expressions = [
  "is:unread",
  "is:read",
  "is:starred",
  "is:archived",
  "label:INBOX",
  'label:"AI/Receipts"',
  "from:example.com",
  'from:"Alex Smith"',
  "subject:receipt",
  "is:unread AND label:Work",
  "is:unread OR is:starred",
  "is:unread AND (label:Work OR label:News)",
  "is:unread AND (label:Work OR label:News OR label:Personal)",
  "NOT is:unread",
  "NOT (is:unread OR is:starred)",
  "is:unread AND NOT is:archived",
  "(is:unread OR is:starred) AND NOT label:News",
  "NOT (label:INBOX AND (subject:newsletter OR from:travel))",
  "is:unread OR (is:starred AND (label:Important OR subject:receipt))",
  "NOT (NOT is:unread)",
  'subject:"quarterly planning"',
  'subject:"100%_complete"',
] as const;

describe("Phase 1: account silos and Boolean filter", () => {
  afterAll(() => layers.close());

  test("keeps identical thread IDs in physically separate personal and work databases", async () => {
    const personal = accountService(layers.personal);
    const work = accountService(layers.work);
    const personalThread = threads[0]!;
    const workThread = { ...threads[1]!, id: personalThread.id };

    await Effect.runPromise(personal.upsertThread(personalThread));
    await Effect.runPromise(work.upsertThread(workThread));

    expect((await Effect.runPromise(personal.getThread(personalThread.id)))?.subject).toBe("Quarterly receipt");
    expect((await Effect.runPromise(work.getThread(personalThread.id)))?.subject).toBe("Project launch");
  });

  test("compiles every DSL expression to SQL equivalent to the in-memory evaluator", async () => {
    const account = accountService(layers.personal);
    for (const thread of threads) await Effect.runPromise(account.upsertThread(thread));

    for (const dsl of expressions) {
      const expression = Effect.runSync(filter.parse(dsl));
      const compiled = filter.compile(expression);
      const sqlMatches = await Effect.runPromise(account.queryThreads(compiled));
      const expected = threads.filter((thread) => filter.evaluate(expression, thread));
      expect(sqlMatches.map((thread) => thread.id).sort(), dsl).toEqual(expected.map((thread) => thread.id).sort());
    }
  });

  test("rejects malformed syntax and unsupported fields with a typed parse error", () => {
    for (const dsl of ["", "is:unread AND", "(is:unread", "is:unread OR )", "label:", "has:attachment", 'subject:"unfinished']) {
      const result = Effect.runSync(Effect.result(filter.parse(dsl)));
      expect(result._tag, dsl).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("FilterParseError");
        expect(result.failure.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("validates recursive Boolean ASTs with the shared Effect Schema", () => {
    const decode = Schema.decodeUnknownSync(FilterExprSchema);
    const ast = Effect.runSync(filter.parse("is:unread AND (label:Work OR NOT subject:newsletter)"));

    expect(decode(ast)).toEqual(ast);
    expect(() => decode({ _tag: "Is", value: "snoozed" })).toThrow();
    expect(() => decode({ _tag: "Contains", field: "body", value: "receipt" })).toThrow();
  });
});
