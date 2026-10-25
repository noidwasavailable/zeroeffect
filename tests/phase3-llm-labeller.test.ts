import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { AccountDb, AccountDbTest, type ThreadRecord } from "../src/server/services/AccountDb";
import { AiRuleWorker, AiRuleWorkerLive } from "../src/server/services/AiRuleWorker";
import { BooleanFilterLive } from "../src/server/services/BooleanFilter";
import { GmailClient, type GmailClientService } from "../src/server/services/GmailClient";
import { LlmProvider, LlmProviderLive } from "../src/server/services/LlmProvider";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbTest } from "../src/server/services/RegistryDb";
import { LabellingDecisionSchema, type LabellingDecision } from "../src/shared/schemas";

const decision: LabellingDecision = {
  matched: true,
  labelsToAdd: ["AI/New"],
  labelsToRemove: ["Old"],
  archive: true,
  confidence: 0.98,
  reasoning: "This is a completed invoice.",
};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const json = JSON.stringify(decision);
    if (new URL(request.url).pathname.endsWith("/responses")) {
      return Response.json({ output_text: json });
    }
    if (new URL(request.url).pathname.endsWith("/chat/completions")) {
      return Response.json({ choices: [{ message: { content: json } }] });
    }
    return Response.json({ error: "unexpected path", body }, { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("Phase 3: dual-mode LLM auto-labeller", () => {
  test("sends structured-output requests to both API modes and validates decisions", async () => {
    const layer = LlmProviderLive();
    const provider = Effect.runSync(Effect.gen(function* () { return yield* LlmProvider; }).pipe(Effect.provide(layer)));
    for (const apiMode of ["responses", "chat_completions"] as const) {
      const result = await Effect.runPromise(provider.decide(
        { baseUrl: `${server.url}/v1`, modelId: "test-model" },
        "test-key",
        apiMode,
        "Classify this message.",
        "Subject: Invoice",
      ));
      expect(result).toEqual(decision);
      expect(LabellingDecisionSchema).toBeDefined();
    }

    const invalidServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ output_text: JSON.stringify({ ...decision, confidence: 2 }) }),
    });
    try {
      const invalidProvider = Effect.runSync(Effect.gen(function* () { return yield* LlmProvider; }).pipe(Effect.provide(LlmProviderLive())));
      const exit = await Effect.runPromiseExit(invalidProvider.decide(
        { baseUrl: invalidServer.url.toString(), modelId: "test-model" }, "test-key", "responses", "instructions", "input",
      ));
      expect(exit._tag).toBe("Failure");
    } finally {
      invalidServer.stop(true);
    }
  });

  test("evaluates preconditions, stores ghost labels, applies Gmail changes, audits, and undoes one action", async () => {
    const accountDatabase = new Database(":memory:");
    const registryDatabase = new Database(":memory:");
    const accountLayer = AccountDbTest("personal", accountDatabase);
    const registryLayer = RegistryDbTest(registryDatabase);
    const account = Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(accountLayer)));
    const registry = Effect.runSync(Effect.gen(function* () { return yield* RegistryDb; }).pipe(Effect.provide(registryLayer)));
    const thread: ThreadRecord = {
      id: "thread-1", subject: "Invoice paid", snippet: "Thanks for your payment", lastMessageAt: 10,
      senderSummary: "billing@example.com", labels: ["INBOX", "Old", "AI/New"], isUnread: true, isStarred: false, isArchived: false,
    };
    await Effect.runPromise(account.upsertThread(thread));
    await Effect.runPromise(account.upsertMessage({
      id: "message-1", threadId: thread.id, fromAddress: "billing@example.com", toAddresses: ["me@example.com"],
      ccAddresses: [], deliveredTo: null, dateTs: 10, bodyMarkdown: "Your invoice is paid.",
      bodyHtmlSanitized: "<p>Your invoice is paid.</p>", rawHeaders: {},
    }));
    accountDatabase.prepare(`
      INSERT INTO ai_rules (
        id, name, priority, enabled, dry_run, min_confidence, precondition_ast_json,
        system_prompt, actions_json, llm_endpoint_id, api_mode_override
      ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      "rule-1", "Invoice labels", 10, 0.8, JSON.stringify({ _tag: "Is", value: "unread" }),
      "Label paid invoices.", JSON.stringify({ addLabels: ["AI/New"], removeLabels: ["Old"], archive: true }),
      "endpoint-1", "chat_completions",
    );
    const vault = OAuthTokenVault.fromKey(new Uint8Array(32).fill(7));
    await Effect.runPromise(registry.upsertLlmEndpoint({
      id: "endpoint-1", name: "local test", baseUrl: `${server.url}/v1`,
      apiKeyEnc: vault.encrypt("test-key"), modelId: "test-model", apiMode: "responses",
    }));
    const gmailChanges: Array<{ id: string; add: ReadonlyArray<string>; remove: ReadonlyArray<string> }> = [];
    const gmail: GmailClientService = {
      getProfile: () => Effect.fail({} as never), listMessages: () => Effect.fail({} as never),
      getMessage: () => Effect.fail({} as never), listThreads: () => Effect.fail({} as never),
      getThread: () => Effect.fail({} as never), listHistory: () => Effect.fail({} as never),
      listSendAs: () => Effect.succeed([]), watch: () => Effect.fail({} as never),
      sendRaw: () => Effect.fail({} as never),
      modifyMessage: (id, add, remove) => Effect.sync(() => { gmailChanges.push({ id, add, remove }); }),
    };
    const dependencies = Layer.mergeAll(
      accountLayer,
      registryLayer,
      BooleanFilterLive,
      Layer.succeed(GmailClient, gmail),
      LlmProviderLive(),
    );
    const workerLayer = Layer.provide(AiRuleWorkerLive(vault), dependencies);
    const worker = Effect.runSync(Effect.gen(function* () { return yield* AiRuleWorker; }).pipe(Effect.provide(workerLayer)));

    expect(await Effect.runPromise(worker.runForThread(thread.id))).toEqual({ evaluatedRules: 1, appliedRules: ["rule-1"] });
    let current = await Effect.runPromise(account.getAiThreadContext(thread.id));
    expect(current?.thread.labels).toEqual(["INBOX", "Old", "AI/New"]);
    expect(current?.ghostLabels).toEqual(["AI/New"]);
    expect(gmailChanges).toHaveLength(0);
    expect(accountDatabase.prepare("SELECT COUNT(*) AS count FROM ai_audit_logs").get()).toEqual({ count: 1 });
    expect(await Effect.runPromise(worker.undoAiAction())).toMatchObject({ reverted: true });
    current = await Effect.runPromise(account.getAiThreadContext(thread.id));
    expect(current?.ghostLabels).toEqual([]);

    accountDatabase.prepare("UPDATE ai_rules SET dry_run = 0 WHERE id = 'rule-1'").run();
    expect(await Effect.runPromise(worker.runForThread(thread.id))).toEqual({ evaluatedRules: 1, appliedRules: ["rule-1"] });
    current = await Effect.runPromise(account.getAiThreadContext(thread.id));
    expect(current?.thread.labels).toEqual(["AI/New"]);
    expect(current?.thread.isArchived).toBe(true);
    expect(gmailChanges).toEqual([{ id: "message-1", add: [], remove: ["INBOX", "Old"] }]);

    expect(await Effect.runPromise(worker.undoAiAction())).toMatchObject({ reverted: true });
    current = await Effect.runPromise(account.getAiThreadContext(thread.id));
    expect(current?.thread.labels).toEqual(["INBOX", "Old", "AI/New"]);
    expect(current?.thread.isArchived).toBe(false);
    expect(gmailChanges[1]).toEqual({ id: "message-1", add: ["INBOX", "Old"], remove: [] });
    expect(accountDatabase.prepare("SELECT COUNT(*) AS count FROM ai_audit_logs WHERE reverted = 1").get()).toEqual({ count: 2 });
    accountDatabase.close();
    registryDatabase.close();
  });

  test("skips the LLM when a rule precondition does not match", async () => {
    const database = new Database(":memory:");
    const accountLayer = AccountDbTest("work", database);
    const account = Effect.runSync(Effect.gen(function* () { return yield* AccountDb; }).pipe(Effect.provide(accountLayer)));
    await Effect.runPromise(account.upsertThread({
      id: "read-thread", subject: "Already read", senderSummary: "someone", labels: [],
      isUnread: false, isStarred: false, isArchived: false,
    }));
    database.prepare(`INSERT INTO ai_rules (id, name, precondition_ast_json, system_prompt, actions_json, llm_endpoint_id)
      VALUES ('rule', 'Unread only', ?, '', '{}', 'missing')`).run(JSON.stringify({ _tag: "Is", value: "unread" }));
    const unusedGmail: GmailClientService = {
      getProfile: () => Effect.fail({} as never), listMessages: () => Effect.fail({} as never),
      getMessage: () => Effect.fail({} as never), listThreads: () => Effect.fail({} as never),
      getThread: () => Effect.fail({} as never), listHistory: () => Effect.fail({} as never),
      listSendAs: () => Effect.succeed([]), watch: () => Effect.fail({} as never),
      sendRaw: () => Effect.fail({} as never), modifyMessage: () => Effect.void,
    };
    const dependencies = Layer.mergeAll(
      accountLayer,
      RegistryDbTest(new Database(":memory:")),
      BooleanFilterLive,
      Layer.succeed(GmailClient, unusedGmail),
      LlmProviderLive(),
    );
    const worker = Effect.runSync(Effect.gen(function* () {
      return yield* AiRuleWorker;
    }).pipe(Effect.provide(Layer.provide(AiRuleWorkerLive(OAuthTokenVault.fromKey(new Uint8Array(32).fill(3))), dependencies))));
    expect(await Effect.runPromise(worker.runForThread("read-thread"))).toEqual({ evaluatedRules: 0, appliedRules: [] });
    expect(database.prepare("SELECT ai_status AS status FROM threads WHERE id = 'read-thread'").get()).toEqual({ status: "skipped" });
    database.close();
  });
});
