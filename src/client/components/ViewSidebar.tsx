import type { AppAction } from "../actions";
import type { ViewSummary } from "../../shared/api";
import { Keycap } from "./Keycap";

const VIEW_CONTROLS = [
  { id: "views.moveUp", label: "↑", title: "Move view up" },
  { id: "views.moveDown", label: "↓", title: "Move view down" },
  { id: "views.edit", label: "Edit", title: "Edit view" },
  { id: "views.delete", label: "Delete", title: "Delete view" },
] as const;

/** Built-in and saved views; each entry runs its "Go to view" action (digit key / Cmd+K). */
export function ViewSidebar({ views, activeViewId, actions }: {
  readonly views: ReadonlyArray<ViewSummary>;
  readonly activeViewId: string;
  readonly actions: ReadonlyArray<AppAction>;
}) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const firstSaved = views.findIndex((view) => !view.builtIn);
  return (
    <nav aria-label="Views" className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-zinc-200 p-2 dark:border-zinc-800">
      {views.map((view, index) => {
        const action = byId.get(`views.go.${view.id}`);
        const active = view.id === activeViewId;
        return (
          <div key={view.id} className="flex flex-col">
            {index === firstSaved && <h3 className="px-2 pb-1 pt-3 text-xs font-medium text-zinc-500">Split views</h3>}
            <button
              type="button"
              title={view.dsl}
              aria-current={active ? "page" : undefined}
              onClick={action?.run}
              className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-zinc-100 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}
            >
              <span className="truncate">{view.name}</span>
              {action?.shortcut && <Keycap shortcut={action.shortcut} />}
            </button>
            {active && !view.builtIn && (
              <div className="flex gap-1 px-2 pb-1 pt-0.5">
                {VIEW_CONTROLS.map((control) => {
                  const controlAction = byId.get(control.id);
                  return (
                    <button
                      key={control.id}
                      type="button"
                      title={control.title}
                      disabled={!controlAction?.enabled}
                      onClick={controlAction?.run}
                      className="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    >
                      {control.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
