import { useEffect, useRef } from "react";
import { isTypingTarget, matchesShortcut, type AppAction } from "../actions";

/** Binds each action's single-key shortcut while focus is outside text inputs. */
export const useVimShortcuts = (actions: ReadonlyArray<AppAction>, active: boolean): void => {
  // Read the latest actions from a ref so the listener is attached once.
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Holding j/k scrolls through threads; other keys fire once per press.
      if (event.defaultPrevented || (event.repeat && event.key !== "j" && event.key !== "k")) return;
      if (isTypingTarget(event.target)) return;
      const action = latest.current.find((candidate) => candidate.shortcut && matchesShortcut(event, candidate.shortcut));
      if (!action) return;
      event.preventDefault();
      if (action.enabled) action.run();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [active]);
};
