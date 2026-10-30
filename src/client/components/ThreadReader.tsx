import { useEffect, useRef } from "react";
import type { AppAction } from "../actions";
import type { LabelSummary, ThreadDetail, ThreadMessage } from "../../shared/api";
import { formatFullDate } from "../format";
import { toolbarButtonClass } from "./ActionToolbar";
import { Keycap } from "./Keycap";
import { LabelChips } from "./LabelChips";

// Email HTML assumes a light page, so bodies render on white in both themes.
const SHADOW_STYLES = `
  :host { display: block; }
  .body { background: #fff; color: #18181b; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 16px; border-radius: 8px; overflow-wrap: anywhere; }
  .body table { max-width: 100%; }
  .body a { color: #2563eb; }
  .body blockquote { margin: 0 0 0 8px; padding-left: 8px; border-left: 2px solid #d4d4d8; color: #52525b; }
`;

/** Renders sanitized message HTML inside a Shadow DOM so email styles cannot leak into the app (or vice versa). */
function ShadowHtml({ html }: { readonly html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${SHADOW_STYLES}</style><div class="body">${html}</div>`;
    // Links open in a new tab instead of navigating the app away.
    const onClick = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      if (/^(https?|mailto):/i.test(anchor.href)) window.open(anchor.href, "_blank", "noopener,noreferrer");
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [html]);
  return <div ref={host} />;
}

function Message({ message }: { readonly message: ThreadMessage }) {
  return (
    <article className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
        <span className="font-medium">{message.fromAddress}</span>
        <span className="ml-auto text-xs text-zinc-500">{formatFullDate(message.dateTs)}</span>
        <span className="w-full truncate text-xs text-zinc-500">
          to {message.toAddresses.join(", ") || "(no recipients)"}
          {message.ccAddresses.length > 0 && ` · cc ${message.ccAddresses.join(", ")}`}
        </span>
      </header>
      <div className="p-2">
        {message.bodyHtmlSanitized
          ? <ShadowHtml html={message.bodyHtmlSanitized} />
          : <pre className="whitespace-pre-wrap p-2 font-sans text-sm">{message.bodyMarkdown || "(empty message)"}</pre>}
      </div>
    </article>
  );
}

/** Dry-run suggestions from AI rules, waiting for a one-key decision. */
function SuggestionBar({ labels, actions }: { readonly labels: ReadonlyArray<string>; readonly actions: ReadonlyArray<AppAction> }) {
  const decisions = ["ai.acceptGhost", "ai.rejectGhost"].flatMap((id) => actions.find((action) => action.id === id) ?? []);
  return (
    <div role="group" aria-label="Suggested labels" className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
      <span className="text-zinc-600 dark:text-zinc-400">AI suggests</span>
      {labels.map((label) => <span key={label} className="rounded bg-zinc-100 px-1.5 text-xs leading-5 dark:bg-zinc-800">{label}</span>)}
      <span className="ml-auto flex gap-1.5">
        {decisions.map((action) => (
          <button key={action.id} type="button" className={toolbarButtonClass} disabled={!action.enabled} onClick={action.run}>
            {action.id === "ai.acceptGhost" ? "Accept" : "Reject"}
            {action.shortcut && <Keycap shortcut={action.shortcut} />}
          </button>
        ))}
      </span>
    </div>
  );
}

export function ThreadReader({ thread, loading, error, labelCatalog, actions }: {
  readonly thread: ThreadDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly labelCatalog: ReadonlyMap<string, LabelSummary>;
  readonly actions: ReadonlyArray<AppAction>;
}) {
  if (error) return <p role="alert" className="p-6 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!thread) return <p className="p-6 text-sm text-zinc-500">{loading ? "Loading conversation…" : "Select a conversation and press O to open it."}</p>;
  return (
    <section aria-label="Conversation" className="flex flex-col gap-3 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{thread.subject}</h2>
        <LabelChips labels={thread.labels} catalog={labelCatalog} />
      </header>
      {thread.ghostLabels.length > 0 && <SuggestionBar labels={thread.ghostLabels} actions={actions} />}
      {thread.messages.map((message) => <Message key={message.id} message={message} />)}
    </section>
  );
}
