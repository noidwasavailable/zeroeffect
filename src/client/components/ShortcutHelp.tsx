import type { ActionGroup, AppAction } from "../actions";
import { Keycap } from "./Keycap";

const GROUPS: ReadonlyArray<ActionGroup> = ["Navigation", "Thread", "Selection", "Labels", "AI", "Filter & Views", "Account", "Settings", "Help"];

/** Cheat sheet of every single-key shortcut, grouped like the command palette. */
export function ShortcutHelp({ actions, onClose }: { readonly actions: ReadonlyArray<AppAction>; readonly onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 p-4 pt-[8vh]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={(element) => element?.focus()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "?") {
            event.preventDefault();
            onClose();
          }
        }}
        className="max-h-[80vh] w-[min(52rem,100%)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-950"
      >
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <span className="text-xs text-zinc-500">Everything is also in the command palette (⌘K). Esc closes.</span>
        </header>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {GROUPS.map((group) => {
            const entries = actions.filter((action) => action.group === group && action.shortcut);
            if (entries.length === 0) return null;
            return (
              <div key={group}>
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{group}</h3>
                <ul className="flex flex-col gap-0.5">
                  {entries.map((action) => (
                    <li key={action.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate">{action.label}</span>
                      <Keycap shortcut={action.shortcut!} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
