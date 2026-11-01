import { describe, expect, test } from "bun:test";
import { ensureLocalValkey, VALKEY_CONTAINER, VALKEY_IMAGE } from "../src/server/localValkey";
import type { LocalValkeyDeps } from "../src/server/localValkey";

const fakeDeps = (options: {
  readonly pings: ReadonlyArray<boolean>;
  readonly inspectExitCode?: number;
  readonly startExitCode?: number;
}) => {
  const calls: Array<ReadonlyArray<string>> = [];
  let ping = 0;
  const deps: LocalValkeyDeps = {
    ping: async () => options.pings[Math.min(ping++, options.pings.length - 1)]!,
    docker: async (args) => {
      calls.push(args);
      if (args[0] === "container") return { exitCode: options.inspectExitCode ?? 1, output: "" };
      if (args[0] === "run" || args[0] === "start") return { exitCode: options.startExitCode ?? 0, output: "boom" };
      return { exitCode: 0, output: "" };
    },
    sleep: async () => {},
  };
  return { deps, calls };
};

describe("ensureLocalValkey", () => {
  test("uses a server that already answers without touching Docker", async () => {
    const { deps, calls } = fakeDeps({ pings: [true] });
    const valkey = await ensureLocalValkey("redis://127.0.0.1:6379", deps);
    expect(valkey.started).toBe(false);
    expect(calls).toEqual([]);
  });

  test("creates a loopback-only container with a persistent volume when none exists", async () => {
    const { deps, calls } = fakeDeps({ pings: [false, false, true] });
    const valkey = await ensureLocalValkey("redis://127.0.0.1:6380", deps);
    expect(valkey.started).toBe(true);
    const run = calls.find((args) => args[0] === "run")!;
    expect(run).toContain("127.0.0.1:6380:6379");
    expect(run).toContain(VALKEY_IMAGE);
    expect(run).toContain(`${VALKEY_CONTAINER}:/data`);
    expect(run.slice(-3)).toEqual(["valkey-server", "--appendonly", "yes"]);

    await valkey.stop();
    expect(calls.at(-1)).toEqual(["stop", VALKEY_CONTAINER]);
  });

  test("restarts an existing container instead of creating another", async () => {
    const { deps, calls } = fakeDeps({ pings: [false, true], inspectExitCode: 0 });
    await ensureLocalValkey("redis://localhost:6379", deps);
    expect(calls.map((args) => args[0])).toEqual(["container", "start"]);
  });

  test("never starts containers for remote URLs", async () => {
    const { deps, calls } = fakeDeps({ pings: [false] });
    await expect(ensureLocalValkey("redis://queue.internal:6379", deps)).rejects.toThrow("only loopback URLs");
    expect(calls).toEqual([]);
  });

  test("explains a missing Docker install or a failed start", async () => {
    await expect(ensureLocalValkey("redis://127.0.0.1:6379", fakeDeps({ pings: [false], inspectExitCode: 127 }).deps))
      .rejects.toThrow("Docker was not found");
    await expect(ensureLocalValkey("redis://127.0.0.1:6379", fakeDeps({ pings: [false], startExitCode: 1 }).deps))
      .rejects.toThrow("is Docker running?");
  });

  test("fails clearly when the container never answers", async () => {
    const { deps } = fakeDeps({ pings: [false] });
    await expect(ensureLocalValkey("redis://127.0.0.1:6379", deps)).rejects.toThrow(`docker logs ${VALKEY_CONTAINER}`);
  });
});
