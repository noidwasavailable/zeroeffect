import { describeError, type ServerStatusStore } from "./serverStatus";

// Keeps the Gmail Pub/Sub StreamingPull listener running: it reconnects after failures, stops
// retrying when Google rejects the authorization itself (invalid_grant), and reconnects at once
// with new credentials when Pub/Sub is reauthorized from the setup page.

export interface PubSubSupervisorConfig {
  /** Runs one StreamingPull session until the stream ends or fails. */
  readonly listen: () => Promise<void>;
  /** Drops the cached Pub/Sub client and ends open streams (see GooglePubSubTransport.replaceClient). */
  readonly replaceClient: () => Promise<void>;
  readonly status: ServerStatusStore;
  readonly retryMs?: number;
  readonly log?: Pick<Console, "error" | "log">;
}

export interface PubSubSupervisor {
  /** Settles once `stop` was called and the current session ended. */
  readonly task: Promise<void>;
  /** New credentials are in place: reconnect now, even while waiting for reauthorization. */
  readonly reauthorized: () => Promise<void>;
  readonly stop: () => void;
}

/** Google refuses the refresh token itself (revoked, expired, replaced): retrying cannot help. */
export const isRejectedGrant = (error: unknown): boolean => /invalid_grant/i.test(describeError(error));

export const supervisePubSub = (config: PubSubSupervisorConfig): PubSubSupervisor => {
  const retryMs = config.retryMs ?? 5_000;
  const log = config.log ?? console;
  let stopping = false;
  let credentialsReplaced = false;
  // Resolves the loop's current wait (retry delay, or waiting for reauthorization).
  let wake: (() => void) | undefined;
  const pause = (ms: number | null) => new Promise<void>((resolve) => {
    const timer = ms === null ? undefined : setTimeout(() => done(), ms);
    const done = () => {
      clearTimeout(timer);
      if (wake === done) wake = undefined;
      resolve();
    };
    wake = done;
  });

  const task = (async () => {
    let lastLogged = "";
    while (!stopping) {
      credentialsReplaced = false;
      config.status.setPubSub("connecting");
      let failure: unknown = null;
      try {
        await config.listen();
      } catch (error) {
        failure = error;
      }
      if (stopping) break;
      // Reauthorized mid-stream: the old stream was closed on purpose, so reconnect right away.
      if (credentialsReplaced) continue;
      const message = failure === null ? "The StreamingPull stream closed." : describeError(failure);
      if (failure !== null && isRejectedGrant(failure)) {
        log.error("Google rejected the Pub/Sub authorization (invalid_grant). Reconnect Pub/Sub from the setup page; until then new mail arrives through the catch-up sync every 10 minutes.");
        config.status.setPubSub("needs_reauthorization", message);
        config.status.report("pubsub", null, `Google rejected the Pub/Sub authorization (invalid_grant); reconnect Pub/Sub from the setup page. ${message}`);
        lastLogged = "";
        await pause(null);
        continue;
      }
      // Each distinct failure is logged once; repeats are counted in the status panel.
      if (message !== lastLogged) log.error(`Gmail Pub/Sub listener failed; reconnecting every ${retryMs / 1000} seconds.`, failure ?? message);
      lastLogged = message;
      config.status.setPubSub("retrying", message);
      config.status.report("pubsub", null, message);
      await pause(retryMs);
    }
  })();

  return {
    task,
    reauthorized: async () => {
      if (stopping) return;
      log.log("Google Pub/Sub was reauthorized; reconnecting StreamingPull with the new credentials.");
      credentialsReplaced = true;
      config.status.setPubSub("connecting", "Reconnecting with the new authorization.");
      await config.replaceClient();
      wake?.();
    },
    stop: () => {
      stopping = true;
      wake?.();
    },
  };
};
