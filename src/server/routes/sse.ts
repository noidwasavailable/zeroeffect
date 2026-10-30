import type { AccountEvent } from "../../shared/api";

export interface AccountEventBus {
  readonly publish: (accountId: string, event: AccountEvent) => void;
  readonly subscribe: (accountId: string, listener: (event: AccountEvent) => void) => () => void;
}

/** In-process fan-out of account-scoped events to connected web clients. */
export const createAccountEventBus = (): AccountEventBus => {
  const listeners = new Map<string, Set<(event: AccountEvent) => void>>();
  return {
    publish: (accountId, event) => {
      for (const listener of listeners.get(accountId) ?? []) listener(event);
    },
    subscribe: (accountId, listener) => {
      const accountListeners = listeners.get(accountId) ?? new Set();
      accountListeners.add(listener);
      listeners.set(accountId, accountListeners);
      return () => {
        accountListeners.delete(listener);
        if (accountListeners.size === 0) listeners.delete(accountId);
      };
    },
  };
};

const KEEPALIVE_INTERVAL_MS = 25_000;

/** Streams one account's events as Server-Sent Events until the client disconnects. */
export const accountEventStream = (bus: AccountEventBus, accountId: string, signal: AbortSignal): Response => {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = bus.subscribe(accountId, (event) => send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      // Comments keep the connection inside Bun's idle timeout (and through proxies) between events.
      const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_INTERVAL_MS);
      cleanup = () => {
        clearInterval(keepalive);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      };
      signal.addEventListener("abort", onAbort);
      send(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
};
