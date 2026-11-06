import type { AppSettings, ThreadAction, ThreadSummary } from "./api";

/** The Gmail label names a thread action adds and removes, given the settings that widen it. */
export const threadActionLabels = (
  action: ThreadAction,
  settings: Pick<AppSettings, "markReadOnArchive"> = { markReadOnArchive: false },
): { readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  const labels = baseActionLabels(action);
  if (settings.markReadOnArchive && (action.type === "archive" || action.type === "trash")) {
    return { add: labels.add, remove: [...labels.remove, "UNREAD"] };
  }
  return labels;
};

const baseActionLabels = (action: ThreadAction): { readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  switch (action.type) {
    case "archive": return { add: [], remove: ["INBOX"] };
    case "moveToInbox": return { add: ["INBOX"], remove: [] };
    case "markRead": return { add: [], remove: ["UNREAD"] };
    case "markUnread": return { add: ["UNREAD"], remove: [] };
    case "star": return { add: ["STARRED"], remove: [] };
    case "unstar": return { add: [], remove: ["STARRED"] };
    // As in Gmail: trash and spam leave the inbox; restoring brings the thread back to it.
    case "trash": return { add: ["TRASH"], remove: ["INBOX", "SPAM"] };
    case "untrash": return { add: ["INBOX"], remove: ["TRASH"] };
    case "spam": return { add: ["SPAM"], remove: ["INBOX", "TRASH"] };
    case "notSpam": return { add: ["INBOX"], remove: ["SPAM"] };
    case "setLabels": return { add: action.add, remove: action.remove };
  }
};

export const applyLabelChange = (
  labels: ReadonlyArray<string>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): string[] => {
  const removed = new Set(remove);
  return [...new Set([...labels.filter((label) => !removed.has(label)), ...add])];
};

/** The thread as it will look once the action succeeds (used for optimistic UI updates). */
export const applyThreadAction = <T extends ThreadSummary>(
  thread: T,
  action: ThreadAction,
  settings?: Pick<AppSettings, "markReadOnArchive">,
): T => {
  const { add, remove } = threadActionLabels(action, settings);
  const labels = applyLabelChange(thread.labels, add, remove);
  return {
    ...thread,
    labels,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    isArchived: !labels.includes("INBOX"),
  };
};
