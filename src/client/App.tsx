import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isAccountId,
  type AccountEvent,
  type AiAuditSummary,
  type AccountSummary,
  type LabelSummary,
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
import { allMessagesExpanded, initialFold, toggleAllMessages, type MessageFold } from "./threadFolding";
import { applyThreadAction } from "../shared/threadActions";
import { BUILT_IN_VIEWS } from "../shared/views";
import { buildActions } from "./actions";
import { api, ApiRequestError } from "./api";
import { AccountSwitcher } from "./components/AccountSwitcher";
import { ActionToolbar, toolbarButtonClass } from "./components/ActionToolbar";
import { AiAuditDrawer } from "./components/AiAuditDrawer";
import { Keycap } from "./components/Keycap";
import { canSendNewMessage, emptyNewMessage, NewMessageDialog, type NewMessageState } from "./components/NewMessageDialog";
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
import { useRoute, type Route } from "./router";

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

  // Which messages of the open conversation are folded (see threadFolding.ts).
  const [messageFold, setMessageFold] = useState<MessageFold | null>(null);
  const currentFold = detail ? (messageFold?.threadId === detail.id ? messageFold : initialFold(detail.id)) : null;

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
    if (!detail?.isUnread || markedRead.current.has(detail.id)) return;
    markedRead.current.add(detail.id);
    void runThreadAction({ type: "markRead" }, detail);
  }, [detail, runThreadAction]);

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

  const runAi = useCallback(async () => {
    const target = selectedThread;
    if (!target) return;
    setAiBusy(true);
    setNotice({ text: "Running AI rules…", tone: "info" });
    try {
      const result = await api.runAi(accountId, target.id);
      setNotice({
        text: result.appliedRules.length > 0
          ? `AI applied: ${result.appliedRules.join(", ")}${result.llmCalled ? "" : " (no LLM call needed)"}`
          : `No rule applied. ${result.reason}`,
        tone: "info",
      });
      void loadThreads("refresh");
      if (openThreadId === target.id) void loadDetail(target.id);
      if (auditOpen) void loadAudits(target.id);
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: "error" });
    } finally {
      setAiBusy(false);
    }
  }, [selectedThread, accountId, openThreadId, auditOpen, loadThreads, loadDetail, loadAudits]);

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
      });
      setComposer((current) => current?.threadId === sending.threadId ? null : current);
      setNotice({ text: `Reply sent as ${sending.fromAlias}.`, tone: "info" });
    } catch (error) {
      setComposer((current) => current?.threadId === sending.threadId ? { ...current, sending: false, error: errorMessage(error) } : current);
    }
  }, [composer, accountId]);

  const discardReply = useCallback(() => {
    if (composer?.body.trim() && !confirm("Discard this reply?")) return;
    setComposer(null);
  }, [composer]);

  const [newMessage, setNewMessage] = useState<NewMessageState | null>(null);
  const openNewMessage = useCallback(async () => {
    if (newMessage) return;
    try {
      setNewMessage(emptyNewMessage(await api.newMessageDraft(accountId)));
    } catch (error) {
      setNotice({ text: `Could not start a message: ${errorMessage(error)}`, tone: "error" });
    }
  }, [newMessage, accountId]);

  const sendNewMessage = useCallback(async () => {
    if (!newMessage || !canSendNewMessage(newMessage)) return;
    const sending = newMessage;
    setNewMessage({ ...sending, sending: true, error: null });
    try {
      await api.sendMessage(accountId, {
        to: splitAddressList(sending.to),
        cc: splitAddressList(sending.cc),
        bcc: splitAddressList(sending.bcc),
        subject: sending.subject,
        body: sending.body,
        fromAlias: sending.fromAlias,
      });
      setNewMessage(null);
      setNotice({ text: "Message sent.", tone: "info" });
    } catch (error) {
      setNewMessage((current) => current ? { ...current, sending: false, error: errorMessage(error) } : current);
    }
  }, [newMessage, accountId]);

  const discardNewMessage = useCallback(() => {
    if (newMessage?.body.trim() && !confirm("Discard this message?")) return;
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
    selectedOtpCode: selectedThread ? copyableOtp(selectedThread, otpLabels) : null,
    threadOpen: openThreadId !== null,
    canSelectNext: selectedIndex < threads.length - 1,
    canSelectPrevious: selectedIndex > 0,
    syncing,
    builderOpen,
    auditOpen,
    composerOpen: composerVisible,
    aiBusy,
    rules: ruleSummaries,
    savedViewPosition: savedIndex >= 0 ? { index: savedIndex, count: savedViews.length } : null,
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
  }), [composerVisible, openComposer, sendReply, discardReply, accounts, accountId, views, view, viewId, savedViews, savedIndex, selectedThread, openThreadId, selectedIndex, threads, syncing, builderOpen, auditOpen, aiBusy, ruleSummaries, otpLabels, copyOtp, detail, currentFold, newMessage, openNewMessage, sendNewMessage, discardNewMessage, draft, query, goTo, closeThread, runThreadAction, navigate, sync, runAi, decideGhostLabels, undoAi, toggleRuleDryRun]);

  useVimShortcuts(actions, !paletteOpen && viewDialog === null && rulesPanel === null && newMessage === null);
  const setupAction = actions.find((action) => action.id === "account.setup");
  const rulesAction = actions.find((action) => action.id === "ai.rules");

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
        {setupAction && (
          <button type="button" title={setupAction.label} className={toolbarButtonClass} onClick={setupAction.run}>
            Setup
            {setupAction.shortcut && <Keycap shortcut={setupAction.shortcut} />}
          </button>
        )}
        <FilterBar ref={searchRef} draft={draft} appliedError={queryError} onDraftChange={setDraft} onApply={applyQuery} />
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
            <ThreadReader thread={detail} loading={detailLoading} error={detailError} labelCatalog={labelCatalog} actions={actions} fold={currentFold} onFoldChange={setMessageFold} />
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
      <CommandPalette
        open={paletteOpen}
        page={palettePage}
        actions={actions}
        labels={labels}
        thread={selectedThread}
        onOpenChange={setPaletteOpen}
        onPageChange={setPalettePage}
        aliases={composer?.draft.aliases ?? []}
        currentAlias={composer?.fromAlias ?? null}
        onChooseAlias={(sendAsEmail) => setComposer((current) => current ? { ...current, fromAlias: sendAsEmail } : current)}
        onToggleLabel={(label, applied) => {
          void runThreadAction({ type: "setLabels", add: applied ? [] : [label], remove: applied ? [label] : [] }).then(loadMeta);
        }}
      />
    </div>
  );
}
