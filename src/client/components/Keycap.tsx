import { shortcutLabel, type Shortcut } from "../actions";

export function Keycap({ shortcut, label }: { readonly shortcut?: Shortcut; readonly label?: string }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-zinc-300 bg-zinc-50 px-1 font-mono text-[10px] leading-4 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      {label ?? (shortcut ? shortcutLabel(shortcut) : "")}
    </kbd>
  );
}
