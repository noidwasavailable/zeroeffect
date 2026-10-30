// Wire types shared by the HTTP API (src/server/routes/api.ts) and the web client.

export const ACCOUNT_IDS = ["personal", "work"] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];

export const isAccountId = (value: string | null | undefined): value is AccountId =>
  value !== null && value !== undefined && ACCOUNT_IDS.some((accountId) => accountId === value);

/** Mutating API requests must carry this header; cross-site pages cannot send it without a CORS preflight. */
export const LOCAL_REQUEST_HEADER = "x-zeroeffect-local";

export interface AccountSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly colorTheme: string;
}

export interface ThreadSummary {
  readonly id: string;
  readonly subject: string;
  readonly snippet: string;
  readonly senderSummary: string;
  readonly lastMessageAt: number;
  readonly labels: ReadonlyArray<string>;
  readonly ghostLabels: ReadonlyArray<string>;
  readonly isUnread: boolean;
  readonly isStarred: boolean;
  readonly isArchived: boolean;
  readonly aiStatus: "pending" | "processed" | "skipped" | "error";
}

export interface ThreadMessage {
  readonly id: string;
  readonly fromAddress: string;
  readonly toAddresses: ReadonlyArray<string>;
  readonly ccAddresses: ReadonlyArray<string>;
  readonly deliveredTo: string | null;
  readonly dateTs: number;
  readonly bodyMarkdown: string;
  readonly bodyHtmlSanitized: string;
}

export interface ThreadDetail extends ThreadSummary {
  readonly messages: ReadonlyArray<ThreadMessage>;
}

export interface LabelSummary {
  readonly id: string;
  readonly name: string;
  readonly type: "system" | "user";
  readonly colorBg: string | null;
  readonly colorText: string | null;
}

export interface ViewSummary {
  readonly id: string;
  readonly name: string;
  readonly dsl: string;
  readonly builtIn: boolean;
}

export interface ThreadPage {
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly hasMore: boolean;
}

export const MAX_VIEW_NAME_LENGTH = 60;

export type ThreadAction =
  | { readonly type: "archive" }
  | { readonly type: "moveToInbox" }
  | { readonly type: "markRead" }
  | { readonly type: "markUnread" }
  | { readonly type: "star" }
  | { readonly type: "unstar" }
  | { readonly type: "setLabels"; readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> };

export interface ApiErrorBody {
  readonly error: string;
  /** Set for DSL parse errors: the character offset the parser stopped at. */
  readonly offset?: number;
  /** Set for Gmail failures: whether retrying the same request may succeed. */
  readonly retryable?: boolean;
}

export type SyncJobStatus = "queued" | "running" | "completed" | "failed";

export type AccountEvent =
  | { readonly type: "threads-changed"; readonly threadIds?: ReadonlyArray<string> }
  | { readonly type: "views-changed" }
  | { readonly type: "rules-changed" }
  | { readonly type: "sync"; readonly status: SyncJobStatus; readonly error?: string };

export interface LlmEndpointSummary {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiMode: "responses" | "chat_completions";
  readonly timeoutMs?: number;
}

export interface RulesProblemSummary {
  readonly rule: string | null;
  readonly message: string;
}

export interface RulesResponse {
  /** Settings plus the valid rules; invalid rules on disk are listed in `problems` instead. */
  readonly rules: import("./aiRules").AiRulesFile;
  readonly problems: ReadonlyArray<RulesProblemSummary>;
}

export interface AiRunSummary {
  readonly status: "processed" | "skipped";
  readonly llmCalled: boolean;
  readonly appliedRules: ReadonlyArray<string>;
  readonly conversationStatus: string | null;
  readonly reason: string;
}

export interface AiAuditSummary {
  readonly id: string;
  readonly threadId: string;
  readonly trigger: "auto" | "manual";
  readonly ruleNames: ReadonlyArray<string>;
  readonly conversationStatus: string | null;
  readonly endpointId: string | null;
  readonly apiModeUsed: "responses" | "chat_completions" | null;
  readonly modelUsed: string | null;
  readonly reasoning: string;
  readonly changes: {
    readonly labelsAdded: ReadonlyArray<string>;
    readonly labelsRemoved: ReadonlyArray<string>;
    readonly ghostLabelsAdded: ReadonlyArray<string>;
  };
  readonly reverted: boolean;
  readonly latencyMs: number;
  readonly createdAt: number;
}

export interface SendAsAliasSummary {
  readonly sendAsEmail: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly isPrimary: boolean;
}

/** A suggested reply to a thread's latest incoming message. */
export interface ReplyDraft {
  /** The Gmail message being answered. */
  readonly messageId: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  /** Everyone else on the original message, added to Cc when replying to all. */
  readonly replyAllCc: ReadonlyArray<string>;
  readonly subject: string;
  /** The alias matched from Delivered-To / To / Cc (or the default), or null when none can send. */
  readonly fromAlias: string | null;
  readonly aliasMatch: "recipient" | "default" | "primary" | "first" | null;
  readonly aliases: ReadonlyArray<SendAsAliasSummary>;
}

export interface SendReplyRequest {
  readonly messageId: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  readonly fromAlias: string;
}
