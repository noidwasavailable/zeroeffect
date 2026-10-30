import type { AppAction } from "../actions";
import type { AiAuditSummary } from "../../shared/api";
import { formatFullDate } from "../format";
import { toolbarButtonClass } from "./ActionToolbar";
import { Keycap } from "./Keycap";

const STATUS_LABELS: Record<string, string> = {
  TO_REPLY: "To reply",
  AWAITING_REPLY: "Awaiting reply",
  FYI: "FYI",
  ACTIONED: "Actioned",
};

function Changes({ audit }: { readonly audit: AiAuditSummary }) {
  const { labelsAdded, labelsRemoved, ghostLabelsAdded } = audit.changes;
  if (labelsAdded.length + labelsRemoved.length + ghostLabelsAdded.length === 0) {
    return <p className="text-xs text-zinc-500">No changes.</p>;
  }
  const describe = (label: string) => label === "INBOX" ? "Inbox (archived)" : label === "UNREAD" ? "Unread (marked read)" : label;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {labelsAdded.map((label) => <li key={`+${label}`} className="text-emerald-700 dark:text-emerald-400">+ {label}</li>)}
      {labelsRemoved.map((label) => <li key={`-${label}`} className="text-red-700 dark:text-red-400">− {describe(label)}</li>)}
      {ghostLabelsAdded.map((label) => <li key={`?${label}`} className="text-zinc-500">suggested: {label}</li>)}
    </ul>
  );
}

/** Why the AI labelled the current thread the way it did: one entry per run, newest first. */
export function AiAuditDrawer({ subject, audits, loading, error, actions }: {
  readonly subject: string | null;
  readonly audits: ReadonlyArray<AiAuditSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly actions: ReadonlyArray<AppAction>;
}) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const footer = ["ai.run", "ai.undo", "ai.audit"].flatMap((id) => byId.get(id) ?? []);
  return (
    <aside aria-label="AI audit" className="flex w-80 shrink-0 flex-col border-l border-zinc-200 dark:border-zinc-800">
      <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">AI audit</h2>
        <p className="truncate text-xs text-zinc-500">{subject ?? "Select a conversation."}</p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!error && loading && audits.length === 0 && <p className="text-sm text-zinc-500">Loading…</p>}
        {!error && !loading && audits.length === 0 && subject && (
          <p className="text-sm text-zinc-500">The AI has not looked at this conversation yet. Press A to run it.</p>
        )}
        {audits.map((audit) => (
          <article key={audit.id} className={`flex flex-col gap-1.5 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${audit.reverted ? "opacity-60" : ""}`}>
            <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
              <span>{formatFullDate(audit.createdAt)}</span>
              <span>{audit.trigger === "manual" ? "Run manually" : "New mail"}{audit.reverted ? " · undone" : ""}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {audit.ruleNames.length === 0
                ? <span className="text-sm text-zinc-500">No rule matched</span>
                : audit.ruleNames.map((name) => <span key={name} className="rounded bg-zinc-100 px-1.5 text-xs leading-5 dark:bg-zinc-800">{name}</span>)}
              {audit.conversationStatus && (
                <span className="rounded bg-blue-100 px-1.5 text-xs leading-5 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                  {STATUS_LABELS[audit.conversationStatus] ?? audit.conversationStatus}
                </span>
              )}
            </div>
            <p className="text-sm">{audit.reasoning}</p>
            <Changes audit={audit} />
            <p className="text-[11px] text-zinc-500">
              {audit.modelUsed ? `${audit.modelUsed} · ${audit.apiModeUsed} · ${audit.latencyMs} ms` : "No LLM call (static or inherited match)"}
            </p>
          </article>
        ))}
      </div>
      <footer className="flex flex-wrap gap-1.5 border-t border-zinc-200 p-3 dark:border-zinc-800">
        {footer.map((action) => (
          <button key={action.id} type="button" className={toolbarButtonClass} disabled={!action.enabled} onClick={action.run}>
            {action.label}
            {action.shortcut && <Keycap shortcut={action.shortcut} />}
          </button>
        ))}
      </footer>
    </aside>
  );
}
