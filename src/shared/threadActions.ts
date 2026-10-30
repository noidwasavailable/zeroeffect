import type { ThreadAction, ThreadSummary } from "./api";

/** The Gmail label names a thread action adds and removes. */
export const threadActionLabels = (action: ThreadAction): { readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  switch (action.type) {
    case "archive": return { add: [], remove: ["INBOX"] };
    case "moveToInbox": return { add: ["INBOX"], remove: [] };
    case "markRead": return { add: [], remove: ["UNREAD"] };
    case "markUnread": return { add: ["UNREAD"], remove: [] };
    case "star": return { add: ["STARRED"], remove: [] };
    case "unstar": return { add: [], remove: ["STARRED"] };
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
export const applyThreadAction = <T extends ThreadSummary>(thread: T, action: ThreadAction): T => {
  const { add, remove } = threadActionLabels(action);
  const labels = applyLabelChange(thread.labels, add, remove);
  return {
    ...thread,
    labels,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    isArchived: !labels.includes("INBOX"),
  };
};
