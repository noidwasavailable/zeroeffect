import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_APP_SETTINGS,
  isAccountId,
  type AccountEvent,
  type AppSettings,
  type LabelSummary as LabelRecordSummary,
  type SendAsAliasDetail,
  type AiAuditSummary,
  type AiRunSummary,
  type AccountSummary,
  type LabelSummary,
  type ServerStatus,
  type ThreadAction,
  type ThreadDetail,
  type ThreadSummary,
  type ViewSummary,
} from "../shared/api";
import type { AiRulesFile } from "../shared/aiRules";
import { formatFilterExpr } from "../shared/filterDsl";
import { parseFilterDsl } from "../shared/filterParser";
import { copyableOtp, otpLabelNames } from "../shared/otp";
import { copyText } from "./clipboard";
import { allMessagesExpanded, initialFold, revealMessage, toggleAllMessages, type MessageFold } from "./threadFolding";
import { applyThreadAction } from "../shared/threadActions";
import { BUILT_IN_VIEWS } from "../shared/views";
import { buildActions, type AppAction as AppActionType } from "./actions";
import { api, ApiRequestError } from "./api";
import { AccountSwitcher } from "./components/AccountSwitcher";
import { ActionToolbar, toolbarButtonClass } from "./components/ActionToolbar";
import { AiAuditDrawer } from "./components/AiAuditDrawer";
import { Keycap } from "./components/Keycap";
import { canSendNewMessage, emptyNewMessage, forwardMessage, NewMessageDialog, type NewMessageState } from "./components/NewMessageDialog";
import { outgoingAttachments } from "./components/AttachmentField";
import { ReplyComposer, splitAddressList, type ComposerState } from "./components/ReplyComposer";
import { RulesPanel } from "./components/RulesPanel";
import { CommandPalette, type PalettePage } from "./components/CommandPalette";
import { FilterBar } from "./components/FilterBar";
import { FilterBuilder } from "./components/FilterBuilder";
import { SaveViewDialog } from "./components/SaveViewDialog";
import { ThreadList } from "./components/ThreadList";
import { ThreadReader } from "./components/ThreadReader";
import { ViewSidebar } from "./components/ViewSidebar";
import { useAccountEvents } from "./hooks/useAccountEvents";
import { useVimShortcuts } from "./hooks/useVimShortcuts";
import { routePath, useRoute, type Route } from "./router";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { serverHealth, ServerStatusIndicator, ServerStatusPanel } from "./components/ServerStatusPanel";

const PAGE_SIZE = 50;
const MAX_REFRESH_SIZE = 200;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "Something went wrong.";

/** The DSL for "what you see now": the view's filter AND the extra query, when there is one. */
const combinedDsl = (viewDsl: string, query: string): string => {
  const view = parseFilterDsl(viewDsl);
  const extra = query.trim() ? parseFilterDsl(query) : null;
  if (!extra || !extra.ok) return viewDsl;
  if (!view.ok) return query.trim();
  return formatFilterExpr({ _tag: "And", expressions: [view.expression, extra.expression] });
};

/** Shown above the list while threads are checked: the count and the selection actions. */
function SelectionBar({ count, actions }: { readonly count: number; readonly actions: ReadonlyArray<AppActionType> }) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return (
    <div role="status" className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-200 bg-blue-50 px-4 py-1.5 text-sm dark:border-zinc-800 dark:bg-blue-950/40">
      <span className="font-medium">{count} checked</span>
      <span className="text-xs text-zinc-500">Thread actions apply to all of them.</span>
      <span className="ml-auto flex gap-1.5">
        {["selection.all", "selection.clear"].map((id) => {
          const action = byId.get(id);
          if (!action) return null;
          return (
            <button key={id} type="button" className={toolbarButtonClass} disabled={!action.enabled} onClick={action.run}>
              {id === "selection.all" ? "Check all" : "Clear"}
              {action.shortcut && <Keycap shortcut={action.shortcut} />}
            </button>
          );
        })}
      </span>
    </div>
  );
}

function FullPageMessage({ children }: { readonly children: ReactNode }) {
  return <main className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-600 dark:text-zinc-400">{children}</main>;
}

export function App() {
  const [route, navigate] = useRoute();
  const [accounts, setAccounts] = useState<ReadonlyArray<AccountSummary> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.accounts().then(setAccounts, (error) => setLoadError(errorMessage(error)));
  }, []);

  const connected = useMemo(() => (accounts ?? []).filter((account) => isAccountId(account.id)), [accounts]);
  useEffect(() => {
    const first = connected[0];
    if (!route && first) navigate({ accountId: first.id, viewId: "inbox", threadId: null }, { replace: true });
  }, [route, connected, navigate]);

  if (loadError) return <FullPageMessage>Could not load accounts: {loadError}</FullPageMessage>;
  if (!accounts) return <FullPageMessage>Loading…</FullPageMessage>;
  if (connected.length === 0) {
    return (
      <FullPageMessage>
        No Gmail account is connected yet. Open <a className="underline" href="/setup">account setup</a> on the server machine to connect one.
      </FullPageMessage>
    );
  }
  if (!route) return null;
  if (!connected.some((account) => account.id === route.accountId)) {
    return (
      <FullPageMessage>
        The {route.accountId} account is not connected. <a className="underline" href="/setup">Connect it</a> or{" "}
        <a className="underline" href="/">go to a connected account</a>.
      </FullPageMessage>
    );
  }
  // Keyed by account: switching remounts the inbox so no state crosses account silos.
  return <Inbox key={route.accountId} accounts={connected} route={route} navigate={navigate} />;
}

function Inbox({ accounts, route, navigate }: {
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly route: Route;
  readonly navigate: (route: Route, options?: { readonly replace?: boolean }) => void;
}) {
  const { accountId, viewId, threadId: openThreadId } = route;
  const account = accounts.find((candidate) => candidate.id === accountId)!;

  const [views, setViews] = useState<ReadonlyArray<ViewSummary>>(BUILT_IN_VIEWS);
  const [labels, setLabels] = useState<ReadonlyArray<LabelSummary>>([]);
  const [query, setQuery] = useState("");
  // The text in the DSL box, shared with the visual builder; applied as `query` on Enter / Apply.
  const [draft, setDraft] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [viewDialog, setViewDialog] = useState<{ readonly mode: "create" | "edit"; readonly name: string; readonly dsl: string } | null>(null);
  const [queryError, setQueryError] = useState<{ readonly message: string; readonly offset?: number } | null>(null);
  const [threads, setThreads] = useState<ReadonlyArray<ThreadSummary>>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Selection is tracked by id (stable across refreshes) with the index as a fallback when the thread leaves the view.
  const [selection, setSelection] = useState<{ readonly id: string | null; readonly index: number }>({ id: openThreadId, index: 0 });
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePage, setPalettePage] = useState<PalettePage>("actions");
  const [syncing, setSyncing] = useState(false);
  // Set while a sync the user asked for runs, so its completion (and only that one) is announced.
  const syncRequested = useRef(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  useEffect(() => {
    api.settings().then(setSettings, (error) => setNotice({ text: `Could not load settings: ${errorMessage(error)}`, tone: "error" }));
  }, []);
  const [notice, setNotice] = useState<{ readonly text: string; readonly tone: "info" | "error" } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audits, setAudits] = useState<{ readonly threadId: string | null; readonly entries: ReadonlyArray<AiAuditSummary>; readonly loading: boolean; readonly error: string | null }>({ threadId: null, entries: [], loading: false, error: null });
  const [rulesPanel, setRulesPanel] = useState<{ readonly newRule: boolean } | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [rulesFile, setRulesFile] = useState<AiRulesFile | null>(null);
  const ruleSummaries = useMemo(() => (rulesFile?.rules ?? []).map(({ name, automate }) => ({ name, automate })), [rulesFile]);
  const otpLabels = useMemo(() => otpLabelNames(rulesFile?.rules ?? []), [rulesFile]);
  const searchRef = useRef<HTMLInputElement>(null);
  // Threads checked for bulk actions (by id); cleared when the list's view or query changes.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const lastChecked = useRef<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const loadServerStatus = useCallback(() => {
    api.serverStatus().then(
      (status) => {
        setServerStatus(status);
        setServerStatusError(null);
      },
      (error) => setServerStatusError(errorMessage(error)),
    );
  }, []);
  // The server pushes "server-status" events; polling covers a dropped event stream.
  useEffect(() => {
    loadServerStatus();
    const timer = setInterval(loadServerStatus, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") loadServerStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadServerStatus]);
  const [accountAliases, setAccountAliases] = useState<ReadonlyArray<SendAsAliasDetail> | null>(null);
  useEffect(() => {
    setChecked(new Set());
    lastChecked.current = null;
  }, [viewId, query]);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const labelCatalog = useMemo(() => new Map(labels.map((label) => [label.name, label])), [labels]);
  const view = views.find((candidate) => candidate.id === viewId);
  const viewDsl = view?.dsl;

  const foundIndex = threads.findIndex((thread) => thread.id === selection.id);
  // The open conversation can leave the list while it is being read (e.g. marked read in Unread).
  // It stays the selection, sitting just before the row now at its old index, so j opens that row
  // and thread actions still apply to what is on screen.
  const openDetail = openThreadId !== null && detail?.id === openThreadId ? detail : null;
  const openLeftList = foundIndex < 0 && openDetail !== null && selection.id === openThreadId;
  const selectedIndex = foundIndex >= 0 ? foundIndex : openLeftList ? -1 : Math.min(selection.index, threads.length - 1);
  const selectedThread: ThreadSummary | null = openLeftList ? openDetail : threads[selectedIndex] ?? null;
  const canSelectNext = openLeftList ? selection.index < threads.length : selectedIndex < threads.length - 1;
  const canSelectPrevious = openLeftList ? selection.index > 0 : selectedIndex > 0;
  // Keep the remembered index on the selected row as the list shifts, for the fallback above.
  useEffect(() => {
    if (foundIndex >= 0 && foundIndex !== selection.index) setSelection((previous) => ({ ...previous, index: foundIndex }));
  }, [foundIndex, selection.index]);
  const checkedThreads = useMemo(() => threads.filter((thread) => checked.has(thread.id)), [threads, checked]);
  // Thread actions apply to the checked threads when there are any, else to the selected one.
  const targets = useMemo(
    () => checkedThreads.length > 0 ? checkedThreads : selectedThread ? [selectedThread] : [],
    [checkedThreads, selectedThread],
  );

  useEffect(() => {
    document.title = `${view?.name ?? "ZeroEffect"} · ${account.displayName} — ZeroEffect`;
  }, [view, account]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === "error" ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadMeta = useCallback(() => {
    api.views(accountId).then(setViews, (error) => setNotice({ text: `Could not load views: ${errorMessage(error)}`, tone: "error" }));
    api.labels(accountId).then(setLabels, (error) => setNotice({ text: `Could not load labels: ${errorMessage(error)}`, tone: "error" }));
  }, [accountId]);

  const loadRuleSummaries = useCallback(() => {
    api.rules(accountId).then(
      (loaded) => setRulesFile(loaded.rules),
      () => setRulesFile(null),
    );
  }, [accountId]);

  useEffect(() => {
    loadMeta();
    loadRuleSummaries();
    api.syncStatus(accountId).then(
      (job) => setSyncing(job?.status === "queued" || job?.status === "running"),
      () => undefined,
    );
  }, [accountId, loadMeta, loadRuleSummaries]);

  // Only the latest list request may update state; older responses are dropped.
  const listRequest = useRef(0);
  const loadThreads = useCallback(async (mode: "replace" | "refresh" | "more") => {
    const request = ++listRequest.current;
    setListLoading(true);
    try {
      const current = threadsRef.current;
      const page = await api.threads(accountId, {
        view: viewId,
        q: query,
        limit: mode === "refresh" ? Math.min(MAX_REFRESH_SIZE, Math.max(PAGE_SIZE, current.length)) : PAGE_SIZE,
        offset: mode === "more" ? current.length : 0,
      });
      if (request !== listRequest.current) return;
      setThreads((previous) => mode === "more" ? [...previous, ...page.threads] : page.threads);
      setHasMore(page.hasMore);
      setListError(null);
      setQueryError(null);
    } catch (error) {
      if (request !== listRequest.current) return;
      if (error instanceof ApiRequestError && error.status === 400 && query) {
        setQueryError({ message: error.message, ...(error.offset !== undefined ? { offset: error.offset } : {}) });
      } else {
        setListError(errorMessage(error));
      }
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
    // The view's filter is a dependency so editing it (here, in another tab, or by a label rename)
    // reloads the list.
  }, [accountId, viewId, query, viewDsl]);

  useEffect(() => {
    void loadThreads("replace");
  }, [loadThreads]);

  // Only the latest detail request for the open conversation may update the reader: with j/k
  // moving on (or a refresh for the previous conversation still in flight), late replies are dropped.
  const openThreadRef = useRef(openThreadId);
  openThreadRef.current = openThreadId;
  const detailRequest = useRef(0);
  const loadDetail = useCallback(async (threadId: string) => {
    const request = ++detailRequest.current;
    const current = () => request === detailRequest.current && threadId === openThreadRef.current;
    setDetailLoading(true);
    try {
      const thread = await api.thread(accountId, threadId);
      if (!current()) return;
      setDetail(thread);
      setDetailError(null);
    } catch (error) {
      if (current()) setDetailError(errorMessage(error));
    } finally {
      if (current()) setDetailLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (!openThreadId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setSelection((previous) => ({ id: openThreadId, index: previous.index }));
    setDetail((previous) => previous?.id === openThreadId ? previous : null);
    setDetailError(null);
    void loadDetail(openThreadId);
  }, [openThreadId, loadDetail]);

  const goTo = useCallback((next: Partial<Route>) => navigate({ ...route, ...next }), [navigate, route]);
  const closeThread = useCallback(() => goTo({ threadId: null }), [goTo]);

  const runThreadAction = useCallback(async (action: ThreadAction, target: ThreadSummary | null = selectedThread) => {
    if (!target) return;
    const replace = (next: ThreadSummary) => {
      setThreads((previous) => previous.map((thread) => thread.id === next.id ? next : thread));
      setDetail((previous) => previous?.id === next.id ? { ...previous, ...next } : previous);
    };
    replace(applyThreadAction(target, action, settings));
    try {
      replace(await api.threadAction(accountId, target.id, action));
      if (action.type === "archive" && openThreadId === target.id) closeThread();
      // Threads that no longer match the view (e.g. archived from Inbox) drop out on refresh.
      void loadThreads("refresh");
    } catch (error) {
      replace(target);
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [selectedThread, settings, accountId, openThreadId, closeThread, loadThreads]);

  /** Runs an action on the checked threads in one bulk request, or on the selected thread. */
  const runTargetsAction = useCallback(async (action: ThreadAction) => {
    if (checkedThreads.length === 0) return runThreadAction(action);
    const before = threadsRef.current;
    const ids = new Set(checkedThreads.map((thread) => thread.id));
    setThreads((previous) => previous.map((thread) => ids.has(thread.id) ? applyThreadAction(thread, action, settings) : thread));
    try {
      const result = await api.bulkThreadAction(accountId, { action, threadIds: [...ids] });
      setNotice({ text: `Updated ${result.threadsUpdated} ${result.threadsUpdated === 1 ? "conversation" : "conversations"}.`, tone: "info" });
      // Threads that leave the view take their checks with them; label and flag changes keep them.
      if (action.type !== "setLabels" && action.type !== "star" && action.type !== "unstar" && action.type !== "markRead" && action.type !== "markUnread") {
        setChecked(new Set());
      }
      if (openThreadId && ids.has(openThreadId)) void loadDetail(openThreadId);
    } catch (error) {
      setThreads(before);
      setNotice({ text: errorMessage(error), tone: "error" });
    }
    void loadThreads("refresh");
  }, [checkedThreads, runThreadAction, settings, accountId, openThreadId, loadDetail, loadThreads]);

  const markAllRead = useCallback(async () => {
    const scope = query ? `“${view?.name ?? viewId}” matching ${query}` : `“${view?.name ?? viewId}”`;
    if (!confirm(`Mark every unread conversation in ${scope} as read?`)) return;
    setThreads((previous) => previous.map((thread) => thread.isUnread ? applyThreadAction(thread, { type: "markRead" }) : thread));
    try {
      const result = await api.bulkThreadAction(accountId, { action: { type: "markRead" }, view: viewId, ...(query ? { q: query } : {}) });
      setNotice({ text: result.threadsUpdated === 0 ? "Nothing was unread." : `Marked ${result.threadsUpdated} ${result.threadsUpdated === 1 ? "conversation" : "conversations"} as read.`, tone: "info" });
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
    void loadThreads("refresh");
  }, [query, view, viewId, accountId, loadThreads]);

  const toggleChecked = useCallback((index: number, range = false) => {
    const thread = threads[index];
    if (!thread) return;
    setChecked((previous) => {
      const next = new Set(previous);
      const check = !previous.has(thread.id);
      // Shift-click checks (or unchecks) everything from the last toggled row.
      const from = range && lastChecked.current !== null ? Math.min(lastChecked.current, index) : index;
      const to = range && lastChecked.current !== null ? Math.max(lastChecked.current, index) : index;
      for (const candidate of threads.slice(from, to + 1)) {
        if (check) next.add(candidate.id);
        else next.delete(candidate.id);
      }
      return next;
    });
    lastChecked.current = index;
  }, [threads]);

  const loadAccountAliases = useCallback((refresh: boolean) => {
    setAccountAliases(null);
    (refresh ? api.refreshAliases(accountId) : api.aliases(accountId)).then(
      (aliases) => {
        setAccountAliases(aliases);
        if (refresh) setNotice({ text: `Loaded ${aliases.length} Send As ${aliases.length === 1 ? "alias" : "aliases"} from Gmail.`, tone: "info" });
      },
      (error) => {
        setAccountAliases([]);
        setNotice({ text: `Could not load aliases: ${errorMessage(error)}`, tone: "error" });
      },
    );
  }, [accountId]);

  const jumpToLabel = useCallback((label: string) => {
    const dsl = formatFilterExpr({ _tag: "Label", value: label });
    setSelection({ id: null, index: 0 });
    setDraft(dsl);
    setQuery(dsl);
    setQueryError(null);
    goTo({ viewId: "all", threadId: null });
  }, [goTo]);

  const createLabel = useCallback(async (name: string) => {
    try {
      await api.createLabel(accountId, name);
      setNotice({ text: `Created label “${name}”.`, tone: "info" });
      loadMeta();
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [accountId, loadMeta]);

  const renameLabel = useCallback(async (label: LabelRecordSummary) => {
    const name = prompt(`Rename “${label.name}” to:`, label.name)?.trim();
    if (!name || name === label.name) return;
    try {
      setLabels(await api.renameLabel(accountId, label.id, name));
      setNotice({ text: `Renamed “${label.name}” to “${name}” (also in saved views and AI rules).`, tone: "info" });
      void loadThreads("refresh");
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [accountId, loadThreads]);

  const deleteLabel = useCallback(async (label: LabelRecordSummary) => {
    if (!confirm(`Delete the label “${label.name}”? Gmail removes it from every conversation; the conversations themselves stay.`)) return;
    try {
      await api.deleteLabel(accountId, label.id);
      setNotice({ text: `Deleted label “${label.name}”.`, tone: "info" });
      loadMeta();
      void loadThreads("refresh");
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [accountId, loadMeta, loadThreads]);

  // Which messages of the open conversation are folded (see threadFolding.ts).
  const [messageFold, setMessageFold] = useState<MessageFold | null>(null);
  const currentFold = detail ? (messageFold?.threadId === detail.id ? messageFold : initialFold(detail.id)) : null;
  // The message [ and ] move between; it starts at the newest one.
  const [messageCursor, setMessageCursor] = useState<{ readonly threadId: string; readonly index: number } | null>(null);
  const cursorIndex = detail ? (messageCursor?.threadId === detail.id ? messageCursor.index : detail.messages.length - 1) : -1;

  // Copies an OTP-labelled thread's code (inside the user's click or key press, as clipboard
  // writes require) and then marks the thread read.
  const copyOtp = useCallback((target: ThreadSummary | null) => {
    const code = target ? copyableOtp(target, otpLabels) : null;
    if (!target || !code) return;
    copyText(code).then(() => {
      setNotice({ text: `Copied ${code}.`, tone: "info" });
      if (target.isUnread) void runThreadAction({ type: "markRead" }, target);
    }, (error) => setNotice({ text: `Could not copy the code: ${errorMessage(error)}`, tone: "error" }));
  }, [otpLabels, runThreadAction]);

  // Opening an unread thread marks it read, as in Gmail.
  const markedRead = useRef(new Set<string>());
  useEffect(() => {
    if (!detail?.isUnread || detail.id !== openThreadId || markedRead.current.has(detail.id)) return;
    markedRead.current.add(detail.id);
    void runThreadAction({ type: "markRead" }, detail);
  }, [detail, openThreadId, runThreadAction]);

  // The audit drawer follows the selected (or open) conversation.
  const auditThreadId = auditOpen ? selectedThread?.id ?? null : null;
  const loadAudits = useCallback(async (threadId: string) => {
    setAudits((previous) => ({ ...previous, threadId, loading: true, entries: previous.threadId === threadId ? previous.entries : [] }));
    try {
      const entries = await api.aiAudits(accountId, threadId);
      setAudits((previous) => previous.threadId === threadId ? { threadId, entries, loading: false, error: null } : previous);
    } catch (error) {
      setAudits((previous) => previous.threadId === threadId ? { ...previous, loading: false, error: errorMessage(error) } : previous);
    }
  }, [accountId]);
  useEffect(() => {
    if (auditThreadId) void loadAudits(auditThreadId);
  }, [auditThreadId, loadAudits]);

  /** Runs the AI rules on the targets: the checked threads (a few at a time), else the selected one. */
  const runAi = useCallback(async () => {
    const queue = [...targets];
    if (queue.length === 0) return;
    setAiBusy(true);
    const plural = (count: number) => `${count} ${count === 1 ? "conversation" : "conversations"}`;
    setNotice({ text: queue.length === 1 ? "Running AI rules…" : `Running AI rules on ${plural(queue.length)}…`, tone: "info" });
    const results: Array<{ readonly thread: ThreadSummary; readonly result: AiRunSummary | null; readonly error: string | null }> = [];
    const worker = async () => {
      for (let thread = queue.shift(); thread; thread = queue.shift()) {
        try {
          results.push({ thread, result: await api.runAi(accountId, thread.id), error: null });
        } catch (error) {
          results.push({ thread, result: null, error: errorMessage(error) });
        }
        if (targets.length > 1) setNotice({ text: `Running AI rules… ${results.length}/${targets.length}`, tone: "info" });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
      const [only] = results;
      if (results.length === 1 && only) {
        setNotice(only.result
          ? {
              text: only.result.appliedRules.length > 0
                ? `AI applied: ${only.result.appliedRules.join(", ")}${only.result.llmCalled ? "" : " (no LLM call needed)"}`
                : `No rule applied. ${only.result.reason}`,
              tone: "info",
            }
          : { text: only.error!, tone: "error" });
      } else {
        const labelled = results.filter((entry) => (entry.result?.appliedRules.length ?? 0) > 0).length;
        const failed = results.filter((entry) => entry.error !== null);
        setNotice({
          text: `AI applied rules to ${labelled} of ${plural(results.length)}.${failed.length > 0 ? ` ${failed.length} failed: ${failed[0]!.error}` : ""}`,
          tone: failed.length > 0 ? "error" : "info",
        });
      }
      void loadThreads("refresh");
      if (openThreadId && results.some((entry) => entry.thread.id === openThreadId)) void loadDetail(openThreadId);
      if (auditOpen && auditThreadId && results.some((entry) => entry.thread.id === auditThreadId)) void loadAudits(auditThreadId);
    } finally {
      setAiBusy(false);
    }
  }, [targets, accountId, openThreadId, auditOpen, auditThreadId, loadThreads, loadDetail, loadAudits]);

  const decideGhostLabels = useCallback(async (decision: "accept" | "reject") => {
    const target = selectedThread;
    if (!target || target.ghostLabels.length === 0) return;
    try {
      const updated = await api.decideGhostLabels(accountId, target.id, decision);
      setThreads((previous) => previous.map((thread) => thread.id === updated.id ? updated : thread));
      setDetail((previous) => previous?.id === updated.id ? updated : previous);
      setNotice({ text: decision === "accept" ? `Applied ${target.ghostLabels.join(", ")}.` : "Suggestion dismissed.", tone: "info" });
      if (decision === "accept") loadMeta();
      void loadThreads("refresh");
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [selectedThread, accountId, loadMeta, loadThreads]);

  const undoAi = useCallback(async () => {
    setAiBusy(true);
    try {
      const result = await api.undoAi(accountId);
      setNotice({ text: result.reverted ? "Undid the last AI action." : "There is no AI action to undo.", tone: "info" });
      if (result.threadId) {
        void loadThreads("refresh");
        if (openThreadId === result.threadId) void loadDetail(result.threadId);
        if (auditThreadId === result.threadId) void loadAudits(result.threadId);
      }
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    } finally {
      setAiBusy(false);
    }
  }, [accountId, openThreadId, auditThreadId, loadThreads, loadDetail, loadAudits]);

  const toggleRuleDryRun = useCallback(async (ruleName: string) => {
    try {
      const loaded = await api.rules(accountId);
      // Saving from here would rewrite the file without invalid rules, so leave that to the rules screen.
      if (loaded.problems.length > 0) {
        setNotice({ text: "The rules file has invalid rules; open AI rules (,) to fix them first.", tone: "error" });
        return;
      }
      const rules = loaded.rules.rules.map((rule) => rule.name === ruleName ? { ...rule, automate: !rule.automate } : rule);
      const saved = await api.saveRules(accountId, { ...loaded.rules, rules });
      setRulesFile(saved.rules);
      const automate = saved.rules.rules.find((rule) => rule.name === ruleName)?.automate;
      setNotice({ text: `${ruleName}: ${automate ? "applies automatically" : "dry run (suggestions only)"}.`, tone: "info" });
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [accountId]);

  // The composer belongs to one thread; it is only shown (and "open") while that thread is open.
  const composerVisible = composer !== null && composer.threadId === openThreadId;

  const openComposer = useCallback(async (options: { readonly replyAll: boolean; readonly pickAlias: boolean }) => {
    const target = selectedThread;
    if (!target) return;
    if (openThreadId !== target.id) goTo({ threadId: target.id });
    const choosePalette = () => {
      if (!options.pickAlias) return;
      setPalettePage("aliases");
      setPaletteOpen(true);
    };
    if (composer?.threadId === target.id) {
      if (options.replyAll) setComposer({ ...composer, cc: composer.draft.replyAllCc.join(", ") });
      choosePalette();
      return;
    }
    try {
      const draft = await api.replyDraft(accountId, target.id);
      setComposer({
        threadId: target.id,
        draft,
        to: draft.to.join(", "),
        cc: options.replyAll ? draft.replyAllCc.join(", ") : "",
        subject: draft.subject,
        body: "",
        fromAlias: draft.fromAlias ?? draft.aliases[0]?.sendAsEmail ?? "",
        attachments: [],
        sending: false,
        error: null,
      });
      choosePalette();
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [selectedThread, openThreadId, composer, accountId, goTo]);

  const sendReply = useCallback(async () => {
    if (!composer || composer.sending) return;
    const sending = composer;
    setComposer({ ...sending, sending: true, error: null });
    try {
      await api.sendReply(accountId, sending.threadId, {
        messageId: sending.draft.messageId,
        to: splitAddressList(sending.to),
        cc: splitAddressList(sending.cc),
        subject: sending.subject,
        body: sending.body,
        fromAlias: sending.fromAlias,
        attachments: outgoingAttachments(sending.attachments),
      });
      setComposer((current) => current?.threadId === sending.threadId ? null : current);
      setNotice({ text: `Reply sent as ${sending.fromAlias}.`, tone: "info" });
    } catch (error) {
      setComposer((current) => current?.threadId === sending.threadId ? { ...current, sending: false, error: errorMessage(error) } : current);
    }
  }, [composer, accountId]);

  const discardReply = useCallback(() => {
    if ((composer?.body.trim() || composer?.attachments.length) && !confirm("Discard this reply?")) return;
    setComposer(null);
  }, [composer]);

  const [newMessage, setNewMessage] = useState<NewMessageState | null>(null);
  const openNewMessage = useCallback(async (fromAlias?: string) => {
    if (newMessage) return;
    try {
      const message = emptyNewMessage(await api.newMessageDraft(accountId));
      setNewMessage(fromAlias ? { ...message, fromAlias } : message);
    } catch (error) {
      setNotice({ text: `Could not start a message: ${errorMessage(error)}`, tone: "error" });
    }
  }, [newMessage, accountId]);

  const sendNewMessage = useCallback(async () => {
    if (!newMessage || !canSendNewMessage(newMessage)) return;
    const sending = newMessage;
    setNewMessage({ ...sending, sending: true, error: null });
    try {
      const message = {
        to: splitAddressList(sending.to),
        cc: splitAddressList(sending.cc),
        bcc: splitAddressList(sending.bcc),
        subject: sending.subject,
        body: sending.body,
        fromAlias: sending.fromAlias,
        attachments: outgoingAttachments(sending.attachments),
      };
      if (sending.forward) {
        await api.sendForward(accountId, sending.forward.threadId, {
          ...message, messageId: sending.forward.draft.messageId, excludeAttachments: sending.forward.excluded,
        });
      } else {
        await api.sendMessage(accountId, message);
      }
      setNewMessage(null);
      setNotice({ text: sending.forward ? "Forwarded." : "Message sent.", tone: "info" });
    } catch (error) {
      setNewMessage((current) => current ? { ...current, sending: false, error: errorMessage(error) } : current);
    }
  }, [newMessage, accountId]);

  const openForward = useCallback(async () => {
    const target = selectedThread;
    if (newMessage || !target) return;
    try {
      setNewMessage(forwardMessage(target.id, await api.forwardDraft(accountId, target.id)));
    } catch (error) {
      setNotice({ text: `Could not start the forward: ${errorMessage(error)}`, tone: "error" });
    }
  }, [newMessage, selectedThread, accountId]);

  const discardNewMessage = useCallback(() => {
    if ((newMessage?.body.trim() || newMessage?.attachments.length) && !confirm("Discard this message?")) return;
    setNewMessage(null);
  }, [newMessage]);

  // A draft belongs to the account it was started in.
  useEffect(() => setNewMessage(null), [accountId]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useAccountEvents(accountId, (event: AccountEvent) => {
    if (event.type === "threads-changed") {
      // Coalesce bursts (e.g. a sync touching many threads) into one refresh.
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadThreads("refresh");
        // Syncs and AI runs can create labels or pick up color changes made in Gmail.
        api.labels(accountId).then(setLabels, () => undefined);
        if (openThreadId && (!event.threadIds || event.threadIds.includes(openThreadId))) void loadDetail(openThreadId);
        if (auditThreadId && (!event.threadIds || event.threadIds.includes(auditThreadId))) void loadAudits(auditThreadId);
      }, 300);
      return;
    }
    if (event.type === "views-changed") {
      api.views(accountId).then(setViews, () => undefined);
      return;
    }
    if (event.type === "rules-changed") {
      loadRuleSummaries();
      return;
    }
    if (event.type === "server-status") {
      loadServerStatus();
      return;
    }
    setSyncing(event.status === "queued" || event.status === "running");
    if (event.status === "completed") {
      loadMeta();
      if (syncRequested.current) setNotice({ text: `Synced ${account.displayName}.`, tone: "info" });
    }
    if (event.status === "failed") setNotice({ text: event.error ?? "Gmail sync failed.", tone: "error" });
    if (event.status === "completed" || event.status === "failed") syncRequested.current = false;
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const sync = useCallback(() => {
    setSyncing(true);
    syncRequested.current = true;
    api.sync(accountId).then(
      // A quick sync can finish (and announce itself) before this reply arrives.
      () => { if (syncRequested.current) setNotice({ text: `Syncing ${account.displayName}…`, tone: "info" }); },
      (error) => {
        // 409: a sync is already running; its completion is announced as this one's.
        if (error instanceof ApiRequestError && error.status === 409) return;
        syncRequested.current = false;
        setSyncing(false);
        setNotice({ text: errorMessage(error), tone: "error" });
      },
    );
  }, [accountId, account]);

  const toggleMarkReadOnArchive = useCallback(() => {
    const markReadOnArchive = !settings.markReadOnArchive;
    setSettings((previous) => ({ ...previous, markReadOnArchive }));
    api.saveSettings({ markReadOnArchive }).then(
      (saved) => {
        setSettings(saved);
        setNotice({ text: saved.markReadOnArchive ? "Archiving or trashing now marks conversations read." : "Archiving or trashing now leaves conversations unread.", tone: "info" });
      },
      (error) => {
        setSettings((previous) => ({ ...previous, markReadOnArchive: !markReadOnArchive }));
        setNotice({ text: `Could not save the setting: ${errorMessage(error)}`, tone: "error" });
      },
    );
  }, [settings]);

  const savedViews = views.filter((candidate) => !candidate.builtIn);
  const savedIndex = savedViews.findIndex((candidate) => candidate.id === viewId);

  const applyQuery = useCallback((next: string) => {
    setSelection({ id: null, index: 0 });
    setQuery(next);
    setQueryError(null);
  }, []);

  const submitView = useCallback(async (mode: "create" | "edit", name: string, dsl: string): Promise<string | null> => {
    try {
      const saved = mode === "create"
        ? await api.createView(accountId, { name, dsl })
        : await api.updateView(accountId, viewId, { name, dsl });
      setViews(await api.views(accountId));
      setViewDialog(null);
      setBuilderOpen(false);
      setQuery("");
      setDraft("");
      setSelection({ id: null, index: 0 });
      goTo({ viewId: saved.id, threadId: null });
      setNotice({ text: mode === "create" ? `Saved split view “${saved.name}”.` : `Updated “${saved.name}”.`, tone: "info" });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }, [accountId, viewId, goTo]);

  const actions = useMemo(() => buildActions({
    accounts,
    accountId,
    views,
    viewId,
    selectedThread,
    targets,
    checkedCount: checkedThreads.length,
    loadedCount: threads.length,
    viewName: view?.name ?? "this view",
    searchActive: query !== "" || draft.trim() !== "",
    moveSelectionTo: (position) => {
      const index = position === "first" ? 0 : threads.length - 1;
      const thread = threads[index];
      if (!thread) return;
      setSelection({ id: thread.id, index });
      if (openThreadId) goTo({ threadId: thread.id });
    },
    moveMessage: (delta) => {
      if (!detail || !currentFold) return;
      const index = Math.max(0, Math.min(detail.messages.length - 1, cursorIndex + delta));
      setMessageFold(revealMessage(currentFold, detail.messages, index));
      setMessageCursor({ threadId: detail.id, index });
    },
    toggleChecked: () => toggleChecked(selectedIndex),
    checkAll: () => setChecked(new Set(threads.map((thread) => thread.id))),
    clearChecked: () => setChecked(new Set()),
    markAllRead: () => void markAllRead(),
    openForward: () => void openForward(),
    openInGmail: () => {
      if (!selectedThread) return;
      // Gmail's web URLs take the account's address and the (hex) thread id.
      window.open(`https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#all/${encodeURIComponent(selectedThread.id)}`, "_blank", "noopener,noreferrer");
    },
    copyLink: () => {
      if (!selectedThread) return;
      copyText(`${location.origin}${routePath({ accountId, viewId, threadId: selectedThread.id })}`).then(
        () => setNotice({ text: "Copied a link to this conversation.", tone: "info" }),
        (error) => setNotice({ text: `Could not copy the link: ${errorMessage(error)}`, tone: "error" }),
      );
    },
    openLabelJump: () => {
      setPalettePage("labelJump");
      setPaletteOpen(true);
    },
    openLabelManager: () => {
      setPalettePage("labelManage");
      setPaletteOpen(true);
    },
    openAliases: () => {
      loadAccountAliases(false);
      setPalettePage("accountAliases");
      setPaletteOpen(true);
    },
    refreshAliases: () => loadAccountAliases(true),
    toggleHelp: () => setHelpOpen((open) => !open),
    selectedOtpCode: selectedThread ? copyableOtp(selectedThread, otpLabels) : null,
    threadOpen: openThreadId !== null,
    canSelectNext,
    canSelectPrevious,
    syncing,
    builderOpen,
    auditOpen,
    composerOpen: composerVisible,
    aiBusy,
    statusOpen,
    serverIssues: serverHealth(serverStatus).ongoing,
    toggleStatus: () => setStatusOpen((open) => !open),
    rules: ruleSummaries,
    savedViewPosition: savedIndex >= 0 ? { index: savedIndex, count: savedViews.length } : null,
    moveSelection: (delta) => {
      // From an open conversation that left the list, j goes to the row that took its place.
      const from = openLeftList ? selection.index - (delta > 0 ? 1 : 0) : selectedIndex;
      const index = Math.max(0, Math.min(threads.length - 1, from + delta));
      const thread = threads[index];
      if (!thread) return;
      setSelection({ id: thread.id, index });
      // With the reader open, j/k move through conversations.
      if (openThreadId) goTo({ threadId: thread.id });
    },
    openSelectedThread: () => {
      if (openThreadId) closeThread();
      else if (selectedThread) goTo({ threadId: selectedThread.id });
    },
    closeThread,
    focusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    runThreadAction: (action) => void runTargetsAction(action),
    copyOtp: () => copyOtp(selectedThread),
    openMessageCount: openThreadId && detail?.id === openThreadId ? detail.messages.length : 0,
    allMessagesExpanded: detail !== null && currentFold !== null && allMessagesExpanded(currentFold, detail.messages),
    toggleExpandAll: () => {
      if (detail && currentFold) setMessageFold(toggleAllMessages(currentFold, detail.messages));
    },
    newMessageOpen: newMessage !== null,
    openNewMessage: () => void openNewMessage(),
    sendNewMessage: () => void sendNewMessage(),
    discardNewMessage,
    openSetup: () => window.location.assign("/setup"),
    openLabelPicker: () => {
      setPalettePage("labels");
      setPaletteOpen(true);
    },
    switchAccount: (nextAccountId) => navigate({
      accountId: nextAccountId,
      viewId: BUILT_IN_VIEWS.some((builtIn) => builtIn.id === viewId) ? viewId : "inbox",
      threadId: null,
    }),
    goToView: (nextViewId) => {
      setQuery("");
      setDraft("");
      setSelection({ id: null, index: 0 });
      goTo({ viewId: nextViewId, threadId: null });
    },
    sync,
    toggleBuilder: () => setBuilderOpen((open) => !open),
    saveView: () => {
      // Prefer the draft when it is valid, so a filter built but not yet applied can be saved directly.
      const pending = draft.trim() && parseFilterDsl(draft).ok ? draft : query;
      setViewDialog({ mode: "create", name: "", dsl: combinedDsl(view?.dsl ?? "", pending) });
    },
    editView: () => {
      if (view && !view.builtIn) setViewDialog({ mode: "edit", name: view.name, dsl: view.dsl });
    },
    deleteView: () => {
      if (!view || view.builtIn || !confirm(`Delete the split view “${view.name}”?`)) return;
      api.deleteView(accountId, view.id).then(
        async () => {
          setViews(await api.views(accountId));
          goTo({ viewId: "inbox", threadId: null });
        },
        (error) => setNotice({ text: errorMessage(error), tone: "error" }),
      );
    },
    moveView: (delta) => {
      const ids = savedViews.map((candidate) => candidate.id);
      const target = savedIndex + delta;
      if (savedIndex < 0 || target < 0 || target >= ids.length) return;
      [ids[savedIndex], ids[target]] = [ids[target]!, ids[savedIndex]!];
      api.reorderViews(accountId, ids).then(setViews, (error) => setNotice({ text: errorMessage(error), tone: "error" }));
    },
    runAi: () => void runAi(),
    decideGhostLabels: (decision) => void decideGhostLabels(decision),
    toggleAudit: () => setAuditOpen((open) => !open),
    undoAi: () => void undoAi(),
    openRules: (options) => setRulesPanel({ newRule: options?.newRule ?? false }),
    toggleRuleDryRun: (ruleName) => void toggleRuleDryRun(ruleName),
    openComposer: (options) => void openComposer(options),
    changeAlias: () => {
      setPalettePage("aliases");
      setPaletteOpen(true);
    },
    sendReply: () => void sendReply(),
    discardReply,
    markReadOnArchive: settings.markReadOnArchive,
    toggleMarkReadOnArchive,
  }), [settings, toggleMarkReadOnArchive, openLeftList, selection.index, canSelectNext, canSelectPrevious, composerVisible, openComposer, sendReply, discardReply, accounts, account, accountId, views, view, viewId, savedViews, savedIndex, selectedThread, targets, checkedThreads, openThreadId, selectedIndex, threads, syncing, builderOpen, auditOpen, aiBusy, statusOpen, serverStatus, ruleSummaries, otpLabels, copyOtp, detail, currentFold, cursorIndex, newMessage, openNewMessage, openForward, sendNewMessage, discardNewMessage, draft, query, goTo, closeThread, runTargetsAction, markAllRead, toggleChecked, loadAccountAliases, navigate, sync, runAi, decideGhostLabels, undoAi, toggleRuleDryRun]);

  useVimShortcuts(actions, !paletteOpen && !helpOpen && !statusOpen && viewDialog === null && rulesPanel === null && newMessage === null);
  const setupAction = actions.find((action) => action.id === "account.setup");
  const rulesAction = actions.find((action) => action.id === "ai.rules");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        // Capture phase plus stopImmediatePropagation: the palette gets Cmd+K before any extension's
        // page listener (e.g. a password manager's own Cmd+K).
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalettePage("actions");
        setPaletteOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKeyDown, { capture: true });
    return () => removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="font-semibold tracking-tight">ZeroEffect</span>
        <AccountSwitcher accounts={accounts} activeAccountId={accountId} actions={actions} />
        {setupAction && (
          <button type="button" title={setupAction.label} className={toolbarButtonClass} onClick={setupAction.run}>
            Setup
            {setupAction.shortcut && <Keycap shortcut={setupAction.shortcut} />}
          </button>
        )}
        <FilterBar ref={searchRef} draft={draft} appliedError={queryError} onDraftChange={setDraft} onApply={applyQuery} />
        <ServerStatusIndicator status={serverStatus} action={actions.find((action) => action.id === "server.status")} />
        {rulesAction && (
          <button type="button" className={toolbarButtonClass} onClick={rulesAction.run}>
            AI rules
            {rulesAction.shortcut && <Keycap shortcut={rulesAction.shortcut} />}
          </button>
        )}
      </header>
      {builderOpen && (
        <FilterBuilder
          dsl={draft}
          labelNames={labels.map((label) => label.name)}
          onDslChange={setDraft}
          onApply={() => applyQuery(draft.trim())}
          onSave={() => actions.find((action) => action.id === "views.save")?.run()}
          onClose={() => setBuilderOpen(false)}
        />
      )}
      <ActionToolbar actions={actions} onOpenPalette={() => { setPalettePage("actions"); setPaletteOpen(true); }} />
      <div className="flex min-h-0 flex-1">
        <ViewSidebar views={views} activeViewId={viewId} actions={actions} settings={{ "settings.markReadOnArchive": settings.markReadOnArchive }} />
        <div className={`min-h-0 overflow-y-auto ${openThreadId ? "hidden w-[26rem] shrink-0 border-r border-zinc-200 md:block dark:border-zinc-800" : "flex-1"}`}>
          {checkedThreads.length > 0 && <SelectionBar count={checkedThreads.length} actions={actions} />}
          <ThreadList
            threads={threads}
            selectedIndex={selectedIndex}
            openThreadId={openThreadId}
            labelCatalog={labelCatalog}
            loading={listLoading}
            error={listError}
            hasMore={hasMore}
            checked={checked}
            onToggleChecked={toggleChecked}
            onSelect={(index) => setSelection({ id: threads[index]?.id ?? null, index })}
            onOpen={(index) => {
              const thread = threads[index];
              if (thread) goTo({ threadId: thread.id });
            }}
            onLoadMore={() => void loadThreads("more")}
            otpLabels={otpLabels}
            copyOtpAction={actions.find((action) => action.id === "thread.copyOtp")}
            onCopyOtp={(index) => {
              const thread = threads[index];
              if (!thread) return;
              setSelection({ id: thread.id, index });
              copyOtp(thread);
            }}
          />
        </div>
        {openThreadId && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ThreadReader accountId={accountId} cursorIndex={messageCursor?.threadId === detail?.id ? cursorIndex : -1} thread={detail} loading={detailLoading} error={detailError} labelCatalog={labelCatalog} actions={actions} fold={currentFold} onFoldChange={setMessageFold} />
            {composerVisible && composer && (
              <ReplyComposer
                state={composer}
                onChange={(update) => setComposer((current) => current ? { ...current, ...update, error: null } : current)}
                onSend={() => void sendReply()}
                onDiscard={discardReply}
              />
            )}
          </div>
        )}
        {auditOpen && (
          <AiAuditDrawer
            subject={selectedThread?.subject ?? null}
            audits={audits.threadId === auditThreadId ? audits.entries : []}
            loading={audits.loading}
            error={audits.threadId === auditThreadId ? audits.error : null}
            actions={actions}
          />
        )}
      </div>
      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`fixed bottom-4 left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg px-4 py-2 text-sm shadow-lg ${notice.tone === "error" ? "bg-red-600 text-white" : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"}`}
        >
          {notice.text}
        </div>
      )}
      {newMessage && (
        <NewMessageDialog
          state={newMessage}
          onChange={(update) => setNewMessage((current) => current ? { ...current, ...update, error: null } : current)}
          onSend={() => void sendNewMessage()}
          onDiscard={discardNewMessage}
        />
      )}
      {viewDialog && (
        <SaveViewDialog
          title={viewDialog.mode === "create" ? "Save as Split View" : "Edit split view"}
          submitLabel={viewDialog.mode === "create" ? "Save view" : "Save changes"}
          initialName={viewDialog.name}
          initialDsl={viewDialog.dsl}
          labelNames={labels.map((label) => label.name)}
          onSubmit={(name, dsl) => submitView(viewDialog.mode, name, dsl)}
          onClose={() => setViewDialog(null)}
        />
      )}
      {rulesPanel && (
        <RulesPanel
          accountId={accountId}
          accountName={account.displayName}
          startWithNewRule={rulesPanel.newRule}
          onClose={() => setRulesPanel(null)}
          onSaved={setRulesFile}
        />
      )}
      {helpOpen && <ShortcutHelp actions={actions} onClose={() => setHelpOpen(false)} />}
      {statusOpen && (
        <ServerStatusPanel
          status={serverStatus}
          error={serverStatusError}
          onRefresh={loadServerStatus}
          onDismissResolved={() => {
            api.dismissResolvedProblems().then(setServerStatus, (error) => setServerStatusError(errorMessage(error)));
          }}
          onClose={() => setStatusOpen(false)}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        page={palettePage}
        actions={actions}
        labels={labels}
        targets={targets}
        accountAliases={accountAliases}
        onJumpToLabel={jumpToLabel}
        onCreateLabel={(name) => void createLabel(name)}
        onRenameLabel={(label) => void renameLabel(label)}
        onDeleteLabel={(label) => void deleteLabel(label)}
        onComposeFromAlias={(sendAsEmail) => void openNewMessage(sendAsEmail)}
        onRefreshAliases={() => loadAccountAliases(true)}
        onOpenChange={setPaletteOpen}
        onPageChange={setPalettePage}
        aliases={composer?.draft.aliases ?? []}
        currentAlias={composer?.fromAlias ?? null}
        onChooseAlias={(sendAsEmail) => setComposer((current) => current ? { ...current, fromAlias: sendAsEmail } : current)}
        onToggleLabel={(label, applied) => {
          void runTargetsAction({ type: "setLabels", add: applied ? [] : [label], remove: applied ? [label] : [] }).then(loadMeta);
        }}
      />
    </div>
  );
}
