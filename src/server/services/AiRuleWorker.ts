import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { CONVERSATION_STATUSES, isConversationStatus, type AiRule, type ConversationStatus } from "../../shared/aiRules";
import { DatabaseError, GmailApiError, LlmEndpointError } from "../../shared/errors";
import { parseFilterDsl } from "../../shared/filterParser";
import type { RuleSelection } from "../../shared/schemas";
import { AccountDb, type AccountDbService, type AiAuditRecord, type AiThreadMessage } from "./AccountDb";
import { parseRulesFile } from "./AiRules";
import { buildSystemPrompt, buildUserPrompt, conversationsOptionName, promptRule } from "./AiRulePrompt";
import { BooleanFilter, type BooleanFilterService } from "./BooleanFilter";
import { GmailClient, type GmailClientService } from "./GmailClient";
import { resolveLabelIds } from "./GmailLabels";
import { LlmProvider, type LlmProviderService } from "./LlmProvider";
import { OAuthTokenVault } from "./OAuthTokenVault";
import { RegistryDb, type RegistryDbService } from "./RegistryDb";

export interface AiRunResult {
  /** processed: rules matched; skipped: nothing to do (no rules, no new messages, no match). */
  readonly status: "processed" | "skipped";
  readonly llmCalled: boolean;
  readonly appliedRules: ReadonlyArray<string>;
  readonly conversationStatus: ConversationStatus | null;
  readonly auditId?: string;
  readonly reason: string;
}

export interface AiRuleWorkerService {
  /**
   * Classifies a thread with the account's rules using at most one LLM call.
   * `auto` runs (new mail) only consider messages newer than the last evaluation and honour
   * `runOnThreads`; `manual` runs re-evaluate the whole thread with every enabled rule.
   */
  readonly runForThread: (threadId: string, options?: { readonly trigger?: "auto" | "manual" }) => Effect.Effect<AiRunResult, DatabaseError | GmailApiError | LlmEndpointError>;
  /** Reverts the most recent AI run that changed something (labels or ghost labels). */
  readonly undoAiAction: () => Effect.Effect<{ readonly reverted: boolean; readonly auditId?: string; readonly threadId?: string }, DatabaseError | GmailApiError>;
}

export class AiRuleWorker extends Context.Service<AiRuleWorker, AiRuleWorkerService>()(
  "zeroeffect/AiRuleWorker",
) {}

// Senders that never expect a reply; conversation status rules are not offered for their mail (from Inbox Zero).
const NO_REPLY_PREFIXES = ["noreply@", "no-reply@", "notifications@", "notif@", "info@", "newsletter@", "updates@", "account@"];

const extractAddress = (value: string): string => (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();

/** Static condition: case-insensitive substring match against any `|`-separated alternative; null when unset. */
const matchesPattern = (value: string, pattern: string | null): boolean | null => {
  const alternatives = (pattern ?? "").split("|").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (alternatives.length === 0) return null;
  const haystack = value.toLowerCase();
  return alternatives.some((alternative) => haystack.includes(alternative));
};

/** All static conditions set on a rule must match (null: the rule has none). */
const staticConditionsMatch = (rule: AiRule, message: AiThreadMessage): boolean | null => {
  const results = [
    matchesPattern(message.fromAddress, rule.from),
    matchesPattern([...message.toAddresses, ...message.ccAddresses, message.deliveredTo ?? ""].join(" "), rule.to),
    matchesPattern(message.subject, rule.subject),
    matchesPattern(message.bodyMarkdown, rule.body),
  ].filter((result): result is boolean => result !== null);
  return results.length === 0 ? null : results.every(Boolean);
};

const unique = <A>(values: ReadonlyArray<A>): A[] => [...new Set(values)];

const ruleLabels = (rule: AiRule): string[] =>
  rule.actions.flatMap((action) => action.type === "LABEL" && action.label ? [action.label.trim()] : []);

const makeService = (
  accountDb: AccountDbService,
  booleanFilter: BooleanFilterService,
  gmail: GmailClientService,
  llm: LlmProviderService,
  registry: RegistryDbService,
  vault: OAuthTokenVault,
): AiRuleWorkerService => {
  const userAddresses = Effect.gen(function* () {
    const account = yield* registry.getAccount(accountDb.accountId);
    const aliases = yield* accountDb.listSendAsAliases();
    return unique([account?.email, ...aliases.map((alias) => alias.sendAsEmail)]
      .filter((address): address is string => Boolean(address))
      .map((address) => address.toLowerCase()));
  });

  const select = (
    rulesFile: { readonly llmEndpointId: string | null; readonly apiMode?: "responses" | "chat_completions" | null },
    request: Parameters<LlmProviderService["chooseRules"]>[3],
  ) => Effect.gen(function* () {
    const fallbackMode = rulesFile.apiMode ?? "responses";
    if (!rulesFile.llmEndpointId) {
      return yield* Effect.fail(new LlmEndpointError({
        apiMode: fallbackMode,
        message: `No LLM endpoint is configured: set "llmEndpointId" in data/accounts/${accountDb.accountId}.rules.json.`,
        rawBody: "",
      }));
    }
    const endpoint = yield* registry.getLlmEndpoint(rulesFile.llmEndpointId);
    if (!endpoint) {
      return yield* Effect.fail(new LlmEndpointError({ apiMode: fallbackMode, message: `LLM endpoint '${rulesFile.llmEndpointId}' was not found.`, rawBody: "" }));
    }
    const apiMode = rulesFile.apiMode ?? endpoint.apiMode;
    const apiKey = yield* Effect.try({
      try: () => vault.decrypt<string>(endpoint.apiKeyEnc),
      catch: () => new LlmEndpointError({ apiMode, message: "Could not decrypt the configured LLM API key.", rawBody: "" }),
    });
    const startedAt = performance.now();
    const selection = yield* llm.chooseRules(endpoint, apiKey, apiMode, request);
    return { selection, endpoint, apiMode, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  });

  const run = (threadId: string, trigger: "auto" | "manual") => Effect.gen(function* () {
    const skipped = (reason: string): AiRunResult => ({ status: "skipped", llmCalled: false, appliedRules: [], conversationStatus: null, reason });
    const context = yield* accountDb.getAiThreadContext(threadId);
    if (!context) return skipped("Thread not found.");
    const messages = context.messages.filter((message) => !message.labels.includes("DRAFT"));
    const latest = messages.at(-1);
    if (!latest) return skipped("The thread has no messages besides drafts.");

    const loaded = parseRulesFile(yield* accountDb.readRulesFile());
    for (const problem of loaded.problems) yield* Effect.logWarning(`AI rules for ${accountDb.accountId}: ${problem.rule ?? "file"}: ${problem.message}`);
    const rules = loaded.rules.filter((rule) => rule.enabled);
    if (rules.length === 0) return skipped("No enabled AI rules.");

    const isFollowUp = trigger === "auto" && context.aiEvaluatedThrough !== null;
    if (isFollowUp && latest.dateTs <= context.aiEvaluatedThrough!) return skipped("No new messages since the last evaluation.");

    const addresses = yield* userAddresses;
    const annotated = messages.map((message) => ({
      ...message,
      sentByUser: message.labels.includes("SENT") || addresses.includes(extractAddress(message.fromAddress)),
    }));
    const userSentLastMessage = annotated.at(-1)!.sentByUser;
    // Static conditions and the no-reply check look at the newest message someone else sent.
    const latestReceived = [...annotated].reverse().find((message) => !message.sentByUser) ?? annotated.at(-1)!;
    const previouslyApplied = isFollowUp ? yield* accountDb.appliedRuleNames(threadId) : new Set<string>();

    const staticMatches: AiRule[] = [];
    const inherited: AiRule[] = [];
    const aiCandidates: AiRule[] = [];
    let conversationRules: AiRule[] = [];
    for (const rule of rules) {
      if (rule.precondition?.trim()) {
        const precondition = parseFilterDsl(rule.precondition);
        if (!precondition.ok || !booleanFilter.evaluate(precondition.expression, context.thread)) continue;
      }
      if (isFollowUp && !rule.runOnThreads) {
        // First-message-only rules cost nothing on replies: inherit an earlier match, never ask again.
        if (previouslyApplied.has(rule.name)) inherited.push(rule);
        continue;
      }
      const staticResult = staticConditionsMatch(rule, latestReceived);
      const hasInstructions = rule.instructions.trim().length > 0;
      if (staticResult === false && rule.conditionalOperator === "AND") continue;
      if (staticResult === true && (rule.conditionalOperator === "OR" || !hasInstructions)) {
        staticMatches.push(rule);
        continue;
      }
      if (!hasInstructions) continue;
      if (isConversationStatus(rule.systemType)) conversationRules.push(rule);
      else aiCandidates.push(rule);
    }
    if (conversationRules.length > 0 && !latestReceived.sentByUser && NO_REPLY_PREFIXES.some((prefix) => extractAddress(latestReceived.fromAddress).startsWith(prefix))) {
      conversationRules = [];
    }
    const offeredStatuses = CONVERSATION_STATUSES.filter((status) =>
      conversationRules.some((rule) => rule.systemType === status) && !(status === "FYI" && userSentLastMessage));
    const optionName = conversationsOptionName(aiCandidates.map((rule) => rule.name));

    let llmResult: { readonly selection: RuleSelection; readonly endpoint: { readonly id: string; readonly modelId: string }; readonly apiMode: "responses" | "chat_completions"; readonly latencyMs: number } | null = null;
    if (aiCandidates.length > 0 || offeredStatuses.length > 0) {
      llmResult = yield* select(loaded.file, {
        instructions: buildSystemPrompt({
          rules: aiCandidates.map(promptRule),
          conversations: offeredStatuses.length > 0
            ? { optionName, statuses: offeredStatuses.map((status) => ({ status, instructions: conversationRules.find((rule) => rule.systemType === status)!.instructions })) }
            : null,
        }),
        input: buildUserPrompt({ userAddresses: addresses, messages: annotated, userSentLastMessage, conversationsOffered: offeredStatuses.length > 0 }),
        ruleNames: [...aiCandidates.map((rule) => rule.name), ...(offeredStatuses.length > 0 ? [optionName] : [])],
        conversationStatuses: offeredStatuses,
      });
    }

    const selected = llmResult?.selection.matchedRules.map((match) => match.ruleName) ?? [];
    const aiMatches = aiCandidates.filter((rule) => selected.includes(rule.name));
    const chosenStatus = selected.includes(optionName) ? llmResult?.selection.conversationStatus ?? null : null;
    const aiStatusRule = chosenStatus ? conversationRules.find((rule) => rule.systemType === chosenStatus) : undefined;
    // At most one conversation status per thread: the AI's answer, else a statically matched one.
    const staticStatusRule = staticMatches.find((rule) => isConversationStatus(rule.systemType));
    const statusRule = aiStatusRule ?? staticStatusRule;
    const finalRules = unique([
      ...staticMatches.filter((rule) => !isConversationStatus(rule.systemType)),
      ...inherited,
      ...aiMatches,
      ...(statusRule ? [statusRule] : []),
    ]);

    const add = new Set<string>();
    const remove = new Set<string>();
    const suggested = new Set<string>();
    for (const rule of finalRules) {
      if (!rule.automate) {
        // Suggestions carry labels only; archive / mark-read wait for an explicit decision.
        for (const label of ruleLabels(rule)) suggested.add(label);
        continue;
      }
      for (const label of ruleLabels(rule)) add.add(label);
      if (rule.actions.some((action) => action.type === "ARCHIVE")) remove.add("INBOX");
      if (rule.actions.some((action) => action.type === "MARK_READ")) remove.add("UNREAD");
    }
    // A new conversation status replaces the previous one (Inbox Zero's removeConflictingThreadStatusLabels).
    const supersededStatusLabels = new Set(statusRule
      ? loaded.rules.filter((rule) => isConversationStatus(rule.systemType) && rule.systemType !== statusRule.systemType).flatMap(ruleLabels)
      : []);
    for (const label of supersededStatusLabels) if (!add.has(label)) remove.add(label);
    for (const label of add) remove.delete(label);

    const current = context.thread.labels;
    const labelsAdded = [...add].filter((label) => !current.includes(label));
    const labelsRemoved = [...remove].filter((label) => current.includes(label));
    const ghostBefore = context.thread.ghostLabels;
    const ghostAfter = unique([...ghostBefore, ...suggested])
      .filter((label) => !supersededStatusLabels.has(label) && !current.includes(label) && !add.has(label));

    if (labelsAdded.length > 0 || labelsRemoved.length > 0) {
      const addIds = yield* resolveLabelIds(accountDb, gmail, labelsAdded, { create: true });
      const removeIds = yield* resolveLabelIds(accountDb, gmail, labelsRemoved, { create: false });
      // Gmail first: the local copy only changes once Gmail has accepted the change.
      yield* gmail.modifyThread(threadId, addIds, removeIds);
      yield* accountDb.applyThreadLabelChange(threadId, labelsAdded, labelsRemoved);
    }
    const ghostChanged = ghostAfter.length !== ghostBefore.length || ghostAfter.some((label, index) => label !== ghostBefore[index]);
    if (ghostChanged) yield* accountDb.setGhostLabels(threadId, ghostAfter);
    yield* accountDb.markAiEvaluated(threadId, { through: latest.dateTs, status: finalRules.length > 0 ? "processed" : "skipped" });

    if (!llmResult && finalRules.length === 0) return skipped("No rule applies to the new messages.");
    const reasoning = llmResult?.selection.reasoning
      ?? (inherited.length > 0 ? "Continued from earlier messages in this thread." : "Matched the rules' static conditions.");
    const audit: AiAuditRecord = {
      id: randomUUID(),
      threadId,
      trigger,
      ruleNames: finalRules.map((rule) => rule.name),
      conversationStatus: (statusRule?.systemType as ConversationStatus | undefined) ?? null,
      endpointId: llmResult?.endpoint.id ?? null,
      apiModeUsed: llmResult?.apiMode ?? null,
      modelUsed: llmResult?.endpoint.modelId ?? null,
      reasoning,
      changes: {
        labelsAdded,
        labelsRemoved,
        ghostLabelsAdded: ghostAfter.filter((label) => !ghostBefore.includes(label)),
        ghostLabelsBefore: ghostChanged ? ghostBefore : ghostAfter,
      },
      reverted: false,
      latencyMs: llmResult?.latencyMs ?? 0,
      createdAt: Date.now(),
    };
    yield* accountDb.insertAiAudit(audit);
    return {
      status: finalRules.length > 0 ? "processed" : "skipped",
      llmCalled: llmResult !== null,
      appliedRules: audit.ruleNames,
      conversationStatus: audit.conversationStatus,
      auditId: audit.id,
      reason: reasoning,
    } satisfies AiRunResult;
  }).pipe(
    // A failed run leaves the evaluation marker alone so the next new message retries it.
    Effect.tapError(() => accountDb.markAiEvaluated(threadId, { through: null, status: "error" }).pipe(Effect.ignore)),
  );

  return {
    runForThread: (threadId, options = {}) => run(threadId, options.trigger ?? "auto"),
    undoAiAction: () => Effect.gen(function* () {
      const audit = yield* accountDb.getLatestUndoableAiAudit();
      if (!audit) return { reverted: false };
      const { labelsAdded, labelsRemoved, ghostLabelsBefore } = audit.changes;
      if (labelsAdded.length > 0 || labelsRemoved.length > 0) {
        const addIds = yield* resolveLabelIds(accountDb, gmail, labelsRemoved, { create: true });
        const removeIds = yield* resolveLabelIds(accountDb, gmail, labelsAdded, { create: false });
        yield* gmail.modifyThread(audit.threadId, addIds, removeIds);
        yield* accountDb.applyThreadLabelChange(audit.threadId, labelsRemoved, labelsAdded);
      }
      yield* accountDb.setGhostLabels(audit.threadId, ghostLabelsBefore);
      yield* accountDb.markAiAuditReverted(audit.id);
      return { reverted: true, auditId: audit.id, threadId: audit.threadId };
    }),
  };
};

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
