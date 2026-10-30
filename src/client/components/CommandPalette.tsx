import { Command } from "cmdk";
import { useState } from "react";
import type { ActionGroup, AppAction } from "../actions";
import type { LabelSummary, ThreadSummary } from "../../shared/api";
import { Keycap } from "./Keycap";

export type PalettePage = "actions" | "labels";

const GROUP_ORDER: ReadonlyArray<ActionGroup> = ["Thread", "Navigation", "Filter & Views", "Account"];

/** Cmd+K: every registered action, plus a label picker page for the selected thread. */
export function CommandPalette({ open, page, actions, labels, thread, onOpenChange, onPageChange, onToggleLabel }: {
  readonly open: boolean;
  readonly page: PalettePage;
  readonly actions: ReadonlyArray<AppAction>;
  readonly labels: ReadonlyArray<LabelSummary>;
  readonly thread: ThreadSummary | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPageChange: (page: PalettePage) => void;
  readonly onToggleLabel: (label: string, applied: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const close = () => {
    onOpenChange(false);
    setSearch("");
  };
  const userLabels = labels.filter((label) => label.type === "user");
  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && !labels.some((label) => label.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 bg-black/30"
      contentClassName="fixed left-1/2 top-[15vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      onKeyDown={(event) => {
        // Backspace on an empty search returns from a sub-page.
        if (page !== "actions" && event.key === "Backspace" && search === "") {
          event.preventDefault();
          onPageChange("actions");
        }
      }}
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={page === "labels" ? "Apply or remove a label…" : "Type a command…"}
      />
      <Command.List>
        <Command.Empty>No matching commands.</Command.Empty>
        {page === "actions" && GROUP_ORDER.map((group) => {
          const groupActions = actions.filter((action) => action.group === group);
          if (groupActions.length === 0) return null;
          return (
            <Command.Group key={group} heading={group}>
              {groupActions.map((action) => (
                <Command.Item
                  key={action.id}
                  value={`${action.label} ${action.id}`}
                  disabled={!action.enabled}
                  onSelect={() => {
                    if (!action.opensPalettePage) close();
                    else setSearch("");
                    action.run();
                  }}
                >
                  <span>{action.label}</span>
                  {action.shortcut && <Keycap shortcut={action.shortcut} />}
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}
        {page === "labels" && thread && (
          <Command.Group heading={`Labels · ${thread.subject}`}>
            {userLabels.map((label) => {
              const applied = thread.labels.includes(label.name);
              return (
                <Command.Item key={label.id} value={label.name} onSelect={() => { close(); onToggleLabel(label.name, applied); }}>
                  <span>{label.name}</span>
                  <span className="text-xs text-zinc-500">{applied ? "✓ Applied · remove" : "Apply"}</span>
                </Command.Item>
              );
            })}
            {canCreate && (
              <Command.Item value={`create ${trimmed}`} onSelect={() => { close(); onToggleLabel(trimmed, false); }}>
                <span>Create label “{trimmed}”</span>
                <span className="text-xs text-zinc-500">New</span>
              </Command.Item>
            )}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
