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

export type ActionGroup = "Navigation" | "Thread" | "Selection" | "Labels" | "AI" | "Filter & Views" | "Account" | "Help";

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
  /**
   * The threads thread actions apply to: the checked threads when any are checked (bulk), else the
   * selected one. Labels follow them (e.g. "Mark as read" while any target is unread).
   */
  readonly targets: ReadonlyArray<ThreadSummary>;
  /** How many threads are checked for bulk actions. */
  readonly checkedCount: number;
  /** How many threads are loaded in the list (what "select all" checks). */
  readonly loadedCount: number;
  readonly viewName: string;
  /** The selected thread's one-time code, when it carries an OTP label (see shared/otp.ts). */
  readonly selectedOtpCode: string | null;
  readonly threadOpen: boolean;
  readonly canSelectNext: boolean;
  readonly canSelectPrevious: boolean;
  readonly syncing: boolean;
  readonly builderOpen: boolean;
  readonly auditOpen: boolean;
  readonly composerOpen: boolean;
  readonly aiBusy: boolean;
  /** The account's rules, for per-rule palette entries. */
  readonly rules: ReadonlyArray<{ readonly name: string; readonly automate: boolean }>;
  /** Position of the current view among saved views, or null for a built-in view. */
  readonly savedViewPosition: { readonly index: number; readonly count: number } | null;
  readonly moveSelection: (delta: 1 | -1) => void;
  readonly moveSelectionTo: (position: "first" | "last") => void;
  /** Moves through the open conversation's messages, expanding the one reached. */
  readonly moveMessage: (delta: 1 | -1) => void;
  readonly toggleChecked: () => void;
  readonly checkAll: () => void;
  readonly clearChecked: () => void;
  readonly markAllRead: () => void;
  readonly openForward: () => void;
  readonly openInGmail: () => void;
  readonly copyLink: () => void;
  readonly openLabelJump: () => void;
  readonly openLabelManager: () => void;
  readonly openAliases: () => void;
  readonly refreshAliases: () => void;
  readonly toggleHelp: () => void;
  /** Opens the selected thread, or closes the reader when one is open. */
  readonly openSelectedThread: () => void;
  readonly closeThread: () => void;
  readonly focusSearch: () => void;
  readonly runThreadAction: (action: ThreadAction) => void;
  readonly copyOtp: () => void;
  /** The open conversation's message count and whether every message is expanded. */
  readonly openMessageCount: number;
  readonly allMessagesExpanded: boolean;
  readonly toggleExpandAll: () => void;
  readonly newMessageOpen: boolean;
  readonly openNewMessage: () => void;
  readonly sendNewMessage: () => void;
  readonly discardNewMessage: () => void;
  /** Leaves the client for the account setup page (connect Gmail accounts, Pub/Sub). */
  readonly openSetup: () => void;
  readonly openLabelPicker: () => void;
  readonly switchAccount: (accountId: string) => void;
  readonly goToView: (viewId: string) => void;
  readonly sync: () => void;
  readonly toggleBuilder: () => void;
  readonly saveView: () => void;
  readonly editView: () => void;
  readonly deleteView: () => void;
  readonly moveView: (delta: 1 | -1) => void;
  readonly runAi: () => void;
  readonly decideGhostLabels: (decision: "accept" | "reject") => void;
  readonly toggleAudit: () => void;
  readonly undoAi: () => void;
  readonly openRules: (options?: { readonly newRule?: boolean }) => void;
  readonly toggleRuleDryRun: (ruleName: string) => void;
  readonly openComposer: (options: { readonly replyAll: boolean; readonly pickAlias: boolean }) => void;
  readonly changeAlias: () => void;
  readonly sendReply: () => void;
  readonly discardReply: () => void;
}

/** Action ids shown as buttons in the persistent toolbar, in order. */
export const TOOLBAR_ACTION_IDS = [
  "compose.new",
  "navigation.previous",
  "navigation.next",
  "navigation.open",
  "thread.archive",
  "thread.trash",
  "thread.label",
  "thread.toggleRead",
  "thread.toggleStar",
  "thread.reply",
  "thread.forward",
  "view.markAllRead",
  "ai.run",
  "ai.audit",
  "filter.builder",
  "views.save",
  "account.sync",
] as const;

export const buildActions = (context: ActionContext): ReadonlyArray<AppAction> => {
  const thread = context.selectedThread;
  const targets = context.targets;
  const hasTargets = targets.length > 0;
  // Bulk labels say how many threads they cover.
  const count = context.checkedCount > 0 ? ` (${context.checkedCount})` : "";
  const all = (predicate: (target: ThreadSummary) => boolean) => hasTargets && targets.every(predicate);
  const allArchived = all((target) => target.isArchived);
  const anyUnread = targets.some((target) => target.isUnread);
  const anyUnstarred = targets.some((target) => !target.isStarred);
  const allTrashed = all((target) => target.labels.includes("TRASH"));
  const allSpam = all((target) => target.labels.includes("SPAM"));
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
      id: "navigation.first", label: "First thread", group: "Navigation", shortcut: { key: "{" },
      enabled: context.canSelectPrevious, run: () => context.moveSelectionTo("first"),
    },
    {
      id: "navigation.last", label: "Last loaded thread", group: "Navigation", shortcut: { key: "}" },
      enabled: context.canSelectNext, run: () => context.moveSelectionTo("last"),
    },
    {
      id: "navigation.open", label: context.threadOpen ? "Close" : "Open", group: "Navigation", shortcut: { key: "o" },
      enabled: thread !== null || context.threadOpen, run: context.openSelectedThread,
    },
    {
      id: "navigation.nextMessage", label: "Next message in conversation", group: "Navigation", shortcut: { key: "]" },
      enabled: context.openMessageCount > 1, run: () => context.moveMessage(1),
    },
    {
      id: "navigation.previousMessage", label: "Previous message in conversation", group: "Navigation", shortcut: { key: "[" },
      enabled: context.openMessageCount > 1, run: () => context.moveMessage(-1),
    },
    {
      id: "navigation.close", label: "Close thread", group: "Navigation", shortcut: { key: "Escape" },
      enabled: context.threadOpen, run: context.closeThread,
    },
    {
      id: "navigation.search", label: "Search or filter by Boolean DSL", group: "Filter & Views", shortcut: { key: "/" },
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
      id: "thread.archive", label: `${allArchived ? "Move to Inbox" : "Archive"}${count}`, group: "Thread", shortcut: { key: "e" },
      enabled: hasTargets,
      run: () => context.runThreadAction({ type: allArchived ? "moveToInbox" : "archive" }),
    },
    {
      id: "thread.trash", label: `${allTrashed ? "Restore from Trash" : "Move to Trash"}${count}`, group: "Thread", shortcut: { key: "#" },
      enabled: hasTargets,
      run: () => context.runThreadAction({ type: allTrashed ? "untrash" : "trash" }),
    },
    {
      id: "thread.spam", label: `${allSpam ? "Not spam" : "Report spam"}${count}`, group: "Thread", shortcut: { key: "!" },
      enabled: hasTargets,
      run: () => context.runThreadAction({ type: allSpam ? "notSpam" : "spam" }),
    },
    {
      id: "thread.label", label: `Apply / remove label${count}`, group: "Labels", shortcut: { key: "l" },
      enabled: hasTargets, run: context.openLabelPicker, opensPalettePage: true,
    },
    {
      id: "thread.toggleRead", label: `${anyUnread ? "Mark as read" : "Mark as unread"}${count}`, group: "Thread", shortcut: { key: "u" },
      enabled: hasTargets,
      run: () => context.runThreadAction({ type: anyUnread ? "markRead" : "markUnread" }),
    },
    {
      id: "thread.toggleStar", label: `${anyUnstarred ? "Star" : "Unstar"}${count}`, group: "Thread", shortcut: { key: "s" },
      enabled: hasTargets,
      run: () => context.runThreadAction({ type: anyUnstarred ? "star" : "unstar" }),
    },
    {
      id: "view.markAllRead", label: `Mark all as read in ${context.viewName}`, group: "Selection", shortcut: { key: "U" },
      enabled: true, run: context.markAllRead,
    },
    {
      id: "selection.toggle", label: thread && context.checkedCount > 0 && targets.some((target) => target.id === thread.id) ? "Uncheck thread" : "Check thread",
      group: "Selection", shortcut: { key: " " }, enabled: thread !== null, run: context.toggleChecked,
    },
    {
      id: "selection.all", label: `Check all loaded threads (${context.loadedCount})`, group: "Selection", shortcut: { key: "*" },
      enabled: context.loadedCount > 0 && context.checkedCount < context.loadedCount, run: context.checkAll,
    },
    {
      id: "selection.clear", label: "Clear checked threads", group: "Selection", shortcut: { key: "X" },
      enabled: context.checkedCount > 0, run: context.clearChecked,
    },
    {
      id: "thread.forward", label: "Forward", group: "Thread", shortcut: { key: "F" },
      enabled: thread !== null && !context.newMessageOpen, run: context.openForward,
    },
    {
      id: "thread.openInGmail", label: "Open in Gmail", group: "Thread", shortcut: { key: "O" },
      enabled: thread !== null, run: context.openInGmail,
    },
    {
      id: "thread.copyLink", label: "Copy link to conversation", group: "Thread", shortcut: { key: "Y" },
      enabled: thread !== null, run: context.copyLink,
    },
    {
      id: "labels.jump", label: "Jump to label", group: "Labels", shortcut: { key: "L" },
      enabled: true, run: context.openLabelJump, opensPalettePage: true,
    },
    {
      id: "labels.manage", label: "Create, rename or delete labels", group: "Labels",
      enabled: true, run: context.openLabelManager, opensPalettePage: true,
    },
    {
      id: "thread.toggleExpandAll", label: context.allMessagesExpanded ? "Collapse older messages" : "Expand all messages",
      group: "Thread", shortcut: { key: ";" }, enabled: context.openMessageCount > 1, run: context.toggleExpandAll,
    },
    {
      id: "thread.copyOtp", label: context.selectedOtpCode ? `Copy code ${context.selectedOtpCode} and mark read` : "Copy one-time code",
      group: "Thread", shortcut: { key: "p" }, enabled: context.selectedOtpCode !== null, run: context.copyOtp,
    },
    {
      id: "thread.reply", label: "Reply", group: "Thread", shortcut: { key: "r" },
      enabled: thread !== null && !context.composerOpen, run: () => context.openComposer({ replyAll: false, pickAlias: false }),
    },
    {
      id: "thread.replyAlias", label: "Reply, choosing the sender alias", group: "Thread", shortcut: { key: "R" },
      enabled: thread !== null, run: () => context.openComposer({ replyAll: false, pickAlias: true }),
    },
    {
      id: "thread.replyAll", label: "Reply all", group: "Thread", shortcut: { key: "A" },
      enabled: thread !== null && !context.composerOpen, run: () => context.openComposer({ replyAll: true, pickAlias: false }),
    },
    {
      id: "composer.changeAlias", label: "Change sender alias", group: "Thread",
      enabled: context.composerOpen, run: context.changeAlias, opensPalettePage: true,
    },
    {
      id: "composer.send", label: "Send reply", group: "Thread",
      enabled: context.composerOpen, run: context.sendReply,
    },
    {
      id: "composer.discard", label: "Discard reply", group: "Thread",
      enabled: context.composerOpen, run: context.discardReply,
    },
    {
      id: "compose.new", label: "New message", group: "Thread", shortcut: { key: "c" },
      enabled: !context.newMessageOpen, run: context.openNewMessage,
    },
    {
      id: "compose.sendNew", label: "Send new message", group: "Thread",
      enabled: context.newMessageOpen, run: context.sendNewMessage,
    },
    {
      id: "compose.discardNew", label: "Discard new message", group: "Thread",
      enabled: context.newMessageOpen, run: context.discardNewMessage,
    },
    {
      id: "account.setup", label: "Account setup (connect Gmail, Pub/Sub)", group: "Account", shortcut: { key: "G" },
      enabled: true, run: context.openSetup,
    },
    {
      id: "account.aliases", label: "Send As aliases", group: "Account",
      enabled: true, run: context.openAliases, opensPalettePage: true,
    },
    {
      id: "account.refreshAliases", label: "Refresh Send As aliases from Gmail", group: "Account",
      enabled: true, run: context.refreshAliases,
    },
    {
      id: "help.shortcuts", label: "Keyboard shortcuts", group: "Help", shortcut: { key: "?" },
      enabled: true, run: context.toggleHelp,
    },
    {
      id: "account.sync", label: context.syncing ? "Syncing…" : "Trigger sync", group: "Account", shortcut: { key: "S" },
      enabled: !context.syncing, run: context.sync,
    },
    {
      id: "ai.run", label: context.aiBusy ? "Running AI…" : "Run AI", group: "AI", shortcut: { key: "a" },
      enabled: thread !== null && !context.aiBusy, run: context.runAi,
    },
    {
      id: "ai.acceptGhost", label: "Accept suggested labels", group: "AI", shortcut: { key: "y" },
      enabled: (thread?.ghostLabels.length ?? 0) > 0, run: () => context.decideGhostLabels("accept"),
    },
    {
      id: "ai.rejectGhost", label: "Reject suggested labels", group: "AI", shortcut: { key: "n" },
      enabled: (thread?.ghostLabels.length ?? 0) > 0, run: () => context.decideGhostLabels("reject"),
    },
    {
      id: "ai.audit", label: context.auditOpen ? "Close AI audit" : "AI audit", group: "AI", shortcut: { key: "w" },
      enabled: thread !== null || context.auditOpen, run: context.toggleAudit,
    },
    {
      id: "ai.undo", label: "Undo last AI action", group: "AI", shortcut: { key: "z" },
      enabled: !context.aiBusy, run: context.undoAi,
    },
    {
      id: "ai.rules", label: "AI rules & endpoints", group: "AI", shortcut: { key: "," },
      enabled: true, run: () => context.openRules(),
    },
    {
      id: "ai.createRule", label: "Create AI rule", group: "AI",
      enabled: true, run: () => context.openRules({ newRule: true }),
    },
  ];

  // Per-rule dry-run toggles (also a switch on each rule in the rules screen).
  for (const rule of context.rules) {
    actions.push({
      id: `ai.dryRun.${rule.name}`, label: `${rule.automate ? "Turn on" : "Turn off"} dry-run: ${rule.name}`, group: "AI",
      enabled: true, run: () => context.toggleRuleDryRun(rule.name),
    });
  }

  // Every view can be reached from the palette; the first nine (Trash and Spam aside) take the digit keys.
  let digit = 0;
  for (const view of context.views) {
    const key = !view.secondary && digit < 9 ? String(++digit) : null;
    actions.push({
      id: `views.go.${view.id}`, label: `Go to ${view.name}`, group: "Filter & Views", ...(key ? { shortcut: { key } } : {}),
      enabled: view.id !== context.viewId, run: () => context.goToView(view.id),
    });
  }

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
  if (shortcut.key === " ") return "Space";
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
