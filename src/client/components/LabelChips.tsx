import type { LabelSummary } from "../../shared/api";
import { isVisibleLabel } from "../../shared/views";

export function LabelChips({ labels, catalog, ghost = [] }: {
  readonly labels: ReadonlyArray<string>;
  readonly catalog: ReadonlyMap<string, LabelSummary>;
  readonly ghost?: ReadonlyArray<string>;
}) {
  const visible = labels.filter(isVisibleLabel);
  if (visible.length === 0 && ghost.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {visible.map((label) => {
        const entry = catalog.get(label);
        return (
          <span
            key={label}
            className="rounded px-1.5 text-[11px] leading-5 ring-1 ring-zinc-200 ring-inset dark:ring-zinc-700"
            style={entry?.colorBg ? { backgroundColor: entry.colorBg, color: entry.colorText ?? undefined } : undefined}
          >
            {label}
          </span>
        );
      })}
      {ghost.map((label) => (
        <span key={`ghost:${label}`} title="Suggested by an AI rule (dry run)" className="rounded border border-dashed border-zinc-400 px-1.5 text-[11px] leading-5 text-zinc-500">
          {label}?
        </span>
      ))}
    </span>
  );
}
