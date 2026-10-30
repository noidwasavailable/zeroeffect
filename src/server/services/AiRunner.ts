import { Effect, Layer, ManagedRuntime } from "effect";
import type { AccountEventBus } from "../routes/sse";
import { AccountDb, AccountDbLive } from "./AccountDb";
import { AiRuleWorker, AiRuleWorkerLive, type AiRunResult } from "./AiRuleWorker";
import { BooleanFilterLive } from "./BooleanFilter";
import type { GmailAccessTokenProvider } from "./GmailAccessTokens";
import { GmailClientLive } from "./GmailClient";
import { LlmProviderLive, type LlmProviderConfig } from "./LlmProvider";
import type { OAuthTokenVault } from "./OAuthTokenVault";
import { RegistryDb, type RegistryDbService } from "./RegistryDb";

export interface AiRunnerConfig {
  readonly registry: RegistryDbService;
  readonly tokens: GmailAccessTokenProvider;
  readonly vault: OAuthTokenVault;
  readonly events?: AccountEventBus;
  readonly accountDataDirectory?: string;
  readonly gmailApiBaseUrl?: string;
  readonly llm?: LlmProviderConfig;
  /** Opens an account's silo; defaults to its SQLite file (tests pass in-memory silos). */
  readonly accountDbLayer?: (accountId: string) => Layer.Layer<AccountDb, unknown>;
}

export interface AiRunner {
  readonly runThread: (accountId: string, threadId: string, trigger: "auto" | "manual") => Promise<AiRunResult>;
  /** Classifies new mail after a sync; failures are logged per thread and never stop the batch. */
  readonly runNewMail: (accountId: string, threadIds: ReadonlyArray<string>) => Promise<void>;
  readonly undo: (accountId: string) => Promise<{ readonly reverted: boolean; readonly auditId?: string; readonly threadId?: string }>;
}

/** Runs the AI labeller for one account at a time (per account), each run with fresh Gmail credentials. */
export const createAiRunner = (config: AiRunnerConfig): AiRunner => {
  // Runs for one account are serialized so overlapping syncs never race on the same thread's labels.
  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <A>(accountId: string, task: () => Promise<A>): Promise<A> => {
    const next = (queues.get(accountId) ?? Promise.resolve()).catch(() => undefined).then(task);
    queues.set(accountId, next);
    void next.finally(() => {
      if (queues.get(accountId) === next) queues.delete(accountId);
    }).catch(() => undefined);
    return next;
  };

  const withWorker = async <A>(accountId: string, use: (worker: AiRuleWorker["Service"]) => Effect.Effect<A, unknown>): Promise<A> => {
    const { accessToken } = await config.tokens.get(accountId);
    const dependencies = Layer.mergeAll(
      config.accountDbLayer?.(accountId) ?? AccountDbLive(accountId, config.accountDataDirectory),
      BooleanFilterLive,
      GmailClientLive({ accessToken, apiBaseUrl: config.gmailApiBaseUrl }),
      LlmProviderLive(config.llm),
      Layer.succeed(RegistryDb, config.registry),
    );
    const runtime = ManagedRuntime.make(Layer.provide(AiRuleWorkerLive(config.vault), dependencies));
    try {
      return await runtime.runPromise(Effect.gen(function* () { return yield* use(yield* AiRuleWorker); }));
    } finally {
      await runtime.dispose();
    }
  };

  const notify = (accountId: string, threadIds?: ReadonlyArray<string>) =>
    config.events?.publish(accountId, { type: "threads-changed", ...(threadIds ? { threadIds } : {}) });

  return {
    runThread: (accountId, threadId, trigger) => enqueue(accountId, async () => {
      const result = await withWorker(accountId, (worker) => worker.runForThread(threadId, { trigger }));
      notify(accountId, [threadId]);
      return result;
    }),
    runNewMail: (accountId, threadIds) => threadIds.length === 0 ? Promise.resolve() : enqueue(accountId, async () => {
      await withWorker(accountId, (worker) => Effect.forEach(threadIds, (threadId) => worker.runForThread(threadId, { trigger: "auto" }).pipe(
        Effect.tap((result) => Effect.logInfo(`AI labeller (${accountId}) ${threadId}: ${result.status}${result.appliedRules.length ? ` → ${result.appliedRules.join(", ")}` : ""}${result.llmCalled ? "" : " (no LLM call)"}`)),
        Effect.catch((error) => Effect.logError(`AI labeller failed for ${accountId} thread ${threadId}: ${String((error as { message?: unknown }).message ?? error)}`)),
      ), { discard: true }));
      notify(accountId, threadIds);
    }),
    undo: (accountId) => enqueue(accountId, async () => {
      const result = await withWorker(accountId, (worker) => worker.undoAiAction());
      if (result.threadId) notify(accountId, [result.threadId]);
      return result;
    }),
  };
};
