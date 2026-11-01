import type { ThreadMessage } from "../shared/api";

// Gmail-style folding for the reader: the newest message (and any unread one) starts expanded,
// older ones collapse to a one-line summary, and long runs of collapsed messages hide behind an
// "N earlier messages" bar, so a conversation reads from its latest reply.

/** The user's changes for one open thread, kept relative to the defaults so new replies still start expanded. */
export interface MessageFold {
  readonly threadId: string;
  readonly expanded: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
  /** The hidden run of collapsed messages has been revealed. */
  readonly revealed: boolean;
}

export const initialFold = (threadId: string): MessageFold =>
  ({ threadId, expanded: new Set(), collapsed: new Set(), revealed: false });

const expandedByDefault = (message: ThreadMessage, index: number, messages: ReadonlyArray<ThreadMessage>): boolean =>
  index === messages.length - 1 || message.isUnread;

export const isMessageExpanded = (fold: MessageFold, messages: ReadonlyArray<ThreadMessage>, index: number): boolean => {
  const message = messages[index]!;
  return fold.expanded.has(message.id) || (expandedByDefault(message, index, messages) && !fold.collapsed.has(message.id));
};

export const toggleMessage = (fold: MessageFold, messages: ReadonlyArray<ThreadMessage>, index: number): MessageFold => {
  const id = messages[index]!.id;
  const expanded = new Set(fold.expanded);
  const collapsed = new Set(fold.collapsed);
  if (isMessageExpanded(fold, messages, index)) {
    expanded.delete(id);
    collapsed.add(id);
  } else {
    collapsed.delete(id);
    expanded.add(id);
  }
  return { ...fold, expanded, collapsed };
};

export const allMessagesExpanded = (fold: MessageFold, messages: ReadonlyArray<ThreadMessage>): boolean =>
  messages.every((_, index) => isMessageExpanded(fold, messages, index));

/** Expands every message, or (when all already are) returns to the default fold. */
export const toggleAllMessages = (fold: MessageFold, messages: ReadonlyArray<ThreadMessage>): MessageFold =>
  allMessagesExpanded(fold, messages)
    ? initialFold(fold.threadId)
    : { threadId: fold.threadId, expanded: new Set(messages.map((message) => message.id)), collapsed: new Set(), revealed: true };

/** Runs of at least this many collapsed messages show only their first and last, with a count between. */
const HIDE_RUN_FROM = 4;

export type FoldItem =
  | { readonly kind: "message"; readonly index: number; readonly expanded: boolean }
  | { readonly kind: "hidden"; readonly count: number };

export const foldLayout = (fold: MessageFold, messages: ReadonlyArray<ThreadMessage>): ReadonlyArray<FoldItem> => {
  const items: FoldItem[] = [];
  let index = 0;
  while (index < messages.length) {
    if (isMessageExpanded(fold, messages, index)) {
      items.push({ kind: "message", index, expanded: true });
      index++;
      continue;
    }
    let end = index;
    while (end < messages.length && !isMessageExpanded(fold, messages, end)) end++;
    const run = end - index;
    if (!fold.revealed && run >= HIDE_RUN_FROM) {
      items.push({ kind: "message", index, expanded: false });
      items.push({ kind: "hidden", count: run - 2 });
      items.push({ kind: "message", index: end - 1, expanded: false });
    } else {
      for (let position = index; position < end; position++) items.push({ kind: "message", index: position, expanded: false });
    }
    index = end;
  }
  return items;
};
