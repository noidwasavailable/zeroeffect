import { useEffect, useRef, useState } from "react";
import { MAX_VIEW_NAME_LENGTH } from "../../shared/api";
import { parseFilterDsl } from "../../shared/filterParser";
import { toolbarButtonClass } from "./ActionToolbar";

/** Name + DSL form for saving the current filter as a split view, or editing a saved one. */
export function SaveViewDialog({ title, submitLabel, initialName, initialDsl, onSubmit, onClose }: {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName: string;
  readonly initialDsl: string;
  /** Resolves to an error message to show, or null on success. */
  readonly onSubmit: (name: string, dsl: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [dsl, setDsl] = useState(initialDsl);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const parsed = dsl.trim() ? parseFilterDsl(dsl) : null;
  const dslError = !parsed ? "A view needs a filter." : parsed.ok ? null : `${parsed.message} (at character ${parsed.offset + 1})`;
  const nameError = name.trim() ? null : "Name the view.";

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 p-4 pt-[15vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-[min(32rem,100%)] flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (nameError || dslError || saving) return;
          setSaving(true);
          const submitError = await onSubmit(name.trim(), dsl.trim());
          setSaving(false);
          if (submitError) setError(submitError);
        }}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input ref={nameRef} value={name} maxLength={MAX_VIEW_NAME_LENGTH} onChange={(event) => setName(event.target.value)}
            className="rounded border border-zinc-200 bg-transparent px-2 py-1.5 outline-none focus:border-zinc-400 dark:border-zinc-700" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Filter (Boolean DSL)
          <textarea value={dsl} rows={3} spellCheck={false} onChange={(event) => setDsl(event.target.value)}
            className="rounded border border-zinc-200 bg-transparent px-2 py-1.5 font-mono text-sm outline-none focus:border-zinc-400 dark:border-zinc-700" />
        </label>
        {(error ?? dslError) && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error ?? dslError}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={toolbarButtonClass} onClick={onClose}>Cancel</button>
          <button type="submit" className={toolbarButtonClass} disabled={Boolean(nameError || dslError) || saving}>{saving ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
