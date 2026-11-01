import { useEffect, useRef } from "react";
import type { AppAction } from "../actions";
import type { LabelSummary, ThreadSummary } from "../../shared/api";
import { copyableOtp } from "../../shared/otp";
import { displayName, formatListDate } from "../format";
import { Keycap } from "./Keycap";
import { LabelChips } from "./LabelChips";

export function ThreadList({ threads, selectedIndex, openThreadId, labelCatalog, loading, error, hasMore, onSelect, onOpen, onLoadMore, otpLabels, copyOtpAction, onCopyOtp }: {
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly selectedIndex: number;
  readonly openThreadId: string | null;
  readonly labelCatalog: ReadonlyMap<string, LabelSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly onSelect: (index: number) => void;
  readonly onOpen: (index: number) => void;
  readonly onLoadMore: () => void;
  /** Labels that mark one-time-code mail; such rows get a copy button. */
  readonly otpLabels: ReadonlySet<string>;
  /** The "copy code" action, for its shortcut badge on the selected row. */
  readonly copyOtpAction?: AppAction;
  readonly onCopyOtp: (index: number) => void;
}) {
  const selectedRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, threads]);

  if (error) {
    return <p role="alert" className="p-6 text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!loading && threads.length === 0) {
    return <p className="p-6 text-sm text-zinc-500">No conversations match this view.</p>;
  }
  return (
    <ul role="listbox" aria-label="Conversations" className="divide-y divide-zinc-100 dark:divide-zinc-900">
      {threads.map((thread, index) => {
        const selected = index === selectedIndex;
        const otp = copyableOtp(thread, otpLabels);
        return (
          <li
            key={thread.id}
            ref={selected ? selectedRef : undefined}
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(index)}
            onDoubleClick={() => onOpen(index)}
            className={`relative flex cursor-default flex-col gap-0.5 px-4 py-2.5 ${selected ? "bg-zinc-100 dark:bg-zinc-900" : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"} ${thread.id === openThreadId ? "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-blue-500" : ""}`}
          >
            <div className="flex items-baseline gap-2">
              <span className={`truncate text-sm ${thread.isUnread ? "font-semibold" : "text-zinc-600 dark:text-zinc-400"}`}>
                {displayName(thread.senderSummary)}
              </span>
              {thread.isStarred && <span aria-label="Starred" className="text-amber-500">★</span>}
              {otp && (
                <button
                  type="button"
                  title="Copy the code and mark as read"
                  className="ml-auto flex shrink-0 items-center gap-1.5 rounded border border-zinc-300 px-1.5 font-mono text-xs leading-5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  onClick={(event) => { event.stopPropagation(); onCopyOtp(index); }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  Copy {otp}
                  {selected && copyOtpAction?.shortcut && <Keycap shortcut={copyOtpAction.shortcut} />}
                </button>
              )}
              <span className={`${otp ? "" : "ml-auto "}shrink-0 text-xs text-zinc-500`}>{formatListDate(thread.lastMessageAt)}</span>
            </div>
            {/* Labels lead the subject, as in Gmail, so they stay readable however long the subject is. */}
            <div className="flex min-w-0 items-center gap-1.5">
              <LabelChips labels={thread.labels} ghost={thread.ghostLabels} catalog={labelCatalog} className="max-w-[60%] shrink-0 overflow-hidden" />
              <span className={`min-w-0 truncate text-sm ${thread.isUnread ? "font-medium" : ""}`}>{thread.subject}</span>
            </div>
            <div className="truncate text-xs text-zinc-500">{thread.snippet}</div>
          </li>
        );
      })}
      {(hasMore || loading) && (
        <li className="p-3 text-center">
          <button type="button" disabled={loading} onClick={onLoadMore} className="text-sm text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200">
            {loading ? "Loading…" : "Load more"}
          </button>
        </li>
      )}
    </ul>
  );
}
