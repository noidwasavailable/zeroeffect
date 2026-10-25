import { Context, Effect, Layer } from "effect";
import { GmailApiError } from "../../shared/errors";
import { AccountDb } from "./AccountDb";
import type { MessageRecord, ThreadRecord } from "./AccountDb";
import { GmailClient } from "./GmailClient";
import type { GmailMessage } from "./GmailClient";
import { parseMimeBody } from "./MimeParser";

export interface GmailSyncResult {
  readonly mode: "initial" | "incremental";
  readonly messagesUpserted: number;
  readonly messagesDeleted: number;
}

export interface GmailSyncProgress {
  readonly stage: "listing_conversations" | "importing_conversations";
  readonly conversationsCompleted: number;
  readonly conversationsTotal: number;
  readonly messagesUpserted: number;
}

export interface GmailSyncOptions {
  readonly initialConversationLimit?: number;
  readonly onProgress?: (progress: GmailSyncProgress) => void;
}

export interface GmailSyncServiceApi {
  readonly sync: (options?: GmailSyncOptions) => Effect.Effect<GmailSyncResult, import("../../shared/errors").GmailApiError | import("../../shared/errors").DatabaseError>;
  readonly syncAliases: () => Effect.Effect<number, import("../../shared/errors").GmailApiError | import("../../shared/errors").DatabaseError>;
  readonly watch: (topicName: string) => Effect.Effect<import("./GmailClient").GmailWatchResponse, import("../../shared/errors").GmailApiError>;
}

export class GmailSyncService extends Context.Service<GmailSyncService, GmailSyncServiceApi>()(
  "zeroeffect/GmailSyncService",
) {}

export const GmailSyncServiceLive: Layer.Layer<GmailSyncService, never, AccountDb | GmailClient> =
  Layer.effect(
    GmailSyncService,
    Effect.gen(function* () {
      const accountDb = yield* AccountDb;
      const gmail = yield* GmailClient;
      const syncAliases = Effect.gen(function* () {
        yield* Effect.logInfo(`Gmail Send As sync started for ${accountDb.accountId}`);
        const aliases = yield* gmail.listSendAs();
        yield* accountDb.replaceSendAsAliases(aliases.map((alias) => ({
          sendAsEmail: alias.sendAsEmail,
          displayName: alias.displayName ?? "",
          replyToAddress: alias.replyToAddress ?? null,
          signatureHtml: alias.signature ?? null,
          isPrimary: alias.isPrimary ?? false,
          isDefault: alias.isDefault ?? false,
          verificationStatus: alias.verificationStatus ?? "unknown",
        })));
        yield* Effect.logInfo(`Gmail Send As sync completed for ${accountDb.accountId}: ${aliases.length} aliases`);
        return aliases.length;
      });

      const upsert = (message: GmailMessage) => Effect.gen(function* () {
        if (!message.payload) return false;
        const headers = Object.fromEntries((message.payload.headers ?? [])
          .filter((header) => header.name && header.value !== undefined)
          .map((header) => [header.name!.toLowerCase(), header.value ?? ""]));
        const labels = message.labelIds ?? [];
        const parsedBody = parseMimeBody(message.payload);
        const aliasRecords = yield* accountDb.listSendAsAliases();
        const deliveredTo = headers["delivered-to"] ?? headers["x-original-to"] ?? null;
        const recipientHeaders = [deliveredTo, headers.to, headers.cc].filter((value): value is string => Boolean(value));
        const matchedAlias = recipientHeaders
          .flatMap((value) => splitAddresses(value))
          .map((address) => extractAddress(address).toLowerCase())
          .map((address) => aliasRecords.find((alias) =>
            alias.verificationStatus.toLowerCase() === "accepted" && alias.sendAsEmail.toLowerCase() === address,
          )?.sendAsEmail)
          .find((address): address is string => address !== undefined) ?? null;
        const dateTs = Number(message.internalDate ?? 0);
        const msgRecord: MessageRecord = {
          id: message.id,
          threadId: message.threadId,
          fromAddress: headers.from ?? "",
          toAddresses: splitAddresses(headers.to),
          ccAddresses: splitAddresses(headers.cc),
          deliveredTo,
          dateTs: Number.isFinite(dateTs) ? dateTs : 0,
          bodyMarkdown: parsedBody.bodyMarkdown,
          bodyHtmlSanitized: parsedBody.bodyHtmlSanitized,
          rawHeaders: headers,
        };
        const threadRecord: ThreadRecord = {
          id: message.threadId,
          subject: headers.subject ?? "(no subject)",
          senderSummary: headers.from ?? "",
          labels,
          isUnread: labels.includes("UNREAD"),
          isStarred: labels.includes("STARRED"),
          isArchived: !labels.includes("INBOX"),
          snippet: message.snippet ?? "",
          lastMessageAt: msgRecord.dateTs,
          deliveredToAlias: matchedAlias,
        };
        yield* accountDb.upsertThread(threadRecord);
        yield* accountDb.upsertMessage(msgRecord);
        return true;
      });

      const hydrateLatest = (limit: number, onProgress?: GmailSyncOptions["onProgress"]) => Effect.gen(function* () {
        let pageToken: string | undefined;
        let conversationsCompleted = 0;
        let messagesUpserted = 0;
        const persistedThreadIds = new Set(yield* accountDb.listPersistedThreadIds());
        const visitedThreadIds = new Set<string>();
        onProgress?.({ stage: "listing_conversations", conversationsCompleted, conversationsTotal: limit, messagesUpserted });
        // Gmail documents messages.list as reverse chronological. Deduplicating
        // its message results by threadId selects conversations by their latest
        // message; threads.list does not promise an ordering.
        while (conversationsCompleted < limit) {
          const page = yield* gmail.listMessages(pageToken);
          if (page.messages.length === 0) break;
          for (const messageReference of page.messages) {
            const threadId = messageReference.threadId;
            if (!threadId || visitedThreadIds.has(threadId)) continue;
            visitedThreadIds.add(threadId);

            if (persistedThreadIds.has(threadId)) {
              // Already-complete local conversations count toward the hydration
              // target, but don't incur a threads.get request or another write.
              conversationsCompleted++;
              onProgress?.({ stage: "importing_conversations", conversationsCompleted, conversationsTotal: limit, messagesUpserted });
            } else {
              const thread = yield* gmail.getThread(threadId);
              let threadMessagesUpserted = 0;
              for (const threadMessage of thread.messages ?? []) {
                const normalizedMessage = threadMessage.threadId ? threadMessage : { ...threadMessage, threadId: thread.id };
                if (yield* upsert(normalizedMessage)) {
                  messagesUpserted++;
                  threadMessagesUpserted++;
                }
              }
              if (threadMessagesUpserted > 0) {
                yield* accountDb.markThreadHydrated(threadId);
                persistedThreadIds.add(threadId);
              }
              conversationsCompleted++;
              onProgress?.({ stage: "importing_conversations", conversationsCompleted, conversationsTotal: limit, messagesUpserted });
            }
            if (conversationsCompleted >= limit) break;
          }
          pageToken = page.nextPageToken;
          if (!pageToken) break;
        }
        return { messagesUpserted, conversationsImported: conversationsCompleted };
      });

      const sync = (options: GmailSyncOptions = {}) => Effect.gen(function* () {
        const initialConversationLimit = options.initialConversationLimit ?? 100;
        if (!Number.isSafeInteger(initialConversationLimit) || initialConversationLimit < 1) {
          throw new Error("Initial conversation limit must be a positive safe integer.");
        }
        yield* Effect.logInfo(`Gmail sync started for ${accountDb.accountId}`);
        yield* syncAliases;
        const profile = yield* gmail.getProfile();
        const historyId = yield* accountDb.getHistoryId();
        if (!historyId) {
          yield* Effect.logInfo(`Gmail initial hydration started for ${accountDb.accountId}: up to ${initialConversationLimit} conversations`);
          const { messagesUpserted, conversationsImported } = yield* hydrateLatest(initialConversationLimit, options.onProgress);
          yield* accountDb.setHistoryId(profile.historyId);
          yield* Effect.logInfo(`Gmail initial sync completed for ${accountDb.accountId}: ${conversationsImported} conversations, ${messagesUpserted} messages upserted`);
          return { mode: "initial" as const, messagesUpserted, messagesDeleted: 0 };
        }

        const changed = new Map<string, "upsert" | "delete">();
        let pageToken: string | undefined;
        let latestHistoryId: string | undefined;
        let historyExpired = false;
        do {
          const result = yield* gmail.listHistory(historyId, pageToken).pipe(
            Effect.map((page) => ({ _tag: "page" as const, page })),
            Effect.catchIf(
              (error) => error instanceof GmailApiError && error.status === 404,
              () => Effect.succeed({ _tag: "expired" as const }),
            ),
          );
          if (result._tag === "expired") {
            historyExpired = true;
            break;
          }
          const page = result.page;
          latestHistoryId = page.historyId ?? latestHistoryId;
          for (const event of page.history ?? []) {
            for (const item of event.messagesAdded ?? []) if (item.message?.id) changed.set(item.message.id, "upsert");
            for (const item of event.labelsAdded ?? []) if (item.message?.id) changed.set(item.message.id, "upsert");
            for (const item of event.labelsRemoved ?? []) if (item.message?.id) changed.set(item.message.id, "upsert");
            for (const item of event.messagesDeleted ?? []) if (item.message?.id) changed.set(item.message.id, "delete");
          }
          pageToken = page.nextPageToken;
        } while (pageToken);

        if (historyExpired) {
          yield* Effect.logWarning(`Gmail history expired for ${accountDb.accountId}; re-importing up to ${initialConversationLimit} recent conversations`);
          const { messagesUpserted, conversationsImported } = yield* hydrateLatest(initialConversationLimit, options.onProgress);
          yield* accountDb.setHistoryId(profile.historyId);
          yield* Effect.logInfo(`Gmail re-import completed for ${accountDb.accountId}: ${conversationsImported} conversations, ${messagesUpserted} messages upserted`);
          return { mode: "initial" as const, messagesUpserted, messagesDeleted: 0 };
        }

        yield* Effect.logInfo(`Gmail history scan for ${accountDb.accountId}: ${changed.size} changed messages`);
        let messagesUpserted = 0;
        let messagesDeleted = 0;
        for (const [id, action] of changed) {
          if (action === "delete") {
            yield* accountDb.deleteMessage(id);
            messagesDeleted++;
          } else if (yield* upsert(yield* gmail.getMessage(id))) {
            messagesUpserted++;
          }
        }
        yield* accountDb.setHistoryId(latestHistoryId ?? profile.historyId);
        yield* Effect.logInfo(`Gmail incremental sync completed for ${accountDb.accountId}: ${messagesUpserted} upserted, ${messagesDeleted} deleted`);
        return { mode: "incremental" as const, messagesUpserted, messagesDeleted };
      }).pipe(Effect.tapError((error) => Effect.logError(
        error._tag === "GmailApiError"
          ? `Gmail sync failed for ${accountDb.accountId}: HTTP ${error.status}${error.reason ? `, reason=${error.reason}` : ""}${error.apiStatus ? `, status=${error.apiStatus}` : ""}${error.operation ? `, operation=${error.operation}` : ""}, retryable=${error.retryable}`
          : `Gmail sync failed for ${accountDb.accountId}: ${error._tag} (${error.operation})`,
      )));

      return { sync, syncAliases: () => syncAliases, watch: (topicName) => gmail.watch(topicName) };
    }),
  );

const splitAddresses = (value?: string): ReadonlyArray<string> => value
  ? value.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map((address) => address.trim()).filter(Boolean)
  : [];

const extractAddress = (value: string): string => /<([^<>]+)>/.exec(value)?.[1]?.trim() ?? value.trim();
