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

export interface GmailSyncServiceApi {
  readonly sync: () => Effect.Effect<GmailSyncResult, import("../../shared/errors").GmailApiError | import("../../shared/errors").DatabaseError>;
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

      const hydrateAll = () => Effect.gen(function* () {
        let pageToken: string | undefined;
        let upserted = 0;
        do {
          const page = yield* gmail.listMessages(pageToken);
          for (const item of page.messages) {
            const message = yield* gmail.getMessage(item.id);
            if (yield* upsert(message)) upserted++;
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
        return upserted;
      });

      const sync = () => Effect.gen(function* () {
        yield* syncAliases;
        const profile = yield* gmail.getProfile();
        const historyId = yield* accountDb.getHistoryId();
        if (!historyId) {
          const messagesUpserted = yield* hydrateAll();
          yield* accountDb.setHistoryId(profile.historyId);
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
          const messagesUpserted = yield* hydrateAll();
          yield* accountDb.setHistoryId(profile.historyId);
          return { mode: "initial" as const, messagesUpserted, messagesDeleted: 0 };
        }

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
        return { mode: "incremental" as const, messagesUpserted, messagesDeleted };
      });

      return { sync, syncAliases: () => syncAliases, watch: (topicName) => gmail.watch(topicName) };
    }),
  );

const splitAddresses = (value?: string): ReadonlyArray<string> => value
  ? value.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map((address) => address.trim()).filter(Boolean)
  : [];

const extractAddress = (value: string): string => /<([^<>]+)>/.exec(value)?.[1]?.trim() ?? value.trim();
