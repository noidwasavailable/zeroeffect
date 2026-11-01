import { Effect, Layer, ManagedRuntime } from "effect";
import {
  isAccountId,
  MAX_VIEW_NAME_LENGTH,
  LOCAL_REQUEST_HEADER,
  type AccountId,
  type ApiErrorBody,
  type ReplyDraft,
  type ThreadAction,
  type NewMessageDraft,
  type ThreadDetail,
  type ThreadPage,
  type ViewSummary,
} from "../../shared/api";
import { DatabaseError, FilterParseError, GmailApiError, LlmEndpointError, SendAsComposeError } from "../../shared/errors";
import type { FilterExpr } from "../../shared/schemas";
import { threadActionLabels } from "../../shared/threadActions";
import { BUILT_IN_VIEWS } from "../../shared/views";
import { AccountDb, AccountDbLive, type AccountDbService, type SendAsAliasRecord } from "../services/AccountDb";
import { formatRulesFile, importInboxZeroRules, parseRulesFile } from "../services/AiRules";
import type { OAuthTokenVault } from "../services/OAuthTokenVault";
import type { AiRunner } from "../services/AiRunner";
import { BooleanFilter, BooleanFilterLive } from "../services/BooleanFilter";
import type { GmailAccessTokenProvider } from "../services/GmailAccessTokens";
import { GmailClient, GmailClientLive, type GmailClientService } from "../services/GmailClient";
import { resolveLabelIds } from "../services/GmailLabels";
import { parseMimeBody } from "../services/MimeParser";
import type { RegistryDbService } from "../services/RegistryDb";
import { chooseAlias, isSendableAlias, SendAsComposerService, SendAsComposerServiceLive } from "../services/SendAsComposerService";
import { accountEventStream, type AccountEventBus } from "./sse";

export interface ApiConfig {
  readonly registry: RegistryDbService;
  readonly tokens: GmailAccessTokenProvider;
  readonly events: AccountEventBus;
  readonly accountDataDirectory?: string;
  readonly gmailApiBaseUrl?: string;
  /** Opens an account's silo; defaults to its SQLite file under accountDataDirectory (tests pass in-memory silos). */
  readonly accountDbLayer?: (accountId: AccountId) => Layer.Layer<AccountDb, unknown>;
  /** Runs the AI labeller on demand; AI routes answer 503 without it. */
  readonly aiRunner?: AiRunner;
  /** Encrypts LLM API keys saved from the settings screen; endpoint creation answers 503 without it. */
  readonly vault?: OAuthTokenVault;
  /** Called after a reply is sent, e.g. to sync the sent message (and its conversation status) right away. */
  readonly onReplySent?: (accountId: AccountId) => void;
}

export interface ApiHandler {
  /** Handles `/api/a/:accountId/...`; returns null for paths it does not own. */
  readonly handle: (request: Request, url: URL) => Promise<Response | null>;
  readonly close: () => Promise<void>;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Upper bound on Gmail fetches when one opened conversation needs its original HTML backfilled. */
const MAX_HTML_BACKFILL = 25;

const json = (value: unknown, status = 200): Response => Response.json(value, {
  status,
  headers: { "Cache-Control": "no-store" },
});

const apiError = (status: number, body: ApiErrorBody): Response => json(body, status);

/**
 * Rejects mutations a foreign page could forge. Browsers only send the custom header from
 * same-origin scripts (cross-site use needs a CORS preflight this server never approves).
 * The Origin check compares hosts only: behind `tailscale serve` the browser sees https while
 * this server sees plain http.
 */
export const isTrustedMutation = (request: Request): boolean => {
  if (request.headers.get(LOCAL_REQUEST_HEADER) !== "1") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
};

const failureResponse = (error: unknown): Response => {
  if (error instanceof FilterParseError) return apiError(400, { error: error.message, offset: error.offset });
  if (error instanceof GmailApiError) {
    console.error(`Gmail request failed: ${error.message}`, error);
    return apiError(502, { error: `Gmail rejected the change: ${error.message}`, retryable: error.retryable });
  }
  if (error instanceof SendAsComposeError) return apiError(400, { error: error.message });
  if (error instanceof LlmEndpointError) {
    console.error(`LLM request failed (${error.apiMode}): ${error.message}`);
    return apiError(502, { error: `The AI labeller failed: ${error.message}` });
  }
  if (error instanceof DatabaseError) {
    console.error(`Account database error during ${error.operation}.`, error);
    return apiError(500, { error: "The local account database failed. Check the server log." });
  }
  console.error("API request failed.", error);
  return apiError(500, { error: error instanceof Error ? error.message : "Request failed." });
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);

/** Trimmed, non-empty strings from a JSON array of addresses, or null if it is not one. */
const addressList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]).map((item) => item.trim()).filter(Boolean) : null;

const parseThreadAction = (body: unknown): ThreadAction | null => {
  if (typeof body !== "object" || body === null) return null;
  const { type, add, remove } = body as { type?: unknown; add?: unknown; remove?: unknown };
  if (type === "setLabels") {
    return isStringArray(add) && isStringArray(remove) && add.length + remove.length > 0
      ? { type, add: add.map((label) => label.trim()), remove: remove.map((label) => label.trim()) }
      : null;
  }
  return type === "archive" || type === "moveToInbox" || type === "markRead" || type === "markUnread" || type === "star" || type === "unstar"
    ? { type }
    : null;
};

export const createApiHandler = (config: ApiConfig): ApiHandler => {
  // One long-lived connection per account silo, opened on first use.
  const silos = new Map<AccountId, Promise<{ readonly runtime: ManagedRuntime.ManagedRuntime<AccountDb, unknown>; readonly db: AccountDbService }>>();
  const booleanFilter = Effect.runSync(Effect.gen(function* () { return yield* BooleanFilter; }).pipe(Effect.provide(BooleanFilterLive)));

  const accountDb = (accountId: AccountId): Promise<AccountDbService> => {
    let silo = silos.get(accountId);
    if (!silo) {
      silo = (async () => {
        const runtime = ManagedRuntime.make(config.accountDbLayer?.(accountId) ?? AccountDbLive(accountId, config.accountDataDirectory));
        return { runtime, db: await runtime.runPromise(Effect.gen(function* () { return yield* AccountDb; })) };
      })();
      silos.set(accountId, silo);
      silo.catch(() => silos.delete(accountId));
    }
    return silo.then((value) => value.db);
  };

  const gmailClient = async (accountId: AccountId): Promise<GmailClientService> => {
    const { accessToken } = await config.tokens.get(accountId);
    return Effect.runSync(Effect.gen(function* () { return yield* GmailClient; }).pipe(
      Effect.provide(GmailClientLive({ accessToken, apiBaseUrl: config.gmailApiBaseUrl })),
    ));
  };

  /**
   * Messages synced before original HTML was kept only have the reduced copy. Fetch their HTML from
   * Gmail once, when the conversation is opened; on failure the reduced copy is shown as before.
   */
  const withOriginalHtml = async (accountId: AccountId, thread: ThreadDetail): Promise<ThreadDetail> => {
    const missing = thread.messages.filter((message) => message.bodyHtml === null && message.bodyHtmlSanitized !== "");
    if (missing.length === 0) return thread;
    try {
      const db = await accountDb(accountId);
      const gmail = await gmailClient(accountId);
      const fetched = new Map<string, string>();
      await Promise.all(missing.slice(0, MAX_HTML_BACKFILL).map(async (message) => {
        const bodyHtml = parseMimeBody((await Effect.runPromise(gmail.getMessage(message.id))).payload).bodyHtml;
        if (bodyHtml === null) return;
        await Effect.runPromise(db.setMessageBodyHtml(message.id, bodyHtml));
        fetched.set(message.id, bodyHtml);
      }));
      return { ...thread, messages: thread.messages.map((message) => ({ ...message, bodyHtml: fetched.get(message.id) ?? message.bodyHtml })) };
    } catch (error) {
      console.warn(`Could not fetch original HTML for ${accountId} thread ${thread.id}; showing the stored copy.`, error);
      return thread;
    }
  };

  const listViews = async (db: AccountDbService): Promise<ReadonlyArray<ViewSummary>> =>
    [...BUILT_IN_VIEWS, ...await Effect.runPromise(db.listSavedViews())];

  const listThreads = async (accountId: AccountId, url: URL): Promise<Response> => {
    const db = await accountDb(accountId);
    const viewId = url.searchParams.get("view") ?? "inbox";
    const view = (await listViews(db)).find((candidate) => candidate.id === viewId);
    if (!view) return apiError(404, { error: `View '${viewId}' does not exist.` });
    const limit = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE || !Number.isSafeInteger(offset) || offset < 0) {
      return apiError(400, { error: `limit must be 1-${MAX_PAGE_SIZE} and offset must be a non-negative integer.` });
    }
    const expressions: FilterExpr[] = [await Effect.runPromise(booleanFilter.parse(view.dsl))];
    const query = url.searchParams.get("q")?.trim();
    if (query) expressions.push(await Effect.runPromise(booleanFilter.parse(query)));
    const filter = booleanFilter.compile(expressions.length === 1 ? expressions[0]! : { _tag: "And", expressions });
    // Fetch one extra row to learn whether another page exists.
    const threads = await Effect.runPromise(db.listThreadSummaries(filter, { limit: limit + 1, offset }));
    return json({ threads: threads.slice(0, limit), hasMore: threads.length > limit } satisfies ThreadPage);
  };

  const applyThreadAction = async (accountId: AccountId, threadId: string, request: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, { error: "Request body must be JSON." });
    }
    const action = parseThreadAction(body);
    if (!action) return apiError(400, { error: "Unsupported thread action." });
    const db = await accountDb(accountId);
    const thread = await Effect.runPromise(db.getThreadDetail(threadId));
    if (!thread) return apiError(404, { error: "Thread not found." });
    const { add, remove } = threadActionLabels(action);
    const gmail = await gmailClient(accountId);
    // Gmail first: the local copy only changes once Gmail has accepted the change.
    await Effect.runPromise(Effect.gen(function* () {
      const addIds = yield* resolveLabelIds(db, gmail, add, { create: true });
      const removeIds = yield* resolveLabelIds(db, gmail, remove, { create: false });
      yield* gmail.modifyThread(threadId, addIds, removeIds);
    }));
    const updated = await Effect.runPromise(db.applyThreadLabelChange(threadId, add, remove));
    config.events.publish(accountId, { type: "threads-changed", threadIds: [threadId] });
    return json({ thread: updated });
  };

  const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
    try {
      const body: unknown = await request.json();
      return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };

  /** Validates a view name, rejecting names that another view (built-in or saved) already uses. */
  const viewNameError = (name: unknown, views: ReadonlyArray<ViewSummary>, ownId?: string): Response | null => {
    if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > MAX_VIEW_NAME_LENGTH) {
      return apiError(400, { error: `View name must be 1-${MAX_VIEW_NAME_LENGTH} characters.` });
    }
    const normalized = name.trim().toLowerCase();
    return views.some((view) => view.id !== ownId && view.name.toLowerCase() === normalized)
      ? apiError(409, { error: `A view named "${name.trim()}" already exists.` })
      : null;
  };

  const createView = async (accountId: AccountId, request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body || typeof body.dsl !== "string") return apiError(400, { error: "A view needs a name and a filter (dsl)." });
    const db = await accountDb(accountId);
    const nameError = viewNameError(body.name, await listViews(db));
    if (nameError) return nameError;
    const filter = await Effect.runPromise(booleanFilter.parse(body.dsl));
    const view = await Effect.runPromise(db.createSavedView({ id: `v-${crypto.randomUUID().slice(0, 8)}`, name: (body.name as string).trim(), filter }));
    config.events.publish(accountId, { type: "views-changed" });
    return json({ view }, 201);
  };

  const updateView = async (accountId: AccountId, viewId: string, request: Request): Promise<Response> => {
    if (BUILT_IN_VIEWS.some((view) => view.id === viewId)) return apiError(400, { error: "Built-in views cannot be changed." });
    const body = await readJson(request);
    if (!body || (body.name === undefined && body.dsl === undefined)) return apiError(400, { error: "Provide a new name and/or filter (dsl)." });
    const db = await accountDb(accountId);
    if (body.name !== undefined) {
      const nameError = viewNameError(body.name, await listViews(db), viewId);
      if (nameError) return nameError;
    }
    if (body.dsl !== undefined && typeof body.dsl !== "string") return apiError(400, { error: "dsl must be a string." });
    const filter = typeof body.dsl === "string" ? await Effect.runPromise(booleanFilter.parse(body.dsl)) : undefined;
    const view = await Effect.runPromise(db.updateSavedView(viewId, {
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(filter ? { filter } : {}),
    }));
    if (!view) return apiError(404, { error: "View not found." });
    config.events.publish(accountId, { type: "views-changed" });
    return json({ view });
  };

  const reorderViews = async (accountId: AccountId, request: Request): Promise<Response> => {
    const body = await readJson(request);
    const ids = body?.ids;
    const db = await accountDb(accountId);
    const saved = (await Effect.runPromise(db.listSavedViews())).map((view) => view.id);
    if (!Array.isArray(ids) || ids.length !== saved.length || new Set(ids).size !== ids.length || !ids.every((id) => saved.includes(id))) {
      return apiError(400, { error: "ids must list every saved view exactly once." });
    }
    await Effect.runPromise(db.reorderSavedViews(ids as string[]));
    config.events.publish(accountId, { type: "views-changed" });
    return json({ views: await listViews(db) });
  };

  const saveRules = async (accountId: AccountId, request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body || typeof body.rules !== "object" || body.rules === null) return apiError(400, { error: "Send the rules file as { rules }." });
    // Validate exactly what will be written; nothing is saved unless every rule is valid.
    const loaded = parseRulesFile(JSON.stringify(body.rules));
    if (loaded.problems.length > 0) {
      return json({ error: "Some rules are invalid; nothing was saved.", problems: loaded.problems }, 400);
    }
    await Effect.runPromise((await accountDb(accountId)).writeRulesFile(formatRulesFile(loaded.file)));
    config.events.publish(accountId, { type: "rules-changed" });
    return json({ rules: loaded.file, problems: [] });
  };

  const importRules = async (accountId: AccountId, request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.export)) return apiError(400, { error: "Send an Inbox Zero export as { export: [...] }." });
    const db = await accountDb(accountId);
    const current = parseRulesFile(await Effect.runPromise(db.readRulesFile()));
    if (body.mode === "append" && current.problems.length > 0) {
      return json({ error: "The current rules file has invalid rules; fix them or import with replace.", problems: current.problems }, 409);
    }
    let result: ReturnType<typeof importInboxZeroRules>;
    try {
      result = importInboxZeroRules(body.export, current.file.llmEndpointId);
    } catch (error) {
      return apiError(400, { error: error instanceof Error ? error.message : "Invalid export." });
    }
    // "append" keeps existing rules and adds imported ones whose names are new.
    const existingNames = new Set(current.rules.map((rule) => rule.name.toLowerCase()));
    const rules = body.mode === "append"
      ? [...current.rules, ...result.file.rules.filter((rule) => !existingNames.has(rule.name.toLowerCase()))]
      : result.file.rules;
    const file = { ...current.file, rules };
    await Effect.runPromise(db.writeRulesFile(formatRulesFile(file)));
    config.events.publish(accountId, { type: "rules-changed" });
    return json({ rules: file, problems: [], imported: result.imported, skipped: result.skipped });
  };

  /** Accepting applies the AI's suggested labels (Gmail first); rejecting just clears them. */
  const decideGhostLabels = async (accountId: AccountId, threadId: string, request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (body?.decision !== "accept" && body?.decision !== "reject") return apiError(400, { error: "decision must be accept or reject." });
    const db = await accountDb(accountId);
    const thread = await Effect.runPromise(db.getThreadDetail(threadId));
    if (!thread) return apiError(404, { error: "Thread not found." });
    if (body.decision === "accept" && thread.ghostLabels.length > 0) {
      const gmail = await gmailClient(accountId);
      const labels = thread.ghostLabels;
      await Effect.runPromise(Effect.gen(function* () {
        yield* gmail.modifyThread(threadId, yield* resolveLabelIds(db, gmail, labels, { create: true }), []);
      }));
      await Effect.runPromise(db.applyThreadLabelChange(threadId, labels, []));
    }
    await Effect.runPromise(db.setGhostLabels(threadId, []));
    config.events.publish(accountId, { type: "threads-changed", threadIds: [threadId] });
    return json({ thread: await Effect.runPromise(db.getThreadDetail(threadId)) });
  };

  const saveLlmEndpoint = async (request: Request): Promise<Response> => {
    if (!config.vault) return apiError(503, { error: "LLM endpoints cannot be saved from this server." });
    const body = await readJson(request);
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const id = text(body?.id);
    const baseUrl = text(body?.baseUrl);
    const modelId = text(body?.modelId);
    const apiMode = body?.apiMode;
    if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || !baseUrl || !modelId || (apiMode !== "responses" && apiMode !== "chat_completions")) {
      return apiError(400, { error: "An endpoint needs an id (letters, digits, - or _), a base URL, a model and an API mode." });
    }
    try {
      if (!/^https?:$/.test(new URL(baseUrl).protocol)) throw new Error();
    } catch {
      return apiError(400, { error: "The base URL must be an http(s) URL." });
    }
    const existing = await Effect.runPromise(config.registry.getLlmEndpoint(id));
    const apiKey = text(body?.apiKey);
    // Keys are write-only: an update without a new key keeps the stored one.
    if (!apiKey && !existing) return apiError(400, { error: "A new endpoint needs an API key." });
    await Effect.runPromise(config.registry.upsertLlmEndpoint({
      id,
      name: text(body?.name) ?? id,
      baseUrl,
      modelId,
      apiMode,
      apiKeyEnc: apiKey ? config.vault.encrypt(apiKey) : existing!.apiKeyEnc,
      timeoutMs: typeof body?.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : existing?.timeoutMs ?? 30_000,
    }));
    return json({ endpoints: await Effect.runPromise(config.registry.listLlmEndpoints()) });
  };

  const extractAddress = (value: string): string => (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();

  /** Works out who a reply goes to, its subject and alias, following Gmail's reply / reply-all rules. */
  const replyTarget = async (accountId: AccountId, threadId: string) => {
    const db = await accountDb(accountId);
    const context = await Effect.runPromise(db.getAiThreadContext(threadId));
    if (!context) return null;
    const account = await Effect.runPromise(config.registry.getAccount(accountId));
    const aliases = await Effect.runPromise(db.listSendAsAliases());
    const own = new Set([account?.email, ...aliases.map((alias) => alias.sendAsEmail)].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
    const messages = context.messages.filter((message) => !message.labels.includes("DRAFT"));
    const sentByUser = (message: (typeof messages)[number]) => message.labels.includes("SENT") || own.has(extractAddress(message.fromAddress));
    const target = [...messages].reverse().find((message) => !sentByUser(message)) ?? messages.at(-1);
    if (!target) return null;
    const headers = await Effect.runPromise(db.getMessageHeaders(target.id)) ?? {};
    // Replying to your own message (a follow-up) goes to its original recipients.
    const to = sentByUser(target) ? [...target.toAddresses] : [headers["reply-to"] ?? target.fromAddress];
    const toAddresses = new Set(to.map(extractAddress));
    const replyAllCc = [...new Map([...target.toAddresses, ...target.ccAddresses]
      .filter((address) => !own.has(extractAddress(address)) && !toAddresses.has(extractAddress(address)))
      .map((address) => [extractAddress(address), address])).values()];
    const choice = chooseAlias(aliases, { deliveredTo: target.deliveredTo, matchAddresses: [...target.toAddresses, ...target.ccAddresses], to: [], cc: [] });
    return { db, context, target, headers, to, replyAllCc, aliases, choice };
  };

  const replyDraft = async (accountId: AccountId, threadId: string): Promise<Response> => {
    const target = await replyTarget(accountId, threadId);
    if (!target) return apiError(404, { error: "Thread not found." });
    const subject = target.target.subject.trim() || target.context.thread.subject;
    return json({
      draft: {
        messageId: target.target.id,
        to: target.to,
        cc: [],
        replyAllCc: target.replyAllCc,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        fromAlias: target.choice?.alias.sendAsEmail ?? null,
        aliasMatch: target.choice && target.choice.match !== "requested" ? target.choice.match : null,
        aliases: sendableAliases(target.aliases),
      } satisfies ReplyDraft,
    });
  };

  const composerFor = (db: AccountDbService, gmail: GmailClientService) =>
    Effect.runSync(Effect.gen(function* () { return yield* SendAsComposerService; }).pipe(
      Effect.provide(Layer.provide(SendAsComposerServiceLive, Layer.merge(Layer.succeed(AccountDb, db), Layer.succeed(GmailClient, gmail)))),
    ));

  const sendableAliases = (aliases: ReadonlyArray<SendAsAliasRecord>) =>
    aliases.filter(isSendableAlias).map(({ sendAsEmail, displayName, isDefault, isPrimary }) => ({ sendAsEmail, displayName, isDefault, isPrimary }));

  const newMessageDraft = async (accountId: AccountId): Promise<Response> => {
    const aliases = await Effect.runPromise((await accountDb(accountId)).listSendAsAliases());
    const choice = chooseAlias(aliases, { to: [], cc: [] });
    return json({ draft: { fromAlias: choice?.alias.sendAsEmail ?? null, aliases: sendableAliases(aliases) } satisfies NewMessageDraft });
  };

  /** Sends a new message (not a reply): its own Gmail thread, no quote or threading headers. */
  const sendMessage = async (accountId: AccountId, request: Request): Promise<Response> => {
    const body = await readJson(request);
    const to = addressList(body?.to);
    const cc = addressList(body?.cc ?? []);
    const bcc = addressList(body?.bcc ?? []);
    if (!body || !to || !cc || !bcc || to.length + cc.length + bcc.length === 0 || typeof body.body !== "string" || !body.body.trim() || typeof body.subject !== "string" || typeof body.fromAlias !== "string") {
      return apiError(400, { error: "A message needs at least one recipient, a sender alias and a message." });
    }
    const db = await accountDb(accountId);
    const sent = await Effect.runPromise(composerFor(db, await gmailClient(accountId)).send({
      to, cc, bcc, subject: body.subject, text: body.body, fromAlias: body.fromAlias,
    }));
    config.onReplySent?.(accountId);
    return json({ sent });
  };

  const sendReply = async (accountId: AccountId, threadId: string, request: Request): Promise<Response> => {
    const body = await readJson(request);
    const to = addressList(body?.to);
    const cc = addressList(body?.cc ?? []);
    if (!body || !to || to.length === 0 || !cc || typeof body.body !== "string" || !body.body.trim() || typeof body.subject !== "string" || typeof body.fromAlias !== "string") {
      return apiError(400, { error: "A reply needs recipients, a subject, a sender alias and a message." });
    }
    const target = await replyTarget(accountId, threadId);
    if (!target) return apiError(404, { error: "Thread not found." });
    const original = target.context.messages.find((message) => message.id === body.messageId) ?? target.target;
    const headers = original.id === target.target.id ? target.headers : await Effect.runPromise(target.db.getMessageHeaders(original.id)) ?? {};
    const messageIdHeader = headers["message-id"] ?? null;
    const sent = await Effect.runPromise(composerFor(target.db, await gmailClient(accountId)).send({
      to,
      cc,
      subject: body.subject,
      text: body.body,
      fromAlias: body.fromAlias,
      threadId,
      inReplyTo: messageIdHeader,
      references: [headers.references, messageIdHeader].filter(Boolean).join(" ") || null,
      quote: { from: original.fromAddress, dateTs: original.dateTs, text: original.bodyMarkdown },
    }));
    config.onReplySent?.(accountId);
    return json({ sent });
  };

  const route = async (request: Request, url: URL, accountId: AccountId, rest: string): Promise<Response> => {
    const account = await Effect.runPromise(config.registry.getAccount(accountId));
    if (!account) return apiError(404, { error: `The ${accountId} account is not connected. Connect it from /setup.` });

    if (request.method !== "GET" && !isTrustedMutation(request)) {
      return apiError(403, { error: "This request must come from the ZeroEffect web client." });
    }

    if (request.method === "GET" && rest === "/events") return accountEventStream(config.events, accountId, request.signal);
    if (request.method === "GET" && rest === "/threads") return listThreads(accountId, url);
    if (request.method === "GET" && rest === "/labels") {
      return json({ labels: await Effect.runPromise((await accountDb(accountId)).listLabels()) });
    }
    if (request.method === "GET" && rest === "/views") return json({ views: await listViews(await accountDb(accountId)) });
    if (request.method === "POST" && rest === "/views") return createView(accountId, request);
    if (request.method === "PUT" && rest === "/views/order") return reorderViews(accountId, request);
    const viewMatch = /^\/views\/([^/]+)$/.exec(rest);
    if (viewMatch) {
      const viewId = decodeURIComponent(viewMatch[1]!);
      if (request.method === "PATCH") return updateView(accountId, viewId, request);
      if (request.method === "DELETE") {
        if (BUILT_IN_VIEWS.some((view) => view.id === viewId)) return apiError(400, { error: "Built-in views cannot be deleted." });
        if (!await Effect.runPromise((await accountDb(accountId)).deleteSavedView(viewId))) return apiError(404, { error: "View not found." });
        config.events.publish(accountId, { type: "views-changed" });
        return json({ deleted: true });
      }
    }

    if (request.method === "GET" && rest === "/compose") return newMessageDraft(accountId);
    if (request.method === "POST" && rest === "/messages") return sendMessage(accountId, request);
    if (request.method === "GET" && rest === "/rules") {
      const loaded = parseRulesFile(await Effect.runPromise((await accountDb(accountId)).readRulesFile()));
      return json({ rules: loaded.file, problems: loaded.problems });
    }
    if (request.method === "PUT" && rest === "/rules") return saveRules(accountId, request);
    if (request.method === "POST" && rest === "/rules/import") return importRules(accountId, request);
    const replyMatch = /^\/threads\/([^/]+)\/reply$/.exec(rest);
    if (replyMatch) {
      const threadId = decodeURIComponent(replyMatch[1]!);
      if (request.method === "GET") return replyDraft(accountId, threadId);
      if (request.method === "POST") return sendReply(accountId, threadId, request);
    }
    const ghostMatch = /^\/threads\/([^/]+)\/ghost$/.exec(rest);
    if (ghostMatch && request.method === "POST") return decideGhostLabels(accountId, decodeURIComponent(ghostMatch[1]!), request);
    if (request.method === "POST" && rest === "/ai/undo") {
      if (!config.aiRunner) return apiError(503, { error: "The AI labeller is not available." });
      return json(await config.aiRunner.undo(accountId));
    }
    const aiMatch = /^\/threads\/([^/]+)\/ai$/.exec(rest);
    if (aiMatch) {
      const threadId = decodeURIComponent(aiMatch[1]!);
      if (request.method === "GET") return json({ audits: await Effect.runPromise((await accountDb(accountId)).listAiAudits(threadId)) });
      if (request.method === "POST") {
        if (!config.aiRunner) return apiError(503, { error: "The AI labeller is not available." });
        if (!await Effect.runPromise((await accountDb(accountId)).getThread(threadId))) return apiError(404, { error: "Thread not found." });
        return json({ result: await config.aiRunner.runThread(accountId, threadId, "manual") });
      }
    }

    const threadMatch = /^\/threads\/([^/]+)(\/actions)?$/.exec(rest);
    if (threadMatch) {
      const threadId = decodeURIComponent(threadMatch[1]!);
      if (request.method === "GET" && !threadMatch[2]) {
        const thread = await Effect.runPromise((await accountDb(accountId)).getThreadDetail(threadId));
        return thread ? json({ thread: await withOriginalHtml(accountId, thread) }) : apiError(404, { error: "Thread not found." });
      }
      if (request.method === "POST" && threadMatch[2]) return applyThreadAction(accountId, threadId, request);
    }
    return apiError(404, { error: "Not found." });
  };

  return {
    handle: async (request, url) => {
      // LLM endpoints are shared by both accounts (each account's rules file picks one).
      if (url.pathname === "/api/llm-endpoints") {
        try {
          if (request.method === "GET") return json({ endpoints: await Effect.runPromise(config.registry.listLlmEndpoints()) });
          if (request.method === "POST") {
            if (!isTrustedMutation(request)) return apiError(403, { error: "This request must come from the ZeroEffect web client." });
            return await saveLlmEndpoint(request);
          }
          return apiError(405, { error: "Use GET or POST." });
        } catch (error) {
          return failureResponse(error);
        }
      }
      const match = /^\/api\/a\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) return null;
      const accountId = match[1] ?? null;
      if (!isAccountId(accountId)) return apiError(400, { error: "Account id must be personal or work." });
      try {
        return await route(request, url, accountId, match[2] ?? "");
      } catch (error) {
        return failureResponse(error);
      }
    },
    close: async () => {
      const opened = await Promise.allSettled(silos.values());
      silos.clear();
      for (const silo of opened) if (silo.status === "fulfilled") await silo.value.runtime.dispose();
    },
  };
};
