import { Command } from "cmdk";
import { useState } from "react";
import type { ActionGroup, AppAction } from "../actions";
import type { LabelSummary, SendAsAliasDetail, SendAsAliasSummary, ThreadSummary } from "../../shared/api";
import { noAutofill } from "../noAutofill";
import { Keycap } from "./Keycap";

/**
 * actions: every registered action. labels: apply/remove labels on the target threads.
 * aliases: the open reply's sender. labelJump: show a label's conversations. labelManage: create,
 * rename and delete labels. accountAliases: the account's Send As aliases.
 */
export type PalettePage = "actions" | "labels" | "aliases" | "labelJump" | "labelManage" | "accountAliases";

const GROUP_ORDER: ReadonlyArray<ActionGroup> = ["Thread", "Selection", "Labels", "AI", "Navigation", "Filter & Views", "Account", "Settings", "Help"];

const PLACEHOLDERS: Record<PalettePage, string> = {
  actions: "Type a command…",
  labels: "Apply or remove a label…",
  aliases: "Send this reply as…",
  labelJump: "Jump to label…",
  labelManage: "Type a new label name, or find one to rename or delete…",
  accountAliases: "Send As aliases…",
};

/** Gmail's system labels worth jumping to (the rest are covered by built-in views or are internal). */
const JUMPABLE_SYSTEM_LABELS = new Set(["IMPORTANT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]);

/** Cmd+K: every registered action, plus pages for labels and aliases. */
export function CommandPalette({
  open, page, actions, labels, targets, aliases, currentAlias, accountAliases,
  onOpenChange, onPageChange, onToggleLabel, onChooseAlias, onJumpToLabel, onCreateLabel, onRenameLabel, onDeleteLabel,
  onComposeFromAlias, onRefreshAliases,
}: {
  readonly open: boolean;
  readonly page: PalettePage;
  readonly actions: ReadonlyArray<AppAction>;
  readonly labels: ReadonlyArray<LabelSummary>;
  /** The threads the label page applies to (the checked threads, or the selected one). */
  readonly targets: ReadonlyArray<ThreadSummary>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPageChange: (page: PalettePage) => void;
  readonly onToggleLabel: (label: string, applied: boolean) => void;
  /** Sender aliases for the open reply ("Change Sender Alias"). */
  readonly aliases: ReadonlyArray<SendAsAliasSummary>;
  readonly currentAlias: string | null;
  readonly onChooseAlias: (sendAsEmail: string) => void;
  readonly onJumpToLabel: (label: string) => void;
  readonly onCreateLabel: (name: string) => void;
  readonly onRenameLabel: (label: LabelSummary) => void;
  readonly onDeleteLabel: (label: LabelSummary) => void;
  /** Every Send As alias of the account (null while loading). */
  readonly accountAliases: ReadonlyArray<SendAsAliasDetail> | null;
  readonly onComposeFromAlias: (sendAsEmail: string) => void;
  readonly onRefreshAliases: () => void;
}) {
  const [search, setSearch] = useState("");
  const close = () => {
    onOpenChange(false);
    setSearch("");
  };
  const userLabels = labels.filter((label) => label.type === "user");
  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && !labels.some((label) => label.name.toLowerCase() === trimmed.toLowerCase());
  const targetHeading = targets.length === 1 ? targets[0]!.subject : `${targets.length} conversations`;

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
      <Command.Input {...noAutofill} value={search} onValueChange={setSearch} placeholder={PLACEHOLDERS[page]} />
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
        {page === "labels" && targets.length > 0 && (
          <Command.Group heading={`Labels · ${targetHeading}`}>
            {userLabels.map((label) => {
              // With several threads, a label counts as applied only when every one has it.
              const applied = targets.every((target) => target.labels.includes(label.name));
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
        {page === "aliases" && (
          <Command.Group heading="Send reply as">
            {aliases.map((alias) => (
              <Command.Item key={alias.sendAsEmail} value={`${alias.displayName} ${alias.sendAsEmail}`} onSelect={() => { close(); onChooseAlias(alias.sendAsEmail); }}>
                <span>{alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}</span>
                <span className="text-xs text-zinc-500">{alias.sendAsEmail === currentAlias ? "✓ Current" : alias.isDefault ? "Default" : ""}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {page === "labelJump" && (
          <Command.Group heading="Show conversations with label">
            {labels.filter((label) => label.type === "user" || JUMPABLE_SYSTEM_LABELS.has(label.name)).map((label) => (
              <Command.Item key={label.id} value={label.name} onSelect={() => { close(); onJumpToLabel(label.name); }}>
                <span>{label.name}</span>
                <span className="text-xs text-zinc-500">{label.type === "system" ? "Gmail" : ""}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {page === "labelManage" && (
          <Command.Group heading="Labels">
            {canCreate && (
              <Command.Item value={`create ${trimmed}`} onSelect={() => { close(); onCreateLabel(trimmed); }}>
                <span>Create label “{trimmed}”</span>
                <span className="text-xs text-zinc-500">New</span>
              </Command.Item>
            )}
            {userLabels.flatMap((label) => [
              <Command.Item key={`rename-${label.id}`} value={`rename ${label.name}`} onSelect={() => { close(); onRenameLabel(label); }}>
                <span>Rename “{label.name}”…</span>
              </Command.Item>,
              <Command.Item key={`delete-${label.id}`} value={`delete ${label.name}`} onSelect={() => { close(); onDeleteLabel(label); }}>
                <span>Delete “{label.name}”…</span>
              </Command.Item>,
            ])}
          </Command.Group>
        )}
        {page === "accountAliases" && (
          <Command.Group heading="Send As aliases · choose one to write from it">
            {accountAliases === null && <Command.Loading>Loading aliases…</Command.Loading>}
            {accountAliases?.map((alias) => (
              <Command.Item
                key={alias.sendAsEmail}
                value={`${alias.displayName} ${alias.sendAsEmail}`}
                disabled={!alias.sendable}
                onSelect={() => { close(); onComposeFromAlias(alias.sendAsEmail); }}
              >
                <span>{alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}</span>
                <span className="text-xs text-zinc-500">
                  {[
                    alias.isPrimary ? "Primary" : null,
                    alias.isDefault ? "Default" : null,
                    alias.sendable ? null : `Not verified (${alias.verificationStatus})`,
                    alias.replyToAddress ? `Reply-To ${alias.replyToAddress}` : null,
                  ].filter(Boolean).join(" · ")}
                </span>
              </Command.Item>
            ))}
            <Command.Item value="refresh aliases from gmail" onSelect={() => { close(); onRefreshAliases(); }}>
              <span>Refresh aliases from Gmail</span>
              <span className="text-xs text-zinc-500">Aliases are added and verified in Gmail's settings</span>
            </Command.Item>
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
