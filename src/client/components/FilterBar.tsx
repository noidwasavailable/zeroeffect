import type { Ref } from "react";
import { parseFilterDsl } from "../../shared/filterParser";
import { Keycap } from "./Keycap";

/** Boolean DSL query applied on top of the current view (Enter applies, Esc leaves the field). */
export function FilterBar({ draft, appliedError, onDraftChange, onApply, ref }: {
  readonly draft: string;
  /** A server-side rejection of the last applied query. */
  readonly appliedError: { readonly message: string; readonly offset?: number } | null;
  readonly onDraftChange: (draft: string) => void;
  readonly onApply: (query: string) => void;
  readonly ref?: Ref<HTMLInputElement>;
}) {
  // Validate while typing with the same parser the server uses.
  const parsed = draft.trim() ? parseFilterDsl(draft) : null;
  const error = parsed && !parsed.ok ? parsed : appliedError;
  return (
    <form
      role="search"
      className="relative flex min-w-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed || parsed.ok) onApply(draft.trim());
      }}
    >
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 focus-within:border-zinc-400 dark:border-zinc-800 dark:focus-within:border-zinc-600">
        <input
          ref={ref}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          spellCheck={false}
          aria-label="Filter by Boolean DSL"
          aria-invalid={error !== null}
          placeholder='is:unread AND (label:"Label A" OR from:boss)'
          className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-sm outline-none placeholder:text-zinc-400"
        />
        {draft && (
          <button type="button" className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => { onDraftChange(""); onApply(""); }}>
            Clear
          </button>
        )}
        <Keycap label="/" />
      </div>
      {error && (
        <p role="alert" className="absolute top-full z-10 mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700 shadow dark:bg-red-950 dark:text-red-300">
          {error.message}{error.offset !== undefined && ` (at character ${error.offset + 1})`}
        </p>
      )}
    </form>
  );
}
