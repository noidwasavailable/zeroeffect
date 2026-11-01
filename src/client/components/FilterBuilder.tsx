import { useId, useRef, useState } from "react";
import { formatFilterExpr } from "../../shared/filterDsl";
import { parseFilterDsl } from "../../shared/filterParser";
import {
  appendChild,
  fromBuilder,
  IS_VALUES,
  newCondition,
  newGroup,
  removeNode,
  toBuilder,
  updateNode,
  type BuilderGroup,
  type BuilderNode,
  type ConditionField,
} from "../filterBuilderModel";
import { noAutofill } from "../noAutofill";
import { toolbarButtonClass } from "./ActionToolbar";

const FIELDS: ReadonlyArray<{ readonly value: ConditionField; readonly label: string }> = [
  { value: "label", label: "Label" },
  { value: "from", label: "From contains" },
  { value: "subject", label: "Subject contains" },
  { value: "text", label: "Text contains" },
  { value: "is", label: "Is" },
];

const smallButton = "rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800";
const inputClass = "rounded border border-zinc-200 bg-transparent px-2 py-1 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700";

const treeFromDsl = (dsl: string): BuilderGroup | null => {
  if (!dsl.trim()) return toBuilder(null);
  const parsed = parseFilterDsl(dsl);
  return parsed.ok ? toBuilder(parsed.expression) : null;
};

/**
 * Visual AND / OR / NOT editor bound to a DSL string. Edits here rewrite the DSL; outside DSL
 * changes rebuild the tree (when they parse). Incomplete conditions are flagged and keep the last
 * valid DSL until they are filled in; `onCompleteChange` reports whether the tree converts.
 */
export function FilterTreeEditor({ dsl, labelNames, onDslChange, onCompleteChange }: {
  readonly dsl: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly onDslChange: (dsl: string) => void;
  readonly onCompleteChange?: (complete: boolean) => void;
}) {
  const [tree, setTree] = useState<BuilderGroup>(() => treeFromDsl(dsl) ?? toBuilder(null));
  // The DSL this editor last emitted; other DSL changes came from outside (e.g. the DSL box).
  const emitted = useRef(dsl);
  const [syncedDsl, setSyncedDsl] = useState(dsl);
  if (dsl !== syncedDsl) {
    setSyncedDsl(dsl);
    if (dsl !== emitted.current) {
      const next = treeFromDsl(dsl);
      if (next) setTree(next);
    }
  }
  const datalistId = useId();
  const result = fromBuilder(tree);

  const edit = (next: BuilderGroup) => {
    setTree(next);
    const built = fromBuilder(next);
    onCompleteChange?.(built.ok);
    if (!built.ok) return;
    const nextDsl = built.expression ? formatFilterExpr(built.expression) : "";
    emitted.current = nextDsl;
    onDslChange(nextDsl);
  };

  const renderNode = (node: BuilderNode, depth: number) => {
    const invalid = !result.ok && result.nodeId === node.id;
    const notToggle = (
      <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        <input type="checkbox" checked={node.negated} onChange={(event) => edit(updateNode(tree, node.id, (current) => ({ ...current, negated: event.target.checked })))} />
        NOT
      </label>
    );
    const remove = depth > 0 && (
      <button type="button" className={smallButton} aria-label="Remove" onClick={() => edit(removeNode(tree, node.id))}>✕</button>
    );

    if (node.kind === "condition") {
      return (
        <div key={node.id} className="flex flex-wrap items-center gap-2">
          {notToggle}
          <select
            aria-label="Field"
            className={inputClass}
            value={node.field}
            onChange={(event) => {
              const field = event.target.value as ConditionField;
              edit(updateNode(tree, node.id, (current) => ({ ...current, field, value: field === "is" ? "unread" : current.kind === "condition" && current.field !== "is" ? current.value : "" })));
            }}
          >
            {FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
          </select>
          {node.field === "is" ? (
            <select aria-label="State" className={inputClass} value={node.value} onChange={(event) => edit(updateNode(tree, node.id, (current) => ({ ...current, value: event.target.value })))}>
              {IS_VALUES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          ) : (
            <input
              {...noAutofill}
              aria-label="Value"
              aria-invalid={invalid}
              list={node.field === "label" ? datalistId : undefined}
              className={`${inputClass} w-56 ${invalid ? "border-red-500 dark:border-red-500" : ""}`}
              value={node.value}
              placeholder={node.field === "label" ? "Label name" : node.field === "text" ? "Words or a phrase" : "Text"}
              onChange={(event) => edit(updateNode(tree, node.id, (current) => ({ ...current, value: event.target.value })))}
            />
          )}
          {remove}
          {invalid && <span className="text-xs text-red-600 dark:text-red-400">{result.error}</span>}
        </div>
      );
    }

    return (
      <div key={node.id} className={`flex flex-col gap-2 ${depth > 0 ? "rounded-md border border-zinc-200 p-2 dark:border-zinc-800" : ""} ${invalid ? "border-red-500 dark:border-red-500" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          {notToggle}
          <div role="radiogroup" aria-label="Combine with" className="flex overflow-hidden rounded border border-zinc-200 text-xs dark:border-zinc-700">
            {(["And", "Or"] as const).map((operator) => (
              <button
                key={operator}
                type="button"
                role="radio"
                aria-checked={node.operator === operator}
                className={`px-2 py-0.5 ${node.operator === operator ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""}`}
                onClick={() => edit(updateNode(tree, node.id, (current) => ({ ...current, operator })))}
              >
                {operator.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="text-xs text-zinc-500">{node.operator === "And" ? "all of" : "any of"}</span>
          <button type="button" className={smallButton} onClick={() => edit(appendChild(tree, node.id, newCondition()))}>+ Add Condition</button>
          <button type="button" className={smallButton} onClick={() => edit(appendChild(tree, node.id, newGroup(node.operator === "And" ? "Or" : "And")))}>
            + Add {node.operator === "And" ? "OR" : "AND"} Group
          </button>
          {remove}
          {invalid && <span className="text-xs text-red-600 dark:text-red-400">{result.error}</span>}
        </div>
        <div className="flex flex-col gap-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
          {node.children.length === 0
            ? <span className="text-xs text-zinc-500">{depth === 0 ? "No conditions: every conversation in the view matches." : "Empty group."}</span>
            : node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      </div>
    );
  };

  return (
    <>
      {renderNode(tree, 0)}
      <datalist id={datalistId}>
        {labelNames.map((name) => <option key={name} value={name} />)}
      </datalist>
    </>
  );
}

/** The filter bar's builder panel: the tree editor plus apply / save, bound to the DSL draft. */
export function FilterBuilder({ dsl, labelNames, onDslChange, onApply, onSave, onClose }: {
  readonly dsl: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly onDslChange: (dsl: string) => void;
  readonly onApply: () => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
}) {
  // A tree built from DSL is always complete; only edits can leave a condition unfinished.
  const [complete, setComplete] = useState(true);
  const dslInvalid = dsl.trim() !== "" && !parseFilterDsl(dsl).ok;
  return (
    <section aria-label="Filter builder" className="flex flex-col gap-3 border-b border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      {dslInvalid && (
        <p className="text-xs text-amber-700 dark:text-amber-400">The DSL above has a syntax error; the builder shows the last valid filter.</p>
      )}
      <FilterTreeEditor dsl={dsl} labelNames={labelNames} onDslChange={onDslChange} onCompleteChange={setComplete} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={toolbarButtonClass} disabled={!complete || dslInvalid} onClick={onApply}>Apply filter</button>
        <button type="button" className={toolbarButtonClass} disabled={!complete || dslInvalid} onClick={onSave}>Save as Split View…</button>
        <button type="button" className={`${toolbarButtonClass} ml-auto`} onClick={onClose}>Close builder</button>
      </div>
    </section>
  );
}
