import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isAccountId,
  type AccountEvent,
  type AccountSummary,
  type LabelSummary,
  type ThreadAction,
  type ThreadDetail,
  type ThreadSummary,
  type ViewSummary,
} from "../shared/api";
import { applyThreadAction } from "../shared/threadActions";
import { BUILT_IN_VIEWS } from "../shared/views";
import { buildActions } from "./actions";
import { api, ApiRequestError } from "./api";
import { AccountSwitcher } from "./components/AccountSwitcher";
import { ActionToolbar } from "./components/ActionToolbar";
import { CommandPalette, type PalettePage } from "./components/CommandPalette";
import { FilterBar } from "./components/FilterBar";
import { ThreadList } from "./components/ThreadList";
import { ThreadReader } from "./components/ThreadReader";
import { ViewSidebar } from "./components/ViewSidebar";
import { useAccountEvents } from "./hooks/useAccountEvents";
import { useVimShortcuts } from "./hooks/useVimShortcuts";
import { useRoute, type Route } from "./router";

const PAGE_SIZE = 50;
const MAX_REFRESH_SIZE = 200;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "Something went wrong.";

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
  const [notice, setNotice] = useState<{ readonly text: string; readonly tone: "info" | "error" } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const labelCatalog = useMemo(() => new Map(labels.map((label) => [label.name, label])), [labels]);
  const view = views.find((candidate) => candidate.id === viewId);

  const foundIndex = threads.findIndex((thread) => thread.id === selection.id);
  const selectedIndex = foundIndex >= 0 ? foundIndex : Math.min(selection.index, threads.length - 1);
  const selectedThread = threads[selectedIndex] ?? null;

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

  useEffect(() => {
    loadMeta();
    api.syncStatus(accountId).then(
      (job) => setSyncing(job?.status === "queued" || job?.status === "running"),
      () => undefined,
    );
  }, [accountId, loadMeta]);

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
  }, [accountId, viewId, query]);

  useEffect(() => {
    void loadThreads("replace");
  }, [loadThreads]);

  const loadDetail = useCallback(async (threadId: string) => {
    setDetailLoading(true);
    try {
      const thread = await api.thread(accountId, threadId);
      setDetail(thread);
      setDetailError(null);
    } catch (error) {
      setDetailError(errorMessage(error));
    } finally {
      setDetailLoading(false);
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
    replace(applyThreadAction(target, action));
    try {
      replace(await api.threadAction(accountId, target.id, action));
      if (action.type === "archive" && openThreadId === target.id) closeThread();
      // Threads that no longer match the view (e.g. archived from Inbox) drop out on refresh.
      void loadThreads("refresh");
    } catch (error) {
      replace(target);
      setNotice({ text: errorMessage(error), tone: "error" });
    }
  }, [selectedThread, accountId, openThreadId, closeThread, loadThreads]);

  // Opening an unread thread marks it read, as in Gmail.
  const markedRead = useRef(new Set<string>());
  useEffect(() => {
    if (!detail?.isUnread || markedRead.current.has(detail.id)) return;
    markedRead.current.add(detail.id);
    void runThreadAction({ type: "markRead" }, detail);
  }, [detail, runThreadAction]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useAccountEvents(accountId, (event: AccountEvent) => {
    if (event.type === "threads-changed") {
      // Coalesce bursts (e.g. a sync touching many threads) into one refresh.
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadThreads("refresh");
        if (openThreadId && (!event.threadIds || event.threadIds.includes(openThreadId))) void loadDetail(openThreadId);
      }, 300);
      return;
    }
    setSyncing(event.status === "queued" || event.status === "running");
    if (event.status === "completed") loadMeta();
    if (event.status === "failed") setNotice({ text: event.error ?? "Gmail sync failed.", tone: "error" });
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const sync = useCallback(() => {
    setSyncing(true);
    api.sync(accountId).then(
      () => setNotice({ text: `Syncing ${account.displayName}…`, tone: "info" }),
      (error) => {
        if (error instanceof ApiRequestError && error.status === 409) return;
        setSyncing(false);
        setNotice({ text: errorMessage(error), tone: "error" });
      },
    );
  }, [accountId, account]);

  const actions = useMemo(() => buildActions({
    accounts,
    accountId,
    views,
    viewId,
    selectedThread,
    threadOpen: openThreadId !== null,
    canSelectNext: selectedIndex < threads.length - 1,
    canSelectPrevious: selectedIndex > 0,
    syncing,
    moveSelection: (delta) => {
      const index = Math.max(0, Math.min(threads.length - 1, selectedIndex + delta));
      const thread = threads[index];
      if (!thread) return;
      setSelection({ id: thread.id, index });
      // With the reader open, j/k move through conversations.
      if (openThreadId) goTo({ threadId: thread.id });
    },
    openSelectedThread: () => {
      if (selectedThread) goTo({ threadId: selectedThread.id });
    },
    closeThread,
    focusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    runThreadAction: (action) => void runThreadAction(action),
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
      setSelection({ id: null, index: 0 });
      goTo({ viewId: nextViewId, threadId: null });
    },
    sync,
  }), [accounts, accountId, views, viewId, selectedThread, openThreadId, selectedIndex, threads, syncing, goTo, closeThread, runThreadAction, navigate, sync]);

  useVimShortcuts(actions, !paletteOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalettePage("actions");
        setPaletteOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="font-semibold tracking-tight">ZeroEffect</span>
        <AccountSwitcher accounts={accounts} activeAccountId={accountId} actions={actions} />
        <FilterBar
          ref={searchRef}
          value={query}
          error={queryError}
          onApply={(next) => {
            setSelection({ id: null, index: 0 });
            setQuery(next);
            setQueryError(null);
          }}
        />
      </header>
      <ActionToolbar actions={actions} onOpenPalette={() => { setPalettePage("actions"); setPaletteOpen(true); }} />
      <div className="flex min-h-0 flex-1">
        <ViewSidebar views={views} activeViewId={viewId} actions={actions} />
        <div className={`min-h-0 overflow-y-auto ${openThreadId ? "hidden w-[26rem] shrink-0 border-r border-zinc-200 md:block dark:border-zinc-800" : "flex-1"}`}>
          <ThreadList
            threads={threads}
            selectedIndex={selectedIndex}
            openThreadId={openThreadId}
            labelCatalog={labelCatalog}
            loading={listLoading}
            error={listError}
            hasMore={hasMore}
            onSelect={(index) => setSelection({ id: threads[index]?.id ?? null, index })}
            onOpen={(index) => {
              const thread = threads[index];
              if (thread) goTo({ threadId: thread.id });
            }}
            onLoadMore={() => void loadThreads("more")}
          />
        </div>
        {openThreadId && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ThreadReader thread={detail} loading={detailLoading} error={detailError} labelCatalog={labelCatalog} />
          </div>
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
      <CommandPalette
        open={paletteOpen}
        page={palettePage}
        actions={actions}
        labels={labels}
        thread={selectedThread}
        onOpenChange={setPaletteOpen}
        onPageChange={setPalettePage}
        onToggleLabel={(label, applied) => {
          void runThreadAction({ type: "setLabels", add: applied ? [] : [label], remove: applied ? [label] : [] }).then(loadMeta);
        }}
      />
    </div>
  );
}
