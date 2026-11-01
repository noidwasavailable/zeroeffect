import { Effect } from "effect";
import type { DatabaseError, GmailApiError } from "../../shared/errors";
import type { AccountDbService, LabelRecord } from "./AccountDb";
import type { GmailClientService, GmailLabel } from "./GmailClient";

// Gmail's system label IDs double as their names, so they resolve without a catalog lookup.
const SYSTEM_LABEL_IDS = new Set([
  "INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "SPAM", "TRASH", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

// Inbox Zero's label colors (all from Gmail's fixed label palette), so labels created for AI rules
// look the same as when Inbox Zero creates them.
const blue = "#b6cff5";
const cyan = "#98d7e4";
const purple = "#e3d7ff";
const pink = "#fcdee8";
const red = "#f2b2a8";
const coral = "#ffc8af";
const orange = "#ffdeb5";
const yellow = "#fdedc1";
const green = "#b3efd3";
const rose = "#fbc8d9";
const LABEL_COLORS = [blue, cyan, purple, pink, red, coral, orange, yellow, green, rose] as const;
const RULE_LABEL_COLORS: Readonly<Record<string, string>> = {
  "Marketing": red,
  "Newsletter": coral,
  "Notification": orange,
  "Receipt": yellow,
  "To Reply": green,
  "Actioned": cyan,
  "Awaiting Reply": blue,
  "Calendar": purple,
  "OTP": cyan,
  "Cold Email": pink,
  "FYI": rose,
  "Follow-up": yellow,
};

/** The color for a label ZeroEffect creates: Inbox Zero's for its rule labels, otherwise stable per name. */
export const labelColorFor = (name: string): { readonly backgroundColor: string; readonly textColor: string } => {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return { backgroundColor: RULE_LABEL_COLORS[name] ?? LABEL_COLORS[hash % LABEL_COLORS.length]!, textColor: "#000000" };
};

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
    const created = yield* gmail.createLabel(name, labelColorFor(name)).pipe(
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
