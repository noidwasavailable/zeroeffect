import { useEffect, useMemo, useRef } from "react";
import type { AppAction } from "../actions";
import { attachmentPath, type AttachmentSummary, type LabelSummary, type ThreadDetail, type ThreadMessage } from "../../shared/api";
import { resolveInlineImages, sanitizeEmailHtml } from "../emailHtml";
import { displayName, formatBytes, formatFullDate, formatListDate } from "../format";
import { allMessagesExpanded, foldLayout, initialFold, toggleMessage, type MessageFold } from "../threadFolding";
import { toolbarButtonClass } from "./ActionToolbar";
import { Keycap } from "./Keycap";
import { LabelChips } from "./LabelChips";

// Email HTML assumes a light page, so bodies render on white in both themes. Paint containment
// clips the email to its box: its CSS (e.g. position: fixed) cannot draw over the app.
const SHADOW_STYLES = `
  :host { display: block; }
  .body { background: #fff; color: #18181b; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 16px; border-radius: 8px; overflow-wrap: anywhere; contain: paint; position: relative; overflow-x: auto; }
  .body img { max-width: 100%; }
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

/** A folded message: one clickable line with the sender, the start of the text and the date. */
function CollapsedMessage({ message, onExpand }: { readonly message: ThreadMessage; readonly onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      className="flex w-full items-baseline gap-3 rounded-lg border border-zinc-200 px-4 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
    >
      <span className={`shrink-0 ${message.isUnread ? "font-semibold" : "font-medium"}`}>{displayName(message.fromAddress)}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-500">{message.bodyMarkdown.replace(/\s+/g, " ").trim() || "(empty message)"}</span>
      {message.attachments.some((attachment) => !attachment.inline) && <span aria-label="Has attachments" className="shrink-0">📎</span>}
      <span className="shrink-0 text-xs text-zinc-500">{formatListDate(message.dateTs)}</span>
    </button>
  );
}

/** Download links for a message's files (inline images shown in the body are left out). */
function AttachmentList({ accountId, messageId, attachments }: {
  readonly accountId: string;
  readonly messageId: string;
  readonly attachments: ReadonlyArray<AttachmentSummary>;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2 border-t border-zinc-200 px-4 py-2 dark:border-zinc-800">
      {attachments.map((attachment) => (
        <li key={attachment.partId}>
          <a
            href={attachmentPath(accountId, messageId, attachment.partId)}
            download={attachment.filename}
            title={`Download ${attachment.filename}`}
            className="flex max-w-64 items-center gap-2 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            <span aria-hidden>📎</span>
            <span className="truncate">{attachment.filename}</span>
            <span className="shrink-0 text-zinc-500">{formatBytes(attachment.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Message({ accountId, message, onCollapse }: { readonly accountId: string; readonly message: ThreadMessage; readonly onCollapse: () => void }) {
  const { html, listed } = useMemo(() => {
    const inline = resolveInlineImages(
      message.bodyHtml ?? "",
      message.attachments,
      (attachment) => attachmentPath(accountId, message.id, attachment.partId, { inline: true }),
    );
    return {
      html: message.bodyHtml ? sanitizeEmailHtml(inline.html) : message.bodyHtmlSanitized,
      listed: message.attachments.filter((attachment) => !attachment.contentId || !inline.referenced.has(attachment.contentId)),
    };
  }, [accountId, message]);
  return (
    <article className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Clicking the header folds the message back to one line. */}
      <header
        aria-expanded={true}
        onClick={onCollapse}
        className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
      >
        <span className="font-medium">{message.fromAddress}</span>
        <span className="ml-auto text-xs text-zinc-500">{formatFullDate(message.dateTs)}</span>
        <span className="w-full truncate text-xs text-zinc-500">
          to {message.toAddresses.join(", ") || "(no recipients)"}
          {message.ccAddresses.length > 0 && ` · cc ${message.ccAddresses.join(", ")}`}
        </span>
      </header>
      <div className="p-2">
        {html
          ? <ShadowHtml html={html} />
          : <pre className="whitespace-pre-wrap p-2 font-sans text-sm">{message.bodyMarkdown || "(empty message)"}</pre>}
      </div>
      <AttachmentList accountId={accountId} messageId={message.id} attachments={listed} />
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

export function ThreadReader({ accountId, cursorIndex, thread, loading, error, labelCatalog, actions, fold, onFoldChange }: {
  readonly accountId: string;
  /** The message [ and ] last moved to (highlighted and scrolled into view); -1 before any move. */
  readonly cursorIndex: number;
  readonly thread: ThreadDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly labelCatalog: ReadonlyMap<string, LabelSummary>;
  readonly actions: ReadonlyArray<AppAction>;
  readonly fold: MessageFold | null;
  readonly onFoldChange: (fold: MessageFold) => void;
}) {
  // Start at the latest reply: when a conversation opens with it below the fold (e.g. several
  // unread messages expanded above it), scroll its top into view. Otherwise keep the subject visible.
  const latestRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const latest = latestRef.current;
    const pane = latest?.closest(".overflow-y-auto");
    if (!latest || !pane) return;
    if (latest.getBoundingClientRect().top > pane.getBoundingClientRect().bottom - 120) latest.scrollIntoView({ block: "start" });
  }, [thread?.id]);

  const cursorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (cursorIndex >= 0) cursorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [cursorIndex]);

  if (error) return <p role="alert" className="p-6 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!thread) return <p className="p-6 text-sm text-zinc-500">{loading ? "Loading conversation…" : "Select a conversation and press O to open it."}</p>;
  const currentFold = fold?.threadId === thread.id ? fold : initialFold(thread.id);
  const expandAll = actions.find((action) => action.id === "thread.toggleExpandAll");
  const lastIndex = thread.messages.length - 1;
  return (
    <section aria-label="Conversation" className="flex flex-col gap-3 p-4">
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-lg font-semibold">{thread.subject}</h2>
          <LabelChips labels={thread.labels} catalog={labelCatalog} />
        </div>
        {expandAll && thread.messages.length > 1 && (
          <button type="button" className={`${toolbarButtonClass} shrink-0`} disabled={!expandAll.enabled} onClick={expandAll.run}>
            {allMessagesExpanded(currentFold, thread.messages) ? "Collapse" : "Expand all"}
            {expandAll.shortcut && <Keycap shortcut={expandAll.shortcut} />}
          </button>
        )}
      </header>
      {thread.ghostLabels.length > 0 && <SuggestionBar labels={thread.ghostLabels} actions={actions} />}
      {foldLayout(currentFold, thread.messages).map((item) => {
        if (item.kind === "hidden") {
          return (
            <button
              key="hidden"
              type="button"
              onClick={() => onFoldChange({ ...currentFold, revealed: true })}
              className="flex items-center gap-3 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              {item.count} earlier {item.count === 1 ? "message" : "messages"}
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </button>
          );
        }
        const message = thread.messages[item.index]!;
        const toggle = () => onFoldChange(toggleMessage(currentFold, thread.messages, item.index));
        return (
          <div
            key={message.id}
            ref={(element) => {
              if (item.index === lastIndex) latestRef.current = element;
              if (item.index === cursorIndex) cursorRef.current = element;
            }}
            className={`scroll-mt-4 rounded-lg ${item.index === cursorIndex ? "ring-2 ring-blue-500/40" : ""}`}
          >
            {item.expanded ? <Message accountId={accountId} message={message} onCollapse={toggle} /> : <CollapsedMessage message={message} onExpand={toggle} />}
          </div>
        );
      })}
    </section>
  );
}
