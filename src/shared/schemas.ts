import * as Schema from "effect/Schema";
import { CONVERSATION_STATUSES, type ConversationStatus } from "./aiRules";
import type { SearchDocument } from "./searchText";

export type FilterExpr =
  | { readonly _tag: "And"; readonly expressions: ReadonlyArray<FilterExpr> }
  | { readonly _tag: "Or"; readonly expressions: ReadonlyArray<FilterExpr> }
  | { readonly _tag: "Not"; readonly expression: FilterExpr }
  | {
      readonly _tag: "Is";
      readonly value: "unread" | "read" | "starred" | "archived";
    }
  | { readonly _tag: "Label"; readonly value: string }
  | { readonly _tag: "Contains"; readonly field: "from" | "subject"; readonly value: string }
  /** Full-text search: the value's tokens, consecutively and as word prefixes, in any one message. */
  | { readonly _tag: "Text"; readonly value: string };

/** Recursive, serializable AST shared by the DSL, SQL compiler, and UI. */
export const FilterExprSchema: Schema.Codec<FilterExpr> = Schema.suspend(() =>
  Schema.Union([
    Schema.TaggedStruct("And", {
      expressions: Schema.Array(Schema.suspend((): Schema.Codec<FilterExpr> => FilterExprSchema)),
    }),
    Schema.TaggedStruct("Or", {
      expressions: Schema.Array(Schema.suspend((): Schema.Codec<FilterExpr> => FilterExprSchema)),
    }),
    Schema.TaggedStruct("Not", {
      expression: Schema.suspend((): Schema.Codec<FilterExpr> => FilterExprSchema),
    }),
    Schema.TaggedStruct("Is", {
      value: Schema.Literals(["unread", "read", "starred", "archived"]),
    }),
    Schema.TaggedStruct("Label", { value: Schema.String }),
    Schema.TaggedStruct("Contains", {
      field: Schema.Literals(["from", "subject"]),
      value: Schema.String,
    }),
    Schema.TaggedStruct("Text", { value: Schema.String }),
  ]),
);

export interface FilterThread {
  readonly id: string;
  readonly subject: string;
  readonly senderSummary: string;
  readonly labels: ReadonlyArray<string>;
  readonly isUnread: boolean;
  readonly isStarred: boolean;
  readonly isArchived: boolean;
  /**
   * The thread's indexed message text, one document per message, for `Text` conditions. Loaded
   * only when an expression contains one (see `containsTextSearch`); without it they match nothing.
   */
  readonly searchDocuments?: ReadonlyArray<SearchDocument>;
}

export interface AccountRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly colorTheme: string;
  readonly oauthTokensEnc: Uint8Array;
  readonly pubsubTopic?: string | null;
  readonly watchExpirationTs?: number | null;
  readonly lastHistoryId?: string | null;
  readonly createdAt: number;
}

export interface LlmEndpointRecord {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKeyEnc: Uint8Array;
  readonly modelId: string;
  readonly apiMode: "responses" | "chat_completions";
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
}

/**
 * The LLM's single answer for a thread: which of the offered rules apply and, when the
 * "Conversations" option is chosen, where the conversation stands. Rule names are constrained
 * to the offered names by the JSON schema sent with each request.
 */
export interface RuleSelection {
  readonly reasoning: string;
  readonly matchedRules: ReadonlyArray<{ readonly ruleName: string; readonly isPrimary: boolean }>;
  readonly noMatchFound: boolean;
  readonly conversationStatus: ConversationStatus | null;
}

export const RuleSelectionSchema: Schema.Codec<RuleSelection> = Schema.Struct({
  reasoning: Schema.String,
  matchedRules: Schema.Array(Schema.Struct({ ruleName: Schema.String, isPrimary: Schema.Boolean })),
  noMatchFound: Schema.Boolean,
  conversationStatus: Schema.NullOr(Schema.Literals(CONVERSATION_STATUSES)),
});
