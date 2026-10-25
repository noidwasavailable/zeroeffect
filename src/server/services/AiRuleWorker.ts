import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { DatabaseError, GmailApiError, LlmEndpointError } from "../../shared/errors";
import type { LabellingDecision } from "../../shared/schemas";
import { AccountDb, type AiAppliedAction, type AiAuditRecord, type AiThreadContext, type AccountDbService } from "./AccountDb";
import { BooleanFilter, type BooleanFilterService } from "./BooleanFilter";
import { GmailClient, type GmailClientService } from "./GmailClient";
import { LlmProvider, type LlmProviderService } from "./LlmProvider";
import { RegistryDb, type RegistryDbService } from "./RegistryDb";
import { OAuthTokenVault } from "./OAuthTokenVault";

export interface AiRuleWorkerService {
  readonly runForThread: (threadId: string) => Effect.Effect<{
    readonly evaluatedRules: number;
    readonly appliedRules: ReadonlyArray<string>;
  }, DatabaseError | GmailApiError | LlmEndpointError>;
  readonly undoAiAction: () => Effect.Effect<{ readonly reverted: boolean; readonly auditId?: string }, DatabaseError | GmailApiError>;
}

export class AiRuleWorker extends Context.Service<AiRuleWorker, AiRuleWorkerService>()(
  "zeroeffect/AiRuleWorker",
) {}

const dedupe = (values: ReadonlyArray<string>): string[] => [...new Set(values)];

const addRemove = (initial: ReadonlyArray<string>, add: ReadonlyArray<string>, remove: ReadonlyArray<string>): string[] => {
  const removed = new Set(remove);
  return dedupe([...initial.filter((value) => !removed.has(value)), ...add]);
};

const difference = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): string[] => {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
};

const threadPrompt = (context: AiThreadContext): string => [
  `Subject: ${context.subject}`,
  `Sender: ${context.thread.senderSummary}`,
  `Snippet: ${context.snippet}`,
  ...context.messages.map((message) => `From: ${message.fromAddress}\n${message.bodyMarkdown}`),
].join("\n\n");

const makeService = (
  accountDb: AccountDbService,
  booleanFilter: BooleanFilterService,
  gmail: GmailClientService,
  llm: LlmProviderService,
  registry: RegistryDbService,
  vault: OAuthTokenVault,
): AiRuleWorkerService => ({
  runForThread: (threadId) => Effect.gen(function* () {
    const initialContext = yield* accountDb.getAiThreadContext(threadId);
    if (!initialContext) return { evaluatedRules: 0, appliedRules: [] };

    const rules = yield* accountDb.listEnabledAiRules();
    const appliedRules: string[] = [];
    let evaluatedRules = 0;

    for (const rule of rules) {
      const context = yield* accountDb.getAiThreadContext(threadId);
      if (!context || !booleanFilter.evaluate(rule.precondition, context.thread)) continue;
      evaluatedRules += 1;

      const encryptedEndpoint = yield* registry.getLlmEndpoint(rule.llmEndpointId);
      const apiMode = rule.apiModeOverride ?? encryptedEndpoint?.apiMode ?? "responses";
      if (!encryptedEndpoint) {
        return yield* Effect.fail(new LlmEndpointError({
          apiMode,
          message: `LLM endpoint '${rule.llmEndpointId}' was not found.`,
          rawBody: "",
        }));
      }
      const apiKey = yield* Effect.try({
        try: () => vault.decrypt<string>(encryptedEndpoint.apiKeyEnc),
        catch: () => new LlmEndpointError({ apiMode, message: "Could not decrypt the configured LLM API key.", rawBody: "" }),
      });
      const prompt = `${threadPrompt(context)}\n\nRule actions configuration:\n${JSON.stringify(rule.actions)}`;
      const llmStartedAt = performance.now();
      const decision = yield* llm.decide(
        encryptedEndpoint,
        apiKey,
        apiMode,
        rule.systemPrompt,
        prompt,
      );
      if (!decision.matched || decision.confidence < rule.minConfidence) continue;

      const labelsAfter = rule.dryRun
        ? [...context.thread.labels]
        : addRemove(
            context.thread.labels,
            decision.labelsToAdd,
            [...decision.labelsToRemove, ...(decision.archive ? ["INBOX"] : [])],
          ).filter((label) => !decision.archive || label !== "INBOX");
      const ghostLabelsAfter = addRemove(
        context.ghostLabels,
        decision.labelsToAdd,
        decision.labelsToRemove,
      );
      const archivedAfter = rule.dryRun
        ? context.thread.isArchived
        : !labelsAfter.includes("INBOX");
      const appliedAction: AiAppliedAction = {
        labelsBefore: context.thread.labels,
        labelsAdded: rule.dryRun ? [] : difference(labelsAfter, context.thread.labels),
        labelsRemoved: rule.dryRun ? [] : difference(context.thread.labels, labelsAfter),
        archivedBefore: context.thread.isArchived,
        archivedAfter,
        ghostLabelsBefore: context.ghostLabels,
        ghostLabelsAfter: rule.dryRun ? ghostLabelsAfter : context.ghostLabels,
        dryRun: rule.dryRun,
        gmailMessageIds: rule.dryRun ? [] : context.messages.map((message) => message.id),
      };

      if (!rule.dryRun) {
        for (const messageId of appliedAction.gmailMessageIds) {
          yield* gmail.modifyMessage(messageId, appliedAction.labelsAdded, appliedAction.labelsRemoved);
        }
      }

      yield* accountDb.updateAiThread(threadId, {
        labels: labelsAfter,
        ghostLabels: rule.dryRun ? ghostLabelsAfter : context.ghostLabels,
        isArchived: archivedAfter,
        aiStatus: "processed",
      });
      const audit: AiAuditRecord = {
        id: randomUUID(),
        threadId,
        ruleId: rule.id,
        endpointId: encryptedEndpoint.id,
        apiModeUsed: apiMode,
        modelUsed: encryptedEndpoint.modelId,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        actionsApplied: appliedAction,
        latencyMs: Math.max(0, Math.round(performance.now() - llmStartedAt)),
        createdAt: Date.now(),
      };
      yield* accountDb.insertAiAudit(audit);
      appliedRules.push(rule.id);
    }

    if (evaluatedRules === 0 || appliedRules.length === 0) {
      yield* accountDb.updateAiThread(threadId, {
        labels: initialContext.thread.labels,
        ghostLabels: initialContext.ghostLabels,
        isArchived: initialContext.thread.isArchived,
        aiStatus: "skipped",
      });
    }
    return { evaluatedRules, appliedRules };
  }),
  undoAiAction: () => Effect.gen(function* () {
    const audit = yield* accountDb.getLatestUndoableAiAudit();
    if (!audit) return { reverted: false };
    const context = yield* accountDb.getAiThreadContext(audit.threadId);
    if (!context) return { reverted: false };
    const action = audit.actionsApplied;

    if (!action.dryRun) {
      const addLabelIds = action.labelsRemoved;
      const removeLabelIds = action.labelsAdded;
      for (const messageId of action.gmailMessageIds) {
        yield* gmail.modifyMessage(messageId, addLabelIds, removeLabelIds);
      }
    }

    const labels = action.dryRun ? context.thread.labels : [...action.labelsBefore];
    yield* accountDb.updateAiThread(audit.threadId, {
      labels,
      ghostLabels: action.ghostLabelsBefore,
      isArchived: action.archivedBefore,
      aiStatus: "processed",
    });
    yield* accountDb.markAiAuditReverted(audit.id);
    return { reverted: true, auditId: audit.id };
  }),
});

export const AiRuleWorkerLive = (
  vault: OAuthTokenVault,
): Layer.Layer<AiRuleWorker, never, AccountDb | BooleanFilter | GmailClient | LlmProvider | RegistryDb> =>
  Layer.effect(
    AiRuleWorker,
    Effect.gen(function* () {
      const accountDb = yield* AccountDb;
      const booleanFilter = yield* BooleanFilter;
      const gmail = yield* GmailClient;
      const llm = yield* LlmProvider;
      const registry = yield* RegistryDb;
      return makeService(accountDb, booleanFilter, gmail, llm, registry, vault);
    }),
  );

/** Tests provide in-memory AccountDb/RegistryDb and local mock HTTP-backed service layers. */
export const AiRuleWorkerTest = AiRuleWorkerLive;
