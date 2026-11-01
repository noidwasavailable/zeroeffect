import type { PubSubState, ServerProblem, ServerProblemSource, ServerStatus } from "../shared/api";

// In-memory record of background work the web client should surface: the Pub/Sub listener's state
// and failures of syncs, watches, notifications and AI runs that otherwise only reach the log.
// It resets with the process, like the work it describes.

/** Reports a background failure (`error`) or that the same work succeeded again (`null`). */
export type ProblemReporter = (source: ServerProblemSource, accountId: string | null, error: unknown | null) => void;

export interface ServerStatusStore {
  readonly snapshot: () => ServerStatus;
  readonly setPubSub: (state: PubSubState, detail?: string | null) => void;
  readonly report: ProblemReporter;
  /** Forgets resolved problems (ongoing ones stay until their work succeeds). */
  readonly dismissResolved: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const MAX_PROBLEMS = 50;
const MAX_MESSAGE_LENGTH = 2_000;

/** A readable one-line message for any thrown value (tagged errors, Errors, strings). */
export const describeError = (error: unknown): string => {
  const message = typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : String(error);
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
};

export const createServerStatusStore = (now: () => number = Date.now): ServerStatusStore => {
  let pubSub: ServerStatus["pubSub"] = { state: "disabled", detail: null, since: now() };
  const problems = new Map<string, ServerProblem>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const prune = () => {
    if (problems.size <= MAX_PROBLEMS) return;
    // Drop the oldest resolved problems first, then the oldest ongoing ones.
    const ordered = [...problems.values()].sort((a, b) =>
      Number(a.resolvedAt === null) - Number(b.resolvedAt === null) || a.lastAt - b.lastAt);
    for (const problem of ordered.slice(0, problems.size - MAX_PROBLEMS)) problems.delete(problem.id);
  };

  return {
    snapshot: () => ({
      pubSub,
      problems: [...problems.values()].sort((a, b) =>
        Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null) || b.lastAt - a.lastAt),
    }),
    setPubSub: (state, detail = null) => {
      if (pubSub.state === state && pubSub.detail === detail) return;
      pubSub = { state, detail, since: pubSub.state === state ? pubSub.since : now() };
      changed();
    },
    report: (source, accountId, error) => {
      const id = `${source}:${accountId ?? "server"}`;
      const existing = problems.get(id);
      if (error === null) {
        if (!existing || existing.resolvedAt !== null) return;
        problems.set(id, { ...existing, resolvedAt: now() });
        changed();
        return;
      }
      const message = describeError(error);
      const at = now();
      problems.set(id, existing && existing.resolvedAt === null
        ? { ...existing, message, lastAt: at, count: existing.count + 1 }
        : { id, source, accountId, message, firstAt: at, lastAt: at, count: 1, resolvedAt: null });
      prune();
      changed();
    },
    dismissResolved: () => {
      let removed = false;
      for (const [id, problem] of problems) {
        if (problem.resolvedAt !== null) {
          problems.delete(id);
          removed = true;
        }
      }
      if (removed) changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
