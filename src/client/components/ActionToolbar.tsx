import { TOOLBAR_ACTION_IDS, type AppAction } from "../actions";
import { Keycap } from "./Keycap";

export const toolbarButtonClass =
  "inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-sm text-zinc-700 shadow-xs " +
  "hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** Persistent buttons for the main actions, each labelled with its Vim key. */
export function ActionToolbar({ actions, onOpenPalette }: {
  readonly actions: ReadonlyArray<AppAction>;
  readonly onOpenPalette: () => void;
}) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return (
    <div role="toolbar" aria-label="Thread actions" className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      {TOOLBAR_ACTION_IDS.map((id) => {
        const action = byId.get(id);
        if (!action) return null;
        return (
          <button key={id} type="button" className={toolbarButtonClass} disabled={!action.enabled} onClick={action.run}>
            {action.label}
            {action.shortcut && <Keycap shortcut={action.shortcut} />}
          </button>
        );
      })}
      <button type="button" className={`${toolbarButtonClass} ml-auto`} onClick={onOpenPalette}>
        Command palette
        <Keycap label="⌘K" />
      </button>
    </div>
  );
}
