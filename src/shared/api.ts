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
  /** One-time code found in the newest message; the client offers "copy" on OTP-labelled threads. */
  readonly otpCode: string | null;
}

export interface AttachmentSummary {
  /** Gmail's MIME part id; with the message id it addresses the download route. */
  readonly partId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  /** Content-ID for `cid:` references in the message HTML (inline images). */
  readonly contentId: string | null;
  readonly inline: boolean;
}

/** Gmail rejects messages over 25 MB; attachments sent through ZeroEffect must fit together. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A file attached to an outgoing message, base64-encoded by the client. */
export interface OutgoingAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly dataBase64: string;
}

export const attachmentPath = (accountId: string, messageId: string, partId: string, options: { readonly inline?: boolean } = {}): string =>
  `/api/a/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}${options.inline ? "?inline=1" : ""}`;

export interface ThreadMessage {
  readonly id: string;
  readonly fromAddress: string;
  readonly toAddresses: ReadonlyArray<string>;
  readonly ccAddresses: ReadonlyArray<string>;
  readonly deliveredTo: string | null;
  readonly dateTs: number;
  readonly bodyMarkdown: string;
  readonly bodyHtmlSanitized: string;
  /** Original HTML, sanitized by the client before rendering; null for plain-text mail. */
  readonly bodyHtml: string | null;
  /** Unread messages start expanded in the reader, like the newest one. */
  readonly isUnread: boolean;
  readonly attachments: ReadonlyArray<AttachmentSummary>;
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
  /** Listed after saved views and without a digit key (Trash, Spam). */
  readonly secondary?: boolean;
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
  | { readonly type: "trash" }
  | { readonly type: "untrash" }
  | { readonly type: "spam" }
  | { readonly type: "notSpam" }
  | { readonly type: "setLabels"; readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> };

export const SIMPLE_THREAD_ACTIONS = [
  "archive", "moveToInbox", "markRead", "markUnread", "star", "unstar", "trash", "untrash", "spam", "notSpam",
] as const;

/**
 * One action over many threads: the listed ones, or every thread in a view (optionally narrowed by a
 * DSL query), e.g. "mark all as read in this view".
 */
export type BulkThreadRequest =
  | { readonly action: ThreadAction; readonly threadIds: ReadonlyArray<string> }
  | { readonly action: ThreadAction; readonly view: string; readonly q?: string };

export interface BulkThreadResult {
  readonly threadsUpdated: number;
  readonly messagesUpdated: number;
}

export interface ApiErrorBody {
  readonly error: string;
  /** Set for DSL parse errors: the character offset the parser stopped at. */
  readonly offset?: number;
  /** Set for Gmail failures: whether retrying the same request may succeed. */
  readonly retryable?: boolean;
}

/** App-wide preferences (shared by both accounts), stored in the registry. */
export interface AppSettings {
  /** Archiving or trashing a conversation also marks it read, so its unread state does not linger elsewhere (e.g. GitHub). */
  readonly markReadOnArchive: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = { markReadOnArchive: true };

export type SyncJobStatus = "queued" | "running" | "completed" | "failed";

export type AccountEvent =
  | { readonly type: "threads-changed"; readonly threadIds?: ReadonlyArray<string> }
  | { readonly type: "views-changed" }
  | { readonly type: "rules-changed" }
  | { readonly type: "sync"; readonly status: SyncJobStatus; readonly error?: string }
  /** The server's background status changed (Pub/Sub state or a problem); refetch `/api/status`. */
  | { readonly type: "server-status" };

/** Background work whose failures only showed up in the server log before. */
export type ServerProblemSource = "pubsub" | "catch_up" | "watch" | "notifications" | "ai" | "sync";

/** One background problem, kept per source and account; repeats bump `count` and `lastAt`. */
export interface ServerProblem {
  readonly id: string;
  readonly source: ServerProblemSource;
  readonly accountId: string | null;
  readonly message: string;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly count: number;
  /** When the same work next succeeded; null while the problem is ongoing. */
  readonly resolvedAt: number | null;
}

export type PubSubState = "disabled" | "unauthorized" | "connecting" | "listening" | "retrying" | "needs_reauthorization";

export interface ServerStatus {
  readonly pubSub: { readonly state: PubSubState; readonly detail: string | null; readonly since: number };
  /** Ongoing problems first, then recently resolved ones; newest first within each. */
  readonly problems: ReadonlyArray<ServerProblem>;
}

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

/** Every Send As alias of an account, for the "Send As aliases" palette page. */
export interface SendAsAliasDetail extends SendAsAliasSummary {
  readonly replyToAddress: string | null;
  readonly verificationStatus: string;
  /** Verified (or primary): it can be chosen as the sender. */
  readonly sendable: boolean;
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

/** Defaults for a new (non-reply) message. */
export interface NewMessageDraft {
  /** The default (else primary, else first) alias that can send, or null when none can. */
  readonly fromAlias: string | null;
  readonly aliases: ReadonlyArray<SendAsAliasSummary>;
}

/** Defaults for forwarding a thread's newest message. */
export interface ForwardDraft {
  /** The Gmail message being forwarded. */
  readonly messageId: string;
  readonly subject: string;
  readonly fromAlias: string | null;
  readonly aliases: ReadonlyArray<SendAsAliasSummary>;
  /** The original's attachments; all are forwarded unless listed in `excludeAttachments`. */
  readonly attachments: ReadonlyArray<AttachmentSummary>;
}

export interface SendMessageRequest {
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly bcc: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  readonly fromAlias: string;
  readonly attachments?: ReadonlyArray<OutgoingAttachment>;
}

export interface SendReplyRequest {
  readonly messageId: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  readonly fromAlias: string;
  readonly attachments?: ReadonlyArray<OutgoingAttachment>;
}

export interface SendForwardRequest {
  readonly messageId: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly bcc: ReadonlyArray<string>;
  readonly subject: string;
  /** Optional note above the forwarded message. */
  readonly body: string;
  readonly fromAlias: string;
  /** Part ids of the original's attachments to leave out. */
  readonly excludeAttachments: ReadonlyArray<string>;
  readonly attachments?: ReadonlyArray<OutgoingAttachment>;
}
