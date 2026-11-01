import type { LabelSummary } from "../../shared/api";
import { isVisibleLabel } from "../../shared/views";

export function LabelChips({ labels, catalog, ghost = [], className = "flex-wrap" }: {
  readonly labels: ReadonlyArray<string>;
  readonly catalog: ReadonlyMap<string, LabelSummary>;
  readonly ghost?: ReadonlyArray<string>;
  readonly className?: string;
}) {
  const visible = labels.filter(isVisibleLabel);
  if (visible.length === 0 && ghost.length === 0) return null;
  return (
    <span className={`flex gap-1 ${className}`}>
      {visible.map((label) => {
        const entry = catalog.get(label);
        return (
          <span
            key={label}
            className="shrink-0 whitespace-nowrap rounded px-1.5 text-[11px] font-medium leading-5 ring-1 ring-black/5 ring-inset dark:ring-white/10"
            style={entry?.colorBg ? { backgroundColor: entry.colorBg, color: entry.colorText ?? undefined } : undefined}
          >
            {label}
          </span>
        );
      })}
      {ghost.map((label) => (
        <span key={`ghost:${label}`} title="Suggested by an AI rule (dry run)" className="shrink-0 whitespace-nowrap rounded border border-dashed border-zinc-400 px-1.5 text-[11px] leading-5 text-zinc-500">
          {label}?
        </span>
      ))}
    </span>
  );
}
