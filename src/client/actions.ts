import type { AccountSummary, ThreadAction, ThreadSummary, ViewSummary } from "../shared/api";

/**
 * Every user action is declared once here. The Cmd+K palette lists all of them, the action
 * toolbar and sidebars render buttons for them, and useVimShortcuts binds their keys, so the
 * three entry points cannot drift apart.
 */
export interface Shortcut {
  /** `KeyboardEvent.key` for plain keys (uppercase letters mean Shift); a digit or letter with `alt`. */
  readonly key: string;
  readonly alt?: boolean;
}

export type ActionGroup = "Navigation" | "Thread" | "Filter & Views" | "Account";

export interface AppAction {
  readonly id: string;
  readonly label: string;
  readonly group: ActionGroup;
  /** Omitted only for rare, destructive or positional actions (palette + button only). */
  readonly shortcut?: Shortcut;
  readonly enabled: boolean;
  readonly run: () => void;
  /** The action opens a palette page, so choosing it from the palette must not close the palette. */
  readonly opensPalettePage?: boolean;
}

export interface ActionContext {
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly accountId: string;
  readonly views: ReadonlyArray<ViewSummary>;
  readonly viewId: string;
  readonly selectedThread: ThreadSummary | null;
  readonly threadOpen: boolean;
  readonly canSelectNext: boolean;
  readonly canSelectPrevious: boolean;
  readonly syncing: boolean;
  readonly builderOpen: boolean;
  /** Position of the current view among saved views, or null for a built-in view. */
  readonly savedViewPosition: { readonly index: number; readonly count: number } | null;
  readonly moveSelection: (delta: 1 | -1) => void;
  readonly openSelectedThread: () => void;
  readonly closeThread: () => void;
  readonly focusSearch: () => void;
  readonly runThreadAction: (action: ThreadAction) => void;
  readonly openLabelPicker: () => void;
  readonly switchAccount: (accountId: string) => void;
  readonly goToView: (viewId: string) => void;
  readonly sync: () => void;
  readonly toggleBuilder: () => void;
  readonly saveView: () => void;
  readonly editView: () => void;
  readonly deleteView: () => void;
  readonly moveView: (delta: 1 | -1) => void;
}

/** Action ids shown as buttons in the persistent toolbar, in order. */
export const TOOLBAR_ACTION_IDS = [
  "navigation.previous",
  "navigation.next",
  "thread.archive",
  "thread.label",
  "thread.toggleRead",
  "thread.toggleStar",
  "filter.builder",
  "views.save",
  "account.sync",
] as const;

export const buildActions = (context: ActionContext): ReadonlyArray<AppAction> => {
  const thread = context.selectedThread;
  const actions: AppAction[] = [
    {
      id: "navigation.next", label: "Next thread", group: "Navigation", shortcut: { key: "j" },
      enabled: context.canSelectNext, run: () => context.moveSelection(1),
    },
    {
      id: "navigation.previous", label: "Previous thread", group: "Navigation", shortcut: { key: "k" },
      enabled: context.canSelectPrevious, run: () => context.moveSelection(-1),
    },
    {
      id: "navigation.open", label: "Open thread", group: "Navigation", shortcut: { key: "o" },
      enabled: thread !== null, run: context.openSelectedThread,
    },
    {
      id: "navigation.close", label: "Close thread", group: "Navigation", shortcut: { key: "Escape" },
      enabled: context.threadOpen, run: context.closeThread,
    },
    {
      id: "navigation.search", label: "Filter by Boolean DSL", group: "Filter & Views", shortcut: { key: "/" },
      enabled: true, run: context.focusSearch,
    },
    {
      id: "filter.builder", label: context.builderOpen ? "Close filter builder" : "Filter builder", group: "Filter & Views",
      shortcut: { key: "f" }, enabled: true, run: context.toggleBuilder,
    },
    {
      id: "views.save", label: "Save as Split View", group: "Filter & Views", shortcut: { key: "v" },
      enabled: true, run: context.saveView,
    },
    {
      id: "views.edit", label: "Edit current view", group: "Filter & Views",
      enabled: context.savedViewPosition !== null, run: context.editView,
    },
    {
      id: "views.delete", label: "Delete current view", group: "Filter & Views",
      enabled: context.savedViewPosition !== null, run: context.deleteView,
    },
    {
      id: "views.moveUp", label: "Move current view up", group: "Filter & Views",
      enabled: (context.savedViewPosition?.index ?? 0) > 0, run: () => context.moveView(-1),
    },
    {
      id: "views.moveDown", label: "Move current view down", group: "Filter & Views",
      enabled: context.savedViewPosition !== null && context.savedViewPosition.index < context.savedViewPosition.count - 1,
      run: () => context.moveView(1),
    },
    {
      id: "thread.archive", label: thread?.isArchived ? "Move to Inbox" : "Archive", group: "Thread", shortcut: { key: "e" },
      enabled: thread !== null,
      run: () => context.runThreadAction({ type: thread?.isArchived ? "moveToInbox" : "archive" }),
    },
    {
      id: "thread.label", label: "Apply / remove label", group: "Thread", shortcut: { key: "l" },
      enabled: thread !== null, run: context.openLabelPicker, opensPalettePage: true,
    },
    {
      id: "thread.toggleRead", label: thread?.isUnread ? "Mark as read" : "Mark as unread", group: "Thread", shortcut: { key: "u" },
      enabled: thread !== null,
      run: () => context.runThreadAction({ type: thread?.isUnread ? "markRead" : "markUnread" }),
    },
    {
      id: "thread.toggleStar", label: thread?.isStarred ? "Unstar" : "Star", group: "Thread", shortcut: { key: "s" },
      enabled: thread !== null,
      run: () => context.runThreadAction({ type: thread?.isStarred ? "unstar" : "star" }),
    },
    {
      id: "account.sync", label: context.syncing ? "Syncing…" : "Trigger sync", group: "Account", shortcut: { key: "S" },
      enabled: !context.syncing, run: context.sync,
    },
  ];

  // Views take the digit keys in sidebar order.
  context.views.slice(0, 9).forEach((view, index) => {
    actions.push({
      id: `views.go.${view.id}`, label: `Go to ${view.name}`, group: "Filter & Views", shortcut: { key: String(index + 1) },
      enabled: view.id !== context.viewId, run: () => context.goToView(view.id),
    });
  });

  // Accounts follow the PRD's Alt+1 / Alt+2 switcher shortcuts.
  context.accounts.forEach((account, index) => {
    actions.push({
      id: `account.switch.${account.id}`, label: `Switch to ${account.displayName}`, group: "Account",
      shortcut: { key: String(index + 1), alt: true },
      enabled: account.id !== context.accountId, run: () => context.switchAccount(account.id),
    });
  });

  return actions;
};

export const shortcutLabel = (shortcut: Shortcut): string => {
  if (shortcut.alt) return `⌥${shortcut.key.toUpperCase()}`;
  if (shortcut.key === "Escape") return "Esc";
  if (/^[A-Z]$/.test(shortcut.key)) return `⇧${shortcut.key}`;
  return shortcut.key.toUpperCase();
};

export const matchesShortcut = (
  event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "metaKey" | "ctrlKey">,
  shortcut: Shortcut,
): boolean => {
  if (event.metaKey || event.ctrlKey) return false;
  if (shortcut.alt) {
    // Option+digit types a symbol on macOS, so Alt shortcuts match the physical key.
    return event.altKey && (event.code === `Digit${shortcut.key}` || event.code === `Key${shortcut.key.toUpperCase()}`);
  }
  return !event.altKey && event.key === shortcut.key;
};

/** Vim keys must not fire while the user is typing. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
};
