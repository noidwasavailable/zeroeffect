import { shortcutLabel, type Shortcut } from "../actions";

const MODIFIER_NAMES: Readonly<Record<string, string>> = { "⌘": "Cmd", "⇧": "Shift", "⌥": "Option", "⌃": "Control" };

/** Splits a label like "⌘↵" or "⇧S" into one keycap per key: leading modifiers, then the key. */
export const keycapParts = (label: string): ReadonlyArray<string> => {
  const characters = [...label];
  const parts: string[] = [];
  while (characters.length > 1 && characters[0]! in MODIFIER_NAMES) parts.push(characters.shift()!);
  parts.push(characters.join(""));
  return parts;
};

/**
 * Shortcut badge. Each key is its own cap in the system UI font, which has well-drawn ⌘ ⇧ ⌥ glyphs
 * (monospace fonts often fall back to mismatched ones); the title spells the chord out.
 */
export function Keycap({ shortcut, label }: { readonly shortcut?: Shortcut; readonly label?: string }) {
  const parts = keycapParts(label ?? (shortcut ? shortcutLabel(shortcut) : ""));
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={parts.map((part) => MODIFIER_NAMES[part] ?? part).join("+")}>
      {parts.map((part, index) => (
        <kbd
          key={index}
          className={`inline-flex h-[18px] items-center justify-center rounded border border-zinc-300 bg-zinc-50 font-sans text-[11px] font-medium leading-none text-zinc-500 shadow-[inset_0_-1px_0_var(--color-zinc-300)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:shadow-[inset_0_-1px_0_var(--color-zinc-700)] ${part.length > 1 ? "px-1" : "w-[18px]"}`}
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}
