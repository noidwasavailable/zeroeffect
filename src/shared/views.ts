import type { ViewSummary } from "./api";

/** Views every account has; saved split views are stored per account in `saved_views`. */
export const BUILT_IN_VIEWS: ReadonlyArray<ViewSummary> = [
  { id: "inbox", name: "Inbox", dsl: "label:INBOX", builtIn: true },
  { id: "unread", name: "Unread", dsl: "label:INBOX AND is:unread", builtIn: true },
  { id: "starred", name: "Starred", dsl: "is:starred", builtIn: true },
  { id: "sent", name: "Sent", dsl: "label:SENT", builtIn: true },
  { id: "all", name: "All mail", dsl: "NOT label:TRASH AND NOT label:SPAM", builtIn: true },
];

/** Gmail system labels that are shown as thread state (unread, starred, ...) rather than as label chips. */
export const HIDDEN_SYSTEM_LABELS = new Set(["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"]);

export const isVisibleLabel = (label: string): boolean =>
  !HIDDEN_SYSTEM_LABELS.has(label) && !label.startsWith("CATEGORY_");
