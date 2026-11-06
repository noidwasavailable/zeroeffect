import type { AppAction } from "../actions";
import type { ViewSummary } from "../../shared/api";
import { Keycap } from "./Keycap";

const VIEW_CONTROLS = [
  { id: "views.moveUp", label: "↑", title: "Move view up" },
  { id: "views.moveDown", label: "↓", title: "Move view down" },
  { id: "views.edit", label: "Edit", title: "Edit view" },
  { id: "views.delete", label: "Delete", title: "Delete view" },
] as const;

/** Label and alias management and settings, at the bottom of the sidebar. */
const FOOTER_ACTIONS = [
  { id: "labels.jump", label: "Jump to label…" },
  { id: "labels.manage", label: "Manage labels…" },
  { id: "account.aliases", label: "Send As aliases…" },
] as const;

/** Settings shown as switches below the footer actions. */
const SETTING_ACTIONS = [
  { id: "settings.markReadOnArchive", label: "Mark read on archive / trash" },
] as const;

/** Built-in and saved views; each entry runs its "Go to view" action (digit key / Cmd+K). */
export function ViewSidebar({ views, activeViewId, actions, settings }: {
  readonly views: ReadonlyArray<ViewSummary>;
  readonly activeViewId: string;
  readonly actions: ReadonlyArray<AppAction>;
  /** Each setting switch's current state, by action id. */
  readonly settings: Readonly<Record<(typeof SETTING_ACTIONS)[number]["id"], boolean>>;
}) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const firstSaved = views.findIndex((view) => !view.builtIn);
  const firstSecondary = views.findIndex((view) => view.secondary);
  return (
    <nav aria-label="Views" className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-zinc-200 p-2 dark:border-zinc-800">
      {views.map((view, index) => {
        const action = byId.get(`views.go.${view.id}`);
        const active = view.id === activeViewId;
        return (
          <div key={view.id} className="flex flex-col">
            {index === firstSaved && <h3 className="px-2 pb-1 pt-3 text-xs font-medium text-zinc-500">Split views</h3>}
            {index === firstSecondary && <hr className="mx-2 my-2 border-zinc-200 dark:border-zinc-800" />}
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
      <div className="mt-auto flex flex-col gap-0.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">
        {FOOTER_ACTIONS.map(({ id, label }) => {
          const action = byId.get(id);
          if (!action) return null;
          return (
            <button
              key={id}
              type="button"
              title={action.label}
              onClick={action.run}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
            >
              {label}
              {action.shortcut && <Keycap shortcut={action.shortcut} />}
            </button>
          );
        })}
        {SETTING_ACTIONS.map(({ id, label }) => {
          const action = byId.get(id);
          if (!action) return null;
          return (
            <button
              key={id}
              type="button"
              role="switch"
              aria-checked={settings[id]}
              title={action.label}
              onClick={action.run}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
            >
              {label}
              <span className={`rounded px-1 text-[10px] font-medium ${settings[id] ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"}`}>
                {settings[id] ? "On" : "Off"}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
