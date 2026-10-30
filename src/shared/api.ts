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
  | { readonly type: "sync"; readonly status: SyncJobStatus; readonly error?: string };
