import { Effect, ManagedRuntime, type Layer } from "effect";
import {
  isAccountId,
  LOCAL_REQUEST_HEADER,
  type AccountId,
  type ApiErrorBody,
  type ThreadAction,
  type ThreadPage,
  type ViewSummary,
} from "../../shared/api";
import { DatabaseError, FilterParseError, GmailApiError } from "../../shared/errors";
import type { FilterExpr } from "../../shared/schemas";
import { applyLabelChange, threadActionLabels } from "../../shared/threadActions";
import { BUILT_IN_VIEWS } from "../../shared/views";
import { AccountDb, AccountDbLive, type AccountDbService } from "../services/AccountDb";
import { BooleanFilter, BooleanFilterLive } from "../services/BooleanFilter";
import type { GmailAccessTokenProvider } from "../services/GmailAccessTokens";
import { GmailClient, GmailClientLive, type GmailClientService } from "../services/GmailClient";
import { resolveLabelIds } from "../services/GmailLabels";
import type { RegistryDbService } from "../services/RegistryDb";
import { accountEventStream, type AccountEventBus } from "./sse";

export interface ApiConfig {
  readonly registry: RegistryDbService;
  readonly tokens: GmailAccessTokenProvider;
  readonly events: AccountEventBus;
  readonly accountDataDirectory?: string;
  readonly gmailApiBaseUrl?: string;
  /** Opens an account's silo; defaults to its SQLite file under accountDataDirectory (tests pass in-memory silos). */
  readonly accountDbLayer?: (accountId: AccountId) => Layer.Layer<AccountDb, unknown>;
}

export interface ApiHandler {
  /** Handles `/api/a/:accountId/...`; returns null for paths it does not own. */
  readonly handle: (request: Request, url: URL) => Promise<Response | null>;
  readonly close: () => Promise<void>;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

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
  if (error instanceof DatabaseError) {
    console.error(`Account database error during ${error.operation}.`, error);
    return apiError(500, { error: "The local account database failed. Check the server log." });
  }
  console.error("API request failed.", error);
  return apiError(500, { error: error instanceof Error ? error.message : "Request failed." });
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);

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
      for (const message of thread.messages) yield* gmail.modifyMessage(message.id, addIds, removeIds);
    }));
    const updated = await Effect.runPromise(db.setThreadLabels(threadId, applyLabelChange(thread.labels, add, remove)));
    config.events.publish(accountId, { type: "threads-changed", threadIds: [threadId] });
    return json({ thread: updated });
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

    const threadMatch = /^\/threads\/([^/]+)(\/actions)?$/.exec(rest);
    if (threadMatch) {
      const threadId = decodeURIComponent(threadMatch[1]!);
      if (request.method === "GET" && !threadMatch[2]) {
        const thread = await Effect.runPromise((await accountDb(accountId)).getThreadDetail(threadId));
        return thread ? json({ thread }) : apiError(404, { error: "Thread not found." });
      }
      if (request.method === "POST" && threadMatch[2]) return applyThreadAction(accountId, threadId, request);
    }
    return apiError(404, { error: "Not found." });
  };

  return {
    handle: async (request, url) => {
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
