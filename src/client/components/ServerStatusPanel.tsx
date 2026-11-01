import type { AppAction } from "../actions";
import type { PubSubState, ServerProblem, ServerProblemSource, ServerStatus } from "../../shared/api";
import { formatFullDate } from "../format";
import { toolbarButtonClass } from "./ActionToolbar";
import { Keycap } from "./Keycap";

const PUBSUB_LABELS: Record<PubSubState, string> = {
  disabled: "Not configured",
  unauthorized: "Not authorized",
  connecting: "Connecting…",
  listening: "Listening",
  retrying: "Reconnecting",
  needs_reauthorization: "Needs reauthorization",
};

const SOURCE_LABELS: Record<ServerProblemSource, string> = {
  pubsub: "Pub/Sub listener",
  catch_up: "Catch-up sync",
  watch: "Gmail watch",
  notifications: "Notification processing",
  ai: "AI labelling",
  sync: "Sync after sending",
};

/** Pub/Sub states that mean new mail waits for the 10-minute catch-up sync. */
const DEGRADED: ReadonlySet<PubSubState> = new Set(["unauthorized", "retrying", "needs_reauthorization"]);

/** "ok" when nothing needs attention; "warn" for a degraded Pub/Sub or ongoing problems. */
export const serverHealth = (status: ServerStatus | null): { readonly tone: "ok" | "warn"; readonly ongoing: number } => {
  const ongoing = status?.problems.filter((problem) => problem.resolvedAt === null).length ?? 0;
  return { tone: ongoing > 0 || (status !== null && DEGRADED.has(status.pubSub.state)) ? "warn" : "ok", ongoing };
};

/** Header button: a status dot and, when something is wrong, how many problems are ongoing. */
export function ServerStatusIndicator({ status, action }: { readonly status: ServerStatus | null; readonly action: AppAction | undefined }) {
  if (!action) return null;
  const { tone, ongoing } = serverHealth(status);
  const pubSub = status ? PUBSUB_LABELS[status.pubSub.state] : "Unknown";
  return (
    <button
      type="button"
      title={`Pub/Sub: ${pubSub}${ongoing > 0 ? ` · ${ongoing} ongoing ${ongoing === 1 ? "problem" : "problems"}` : ""}`}
      className={`${toolbarButtonClass} ${tone === "warn" ? "border-amber-400 text-amber-800 dark:border-amber-600 dark:text-amber-300" : ""}`}
      onClick={action.run}
    >
      <span aria-hidden="true" className={`inline-block size-2 rounded-full ${tone === "warn" ? "bg-amber-500" : "bg-emerald-500"}`} />
      {tone === "warn" ? (ongoing > 0 ? `${ongoing} ${ongoing === 1 ? "issue" : "issues"}` : `Pub/Sub: ${pubSub}`) : "Status"}
      {action.shortcut && <Keycap shortcut={action.shortcut} />}
    </button>
  );
}

function ProblemItem({ problem }: { readonly problem: ServerProblem }) {
  const resolved = problem.resolvedAt !== null;
  return (
    <li className={`rounded-md border p-2 ${resolved ? "border-zinc-200 opacity-70 dark:border-zinc-800" : "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{SOURCE_LABELS[problem.source]}</span>
        {problem.accountId && <span className="text-xs text-zinc-500">{problem.accountId}</span>}
        <span className="ml-auto text-xs text-zinc-500">
          {resolved ? `Resolved ${formatFullDate(problem.resolvedAt!)}` : `Last ${formatFullDate(problem.lastAt)}`}
          {problem.count > 1 && ` · ${problem.count}×`}
        </span>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-zinc-700 dark:text-zinc-300">{problem.message}</pre>
      {problem.count > 1 && <p className="mt-1 text-xs text-zinc-500">Since {formatFullDate(problem.firstAt)}</p>}
    </li>
  );
}

/** Background problems (Pub/Sub, syncs, watches, notifications, AI runs) that otherwise only reach the server log. */
export function ServerStatusPanel({ status, error, onRefresh, onDismissResolved, onClose }: {
  readonly status: ServerStatus | null;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onDismissResolved: () => void;
  readonly onClose: () => void;
}) {
  const problems = status?.problems ?? [];
  const resolvedCount = problems.filter((problem) => problem.resolvedAt !== null).length;
  const pubSub = status?.pubSub;
  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 p-4 pt-[8vh]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Server status"
        tabIndex={-1}
        ref={(element) => element?.focus()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "H") {
            event.preventDefault();
            onClose();
          }
        }}
        className="flex max-h-[80vh] w-[min(44rem,100%)] flex-col gap-3 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-950"
      >
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Server status</h2>
          <span className="text-xs text-zinc-500">Since the server started. Esc closes.</span>
        </header>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {pubSub && (
          <div className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">Gmail Pub/Sub</span>
              <span className={DEGRADED.has(pubSub.state) ? "text-amber-700 dark:text-amber-400" : "text-zinc-600 dark:text-zinc-400"}>{PUBSUB_LABELS[pubSub.state]}</span>
              {pubSub.since > 0 && <span className="ml-auto text-xs text-zinc-500">since {formatFullDate(pubSub.since)}</span>}
            </div>
            {pubSub.detail && <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-zinc-700 dark:text-zinc-300">{pubSub.detail}</pre>}
            {DEGRADED.has(pubSub.state) && (
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                New mail still arrives through the catch-up sync every 10 minutes.{" "}
                {pubSub.state !== "retrying" && <a className="underline" href="/setup">Reconnect Pub/Sub on the setup page</a>}
              </p>
            )}
          </div>
        )}
        {problems.length === 0
          ? <p className="text-sm text-zinc-500">No background problems.</p>
          : <ul className="flex flex-col gap-2">{problems.map((problem) => <ProblemItem key={problem.id} problem={problem} />)}</ul>}
        <div className="flex gap-2">
          <button type="button" className={toolbarButtonClass} onClick={onRefresh}>Refresh</button>
          <button type="button" className={toolbarButtonClass} disabled={resolvedCount === 0} onClick={onDismissResolved}>
            Clear resolved{resolvedCount > 0 ? ` (${resolvedCount})` : ""}
          </button>
          <button type="button" className={`${toolbarButtonClass} ml-auto`} onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
