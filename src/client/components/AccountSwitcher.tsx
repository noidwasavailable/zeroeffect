import type { AppAction } from "../actions";
import type { AccountSummary } from "../../shared/api";
import { Keycap } from "./Keycap";

// Full class names so Tailwind can see them; colorTheme comes from the account registry.
const THEMES: Record<string, { readonly active: string; readonly dot: string }> = {
  blue: { active: "bg-blue-600 text-white", dot: "bg-blue-500" },
  violet: { active: "bg-violet-600 text-white", dot: "bg-violet-500" },
  emerald: { active: "bg-emerald-600 text-white", dot: "bg-emerald-500" },
};
const FALLBACK_THEME = { active: "bg-zinc-700 text-white", dot: "bg-zinc-500" };

export const accountTheme = (colorTheme: string) => THEMES[colorTheme] ?? FALLBACK_THEME;

/** Personal / Work pill. Each pill runs that account's switch action (also on Alt+1 / Alt+2 and in Cmd+K). */
export function AccountSwitcher({ accounts, activeAccountId, actions }: {
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly activeAccountId: string;
  readonly actions: ReadonlyArray<AppAction>;
}) {
  return (
    <nav aria-label="Accounts" className="flex items-center gap-1 rounded-full border border-zinc-200 p-0.5 dark:border-zinc-800">
      {accounts.map((account) => {
        const action = actions.find((candidate) => candidate.id === `account.switch.${account.id}`);
        const theme = accountTheme(account.colorTheme);
        const active = account.id === activeAccountId;
        return (
          <button
            key={account.id}
            type="button"
            title={account.email}
            aria-current={active ? "page" : undefined}
            onClick={action?.run}
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm ${active ? theme.active : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
          >
            {!active && <span className={`size-2 rounded-full ${theme.dot}`} />}
            {account.displayName}
            {action && !active && <Keycap shortcut={action.shortcut} />}
          </button>
        );
      })}
      {accounts.length < 2 && (
        <a href="/setup" className="px-3 py-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          + Connect account
        </a>
      )}
    </nav>
  );
}
