import { useState, type Ref } from "react";
import { Keycap } from "./Keycap";

/** Boolean DSL query applied on top of the current view (Enter applies, Esc leaves the field). */
export function FilterBar({ value, error, onApply, ref }: {
  readonly value: string;
  readonly error: { readonly message: string; readonly offset?: number } | null;
  readonly onApply: (query: string) => void;
  readonly ref?: Ref<HTMLInputElement>;
}) {
  const [draft, setDraft] = useState(value);
  const [previousValue, setPreviousValue] = useState(value);
  // Follow external changes (e.g. switching views clears the query).
  if (value !== previousValue) {
    setPreviousValue(value);
    setDraft(value);
  }
  return (
    <form
      role="search"
      className="relative flex min-w-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft.trim());
      }}
    >
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 focus-within:border-zinc-400 dark:border-zinc-800 dark:focus-within:border-zinc-600">
        <input
          ref={ref}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
          <button type="button" className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => { setDraft(""); onApply(""); }}>
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
