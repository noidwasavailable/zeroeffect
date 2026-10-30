import { Effect } from "effect";
import type { DatabaseError, GmailApiError } from "../../shared/errors";
import type { AccountDbService, LabelRecord } from "./AccountDb";
import type { GmailClientService, GmailLabel } from "./GmailClient";

// Gmail's system label IDs double as their names, so they resolve without a catalog lookup.
const SYSTEM_LABEL_IDS = new Set([
  "INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "SPAM", "TRASH", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

export const toLabelRecord = (label: GmailLabel): LabelRecord => ({
  id: label.id,
  name: label.name,
  type: label.type === "system" ? "system" : "user",
  colorBg: label.color?.backgroundColor ?? null,
  colorText: label.color?.textColor ?? null,
});

/** Copies Gmail's label catalog into the account silo, returning the stored records. */
export const syncLabels = (
  accountDb: AccountDbService,
  gmail: GmailClientService,
): Effect.Effect<ReadonlyArray<LabelRecord>, GmailApiError | DatabaseError> =>
  gmail.listLabels().pipe(
    Effect.map((labels) => labels.map(toLabelRecord)),
    Effect.tap((labels) => accountDb.replaceLabels(labels)),
  );

/**
 * Translates stored label names into Gmail label IDs for `messages.modify`.
 * With `create`, user labels Gmail does not have yet (e.g. new AI labels) are created first.
 */
export const resolveLabelIds = (
  accountDb: AccountDbService,
  gmail: GmailClientService,
  names: ReadonlyArray<string>,
  options: { readonly create: boolean },
): Effect.Effect<ReadonlyArray<string>, GmailApiError | DatabaseError> => Effect.gen(function* () {
  if (names.length === 0) return [];
  const idsByName = new Map((yield* accountDb.listLabels()).map((label) => [label.name, label.id]));
  const ids: string[] = [];
  for (const name of names) {
    const known = idsByName.get(name) ?? (SYSTEM_LABEL_IDS.has(name) ? name : undefined);
    if (known !== undefined) {
      ids.push(known);
      continue;
    }
    if (!options.create) {
      yield* Effect.logWarning(`Gmail label "${name}" is not in the local catalog; skipping it.`);
      continue;
    }
    const created = yield* gmail.createLabel(name).pipe(
      Effect.map(toLabelRecord),
      Effect.tap((label) => accountDb.upsertLabel(label)),
      // 409: the label exists in Gmail but not locally yet; refresh the catalog and use it.
      Effect.catchIf(
        (error) => error._tag === "GmailApiError" && error.status === 409,
        (error) => syncLabels(accountDb, gmail).pipe(
          Effect.flatMap((labels) => {
            const existing = labels.find((label) => label.name === name);
            return existing ? Effect.succeed(existing) : Effect.fail(error);
          }),
        ),
      ),
    );
    idsByName.set(name, created.id);
    ids.push(created.id);
  }
  return ids;
});
