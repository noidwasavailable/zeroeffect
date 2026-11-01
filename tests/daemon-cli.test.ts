import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentDefinition, defaultPaths, LABEL, renderPlist, runCli, type AgentPaths, type System } from "../scripts/zeroeffect";
import type { ServerStatus } from "../src/shared/api";

const PATHS: AgentPaths = {
  repoDir: "/Volumes/EVO990/Developer/zero effect & co",
  bunPath: "/Users/me/.bun/bin/bun",
  plistPath: `/Users/me/Library/LaunchAgents/${LABEL}.plist`,
  logDir: "/Users/me/Library/Logs/zeroeffect",
  toolDirs: ["/opt/homebrew/bin"],
};
const TARGET = `gui/501/${LABEL}`;

/**
 * A fake launchd: bootout takes a few polls to finish (as the real one does asynchronously), and the
 * first bootstrap right after a bootout fails with "5: Input/output error".
 */
const fakeSystem = (options: { loaded?: boolean; installed?: boolean; status?: ServerStatus | null } = {}) => {
  let loaded = options.loaded ?? false;
  let unloadingPolls = 0;
  let failNextBootstrap = false;
  const files = new Map<string, string>(options.installed ? [[PATHS.plistPath, "<plist/>"]] : []);
  const commands: string[] = [];
  const output: string[] = [];
  const system: System = {
    uid: 501,
    run: async (command) => {
      commands.push(command.join(" "));
      const [tool, verb] = command;
      if (tool === "plutil") return { exitCode: 0, stdout: "OK", stderr: "" };
      if (verb === "print") {
        if (unloadingPolls > 0 && --unloadingPolls === 0) loaded = false;
        return loaded
          ? { exitCode: 0, stdout: "\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n", stderr: "" }
          : { exitCode: 113, stdout: "", stderr: `Could not find service "${LABEL}"` };
      }
      if (verb === "bootout") {
        unloadingPolls = 3;
        failNextBootstrap = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (verb === "bootstrap") {
        if (failNextBootstrap) {
          failNextBootstrap = false;
          return { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        }
        loaded = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    runInteractive: async (command) => {
      commands.push(command.join(" "));
      return 0;
    },
    writeFile: (path, contents) => { files.set(path, contents); },
    removeFile: (path) => { files.delete(path); },
    exists: (path) => files.has(path),
    makeDirectory: () => {},
    fetchStatus: async () => options.status ?? null,
    sleep: async () => {},
    out: (line) => { output.push(line); },
  };
  return { system, commands, output, files, get loaded() { return loaded; } };
};

const cli = (fake: ReturnType<typeof fakeSystem>, ...argv: string[]) => runCli(argv, fake.system, PATHS, 3838);

describe("background server agent definition", () => {
  test("runs the server from the repo with a full PATH, in production, kept alive while the repo is mounted", () => {
    const definition = agentDefinition(PATHS);
    expect(definition.ProgramArguments).toEqual(["/Users/me/.bun/bin/bun", "run", "src/server/main.ts"]);
    expect(definition.WorkingDirectory).toBe(PATHS.repoDir);
    expect(definition.EnvironmentVariables.NODE_ENV).toBe("production");
    expect(definition.EnvironmentVariables.PATH).toBe("/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(definition.KeepAlive).toEqual({ PathState: { [PATHS.repoDir]: true } });
    expect(definition).toMatchObject({ RunAtLoad: true, ThrottleInterval: 30, ExitTimeOut: 30 });
    expect(definition.StandardErrorPath).toBe(`${PATHS.logDir}/server.error.log`);
  });

  test("keeps launchd's log files on the internal disk even when the repo is on an external volume", () => {
    const paths = defaultPaths();
    expect(paths.logDir.startsWith("/Volumes/")).toBe(false);
    expect(paths.logDir).toBe(join(homedir(), "Library", "Logs", "zeroeffect"));
  });

  test("renders a plist that escapes paths and passes plutil", async () => {
    const xml = renderPlist(PATHS);
    expect(xml).toContain("<string>/Volumes/EVO990/Developer/zero effect &amp; co</string>");
    expect(xml).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`);
    if (process.platform !== "darwin") return;
    const directory = mkdtempSync(join(tmpdir(), "zeroeffect-plist-"));
    try {
      const path = join(directory, "agent.plist");
      writeFileSync(path, xml);
      const lint = Bun.spawnSync(["plutil", "-lint", path]);
      expect(lint.exitCode).toBe(0);
      const json = JSON.parse(Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path]).stdout.toString());
      expect(json).toEqual(JSON.parse(JSON.stringify(agentDefinition(PATHS))));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("zeroeffect CLI", () => {
  test("install writes and lints the plist, then bootstraps the agent", async () => {
    const fake = fakeSystem();
    expect(await cli(fake, "install")).toBe(0);
    expect(fake.files.get(PATHS.plistPath)).toBe(renderPlist(PATHS));
    expect(fake.commands).toEqual([
      `launchctl print ${TARGET}`,
      `plutil -lint ${PATHS.plistPath}`,
      `launchctl bootstrap gui/501 ${PATHS.plistPath}`,
    ]);
    expect(fake.loaded).toBe(true);
  });

  test("reinstalling waits for the old agent to unload and retries the transient bootstrap failure", async () => {
    const fake = fakeSystem({ loaded: true, installed: true });
    expect(await cli(fake, "install")).toBe(0);
    expect(fake.commands.filter((command) => command.includes("bootstrap"))).toHaveLength(2);
    expect(fake.commands.indexOf(`launchctl bootout ${TARGET}`)).toBe(1);
    expect(fake.loaded).toBe(true);
  });

  test("stop unloads (KeepAlive would restart a killed server); start and restart use kickstart", async () => {
    const fake = fakeSystem({ loaded: true, installed: true });
    await cli(fake, "stop");
    expect(fake.loaded).toBe(false);
    expect(fake.files.has(PATHS.plistPath)).toBe(true);

    fake.commands.length = 0;
    await cli(fake, "start");
    expect(fake.commands).toContain(`launchctl bootstrap gui/501 ${PATHS.plistPath}`);
    fake.commands.length = 0;
    await cli(fake, "restart");
    expect(fake.commands).toEqual([`launchctl print ${TARGET}`, `launchctl kickstart -k ${TARGET}`]);
  });

  test("start without an installed agent explains what to run", async () => {
    const fake = fakeSystem();
    expect(await cli(fake, "start")).toBe(1);
    expect(fake.output).toEqual(["Error: The agent is not installed. Run: bun run zeroeffect install"]);
  });

  test("status combines launchd's state with the server's Pub/Sub state and ongoing problems", async () => {
    const status: ServerStatus = {
      pubSub: { state: "needs_reauthorization", detail: "invalid_grant", since: 1 },
      problems: [
        { id: "catch_up:work", source: "catch_up", accountId: "work", message: "token expired", firstAt: 1, lastAt: 2, count: 2, resolvedAt: null },
        { id: "ai:personal", source: "ai", accountId: "personal", message: "old", firstAt: 1, lastAt: 1, count: 1, resolvedAt: 2 },
      ],
    };
    const fake = fakeSystem({ loaded: true, installed: true, status });
    await cli(fake, "status");
    expect(fake.output).toEqual([
      "launchd: running (pid 4242)",
      "Server: http://127.0.0.1:3838/  Pub/Sub: needs_reauthorization (invalid_grant)",
      "1 ongoing problem(s):",
      "  - catch_up [work]: token expired",
    ]);

    const stopped = fakeSystem({ installed: true });
    await cli(stopped, "status");
    expect(stopped.output[0]).toContain("installed but not loaded");
  });

  test("logs tails the log files; uninstall unloads and removes the plist", async () => {
    const fake = fakeSystem({ loaded: true, installed: true });
    fake.files.set(`${PATHS.logDir}/server.log`, "");
    await cli(fake, "logs", "-f");
    expect(fake.commands.at(-1)).toBe(`tail -n 100 -F ${PATHS.logDir}/server.log`);
    await cli(fake, "uninstall");
    expect(fake.loaded).toBe(false);
    expect(fake.files.has(PATHS.plistPath)).toBe(false);
    expect(await cli(fakeSystem(), "bogus")).toBe(1);
  });
});
