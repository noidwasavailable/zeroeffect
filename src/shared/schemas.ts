import * as Schema from "effect/Schema";

export type FilterExpr =
  | { readonly _tag: "And"; readonly expressions: ReadonlyArray<FilterExpr> }
  | { readonly _tag: "Or"; readonly expressions: ReadonlyArray<FilterExpr> }
  | { readonly _tag: "Not"; readonly expression: FilterExpr }
  | {
      readonly _tag: "Is";
      readonly value: "unread" | "read" | "starred" | "archived";
    }
  | { readonly _tag: "Label"; readonly value: string }
  | { readonly _tag: "Contains"; readonly field: "from" | "subject"; readonly value: string };

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

export interface LabellingDecision {
  readonly matched: boolean;
  readonly labelsToAdd: ReadonlyArray<string>;
  readonly labelsToRemove: ReadonlyArray<string>;
  readonly archive: boolean;
  readonly confidence: number;
  readonly reasoning: string;
}

export const LabellingDecisionSchema: Schema.Codec<LabellingDecision> = Schema.Struct({
  matched: Schema.Boolean,
  labelsToAdd: Schema.Array(Schema.String),
  labelsToRemove: Schema.Array(Schema.String),
  archive: Schema.Boolean,
  confidence: Schema.Number,
  reasoning: Schema.String,
});
