import { useEffect, useRef } from "react";
import type { AccountEvent } from "../../shared/api";
import { api } from "../api";

/** Subscribes to the account's SSE stream. After a dropped connection it reports a catch-up refresh. */
export const useAccountEvents = (accountId: string, onEvent: (event: AccountEvent) => void): void => {
  const latest = useRef(onEvent);
  latest.current = onEvent;

  useEffect(() => {
    const source = new EventSource(api.eventsUrl(accountId));
    let disconnected = false;
    const handle = (event: MessageEvent<string>) => {
      try {
        latest.current(JSON.parse(event.data) as AccountEvent);
      } catch {
        // Ignore malformed events; the next refresh reconciles state.
      }
    };
    source.addEventListener("threads-changed", handle);
    source.addEventListener("sync", handle);
    source.onerror = () => { disconnected = true; };
    source.onopen = () => {
      // Events sent while disconnected are lost, so refresh once the stream is back.
      if (disconnected) latest.current({ type: "threads-changed" });
      disconnected = false;
    };
    return () => source.close();
  }, [accountId]);
};
