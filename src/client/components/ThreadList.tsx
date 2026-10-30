import { useEffect, useRef } from "react";
import type { LabelSummary, ThreadSummary } from "../../shared/api";
import { displayName, formatListDate } from "../format";
import { LabelChips } from "./LabelChips";

export function ThreadList({ threads, selectedIndex, openThreadId, labelCatalog, loading, error, hasMore, onSelect, onOpen, onLoadMore }: {
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
              <span className="ml-auto shrink-0 text-xs text-zinc-500">{formatListDate(thread.lastMessageAt)}</span>
            </div>
            <div className={`truncate text-sm ${thread.isUnread ? "font-medium" : ""}`}>{thread.subject}</div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{thread.snippet}</span>
              <LabelChips labels={thread.labels} ghost={thread.ghostLabels} catalog={labelCatalog} />
            </div>
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
