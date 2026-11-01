import { useEffect, useRef, useState } from "react";
import { MAX_VIEW_NAME_LENGTH } from "../../shared/api";
import { parseFilterDsl } from "../../shared/filterParser";
import { toolbarButtonClass } from "./ActionToolbar";
import { FilterTreeEditor } from "./FilterBuilder";

/**
 * Name + visual filter form for saving the current filter as a split view, or editing a saved one.
 * The filter is edited with the same builder as the filter bar (no free-form DSL), so a view can
 * only be saved with a filter that parses; the resulting DSL is shown read-only for reference.
 */
export function SaveViewDialog({ title, submitLabel, initialName, initialDsl, labelNames, onSubmit, onClose }: {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName: string;
  readonly initialDsl: string;
  readonly labelNames: ReadonlyArray<string>;
  /** Resolves to an error message to show, or null on success. */
  readonly onSubmit: (name: string, dsl: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [dsl, setDsl] = useState(initialDsl);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [complete, setComplete] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const parsed = dsl.trim() ? parseFilterDsl(dsl) : null;
  const dslError = !complete
    ? "Finish or remove the highlighted condition."
    : !parsed ? "Add at least one condition." : parsed.ok ? null : `${parsed.message} (at character ${parsed.offset + 1})`;
  const nameError = name.trim() ? null : "Name the view.";

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 p-4 pt-[15vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[80vh] w-[min(44rem,100%)] flex-col overflow-y-auto gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
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
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="pb-1">Filter</legend>
          <FilterTreeEditor dsl={dsl} labelNames={labelNames} onDslChange={setDsl} onCompleteChange={setComplete} />
          <code aria-label="Filter as DSL" className="break-all rounded bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-500 dark:bg-zinc-900">
            {dsl.trim() || "(no conditions)"}
          </code>
        </fieldset>
        {(error ?? dslError) && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error ?? dslError}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={toolbarButtonClass} onClick={onClose}>Cancel</button>
          <button type="submit" className={toolbarButtonClass} disabled={Boolean(nameError || dslError) || saving}>{saving ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
