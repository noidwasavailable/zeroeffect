import type { AppAction } from "../actions";
import type { ViewSummary } from "../../shared/api";
import { Keycap } from "./Keycap";

/** Built-in and saved views; each entry runs its "Go to view" action (digit key / Cmd+K). */
export function ViewSidebar({ views, activeViewId, actions }: {
  readonly views: ReadonlyArray<ViewSummary>;
  readonly activeViewId: string;
  readonly actions: ReadonlyArray<AppAction>;
}) {
  return (
    <nav aria-label="Views" className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-zinc-200 p-2 dark:border-zinc-800">
      {views.map((view) => {
        const action = actions.find((candidate) => candidate.id === `views.${view.id}`);
        const active = view.id === activeViewId;
        return (
          <button
            key={view.id}
            type="button"
            title={view.dsl}
            aria-current={active ? "page" : undefined}
            onClick={action?.run}
            className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-zinc-100 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}
          >
            <span className="truncate">{view.name}</span>
            {action && <Keycap shortcut={action.shortcut} />}
          </button>
        );
      })}
    </nav>
  );
}
