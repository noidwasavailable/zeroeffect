import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerStatus } from "../src/shared/api";

// Runs the ZeroEffect server in the background as a per-user launchd agent. launchd supervises it
// (restart on crash, start at login, start when the repo's volume mounts); this CLI only writes the
// plist and drives launchctl. Run: bun run zeroeffect <install|start|stop|restart|status|logs|uninstall>

export const LABEL = "com.zeroeffect.server";

export interface AgentPaths {
  /** The repository root: the server's working directory (it reads .env and ./data from there). */
  readonly repoDir: string;
  readonly bunPath: string;
  readonly plistPath: string;
  /** Must be on the internal disk: launchd opens these files and cannot create them on external volumes. */
  readonly logDir: string;
  /** Directories of the tools the server spawns (docker for the local Valkey container). */
  readonly toolDirs: ReadonlyArray<string>;
}

export const defaultPaths = (): AgentPaths => {
  const repoDir = resolve(import.meta.dir, "..");
  const docker = Bun.which("docker");
  return {
    repoDir,
    bunPath: process.execPath,
    plistPath: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    // launchd opens the log files itself, and macOS privacy protection stops it from creating files on
    // external volumes (the job then fails with EX_CONFIG before it starts), so logs stay on the
    // internal disk even when the repo is on an external drive. The server itself may use the drive.
    logDir: join(homedir(), "Library", "Logs", "zeroeffect"),
    toolDirs: docker ? [dirname(docker)] : [],
  };
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plistValue = (value: unknown, indent: string): string => {
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === "number") return `${indent}<integer>${value}</integer>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (Array.isArray(value)) {
    return `${indent}<array>\n${value.map((item) => plistValue(item, `${indent}  `)).join("\n")}\n${indent}</array>`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${indent}  <key>${escapeXml(key)}</key>\n${plistValue(item, `${indent}  `)}`);
  return `${indent}<dict>\n${entries.join("\n")}\n${indent}</dict>`;
};

/** The agent definition; see `man launchd.plist`. */
export const agentDefinition = (paths: AgentPaths) => ({
  Label: LABEL,
  ProgramArguments: [paths.bunPath, "run", "src/server/main.ts"],
  // Bun loads .env from the working directory, and data paths (./data/...) are relative to it.
  WorkingDirectory: paths.repoDir,
  EnvironmentVariables: {
    // No hot reload or file watching; the client is bundled once and minified.
    NODE_ENV: "production",
    // launchd starts jobs with a minimal PATH; the server spawns docker.
    PATH: [...new Set([dirname(paths.bunPath), ...paths.toolDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
  },
  RunAtLoad: true,
  // Keep it running while the repo is reachable: an external volume that is not mounted yet (at
  // login) or ejected does not cause a crash loop, and the server starts once it appears.
  KeepAlive: { PathState: { [paths.repoDir]: true } },
  // At most one restart every 30 seconds when it keeps failing (e.g. a broken .env).
  ThrottleInterval: 30,
  // Graceful shutdown (SIGTERM) closes Pub/Sub, the databases and the Valkey container it started.
  ExitTimeOut: 30,
  StandardOutPath: join(paths.logDir, "server.log"),
  StandardErrorPath: join(paths.logDir, "server.error.log"),
});

export const renderPlist = (paths: AgentPaths): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(agentDefinition(paths), "")}
</plist>
`;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything the CLI does to the system, so tests can run it against fakes. */
export interface System {
  readonly run: (command: ReadonlyArray<string>) => Promise<CommandResult>;
  /** Runs a command attached to this terminal (e.g. `tail -F`) and resolves its exit code. */
  readonly runInteractive: (command: ReadonlyArray<string>) => Promise<number>;
  readonly writeFile: (path: string, contents: string) => void;
  readonly removeFile: (path: string) => void;
  readonly exists: (path: string) => boolean;
  readonly makeDirectory: (path: string) => void;
  readonly fetchStatus: (url: string) => Promise<ServerStatus | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly uid: number;
  readonly out: (line: string) => void;
}

export const realSystem = (): System => ({
  run: async (command) => {
    const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout, stderr };
  },
  runInteractive: (command) => Bun.spawn([...command], { stdio: ["inherit", "inherit", "inherit"] }).exited,
  writeFile: (path, contents) => writeFileSync(path, contents),
  removeFile: (path) => rmSync(path, { force: true }),
  exists: existsSync,
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  fetchStatus: async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return response.ok ? ((await response.json()) as { status: ServerStatus }).status : null;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  uid: userInfo().uid,
  out: (line) => console.log(line),
});

export class CliError extends Error {}

const describeFailure = (result: CommandResult) => (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`;

export const createCli = (system: System, paths: AgentPaths, port: number) => {
  const domain = `gui/${system.uid}`;
  const target = `${domain}/${LABEL}`;

  const launchctl = async (...args: string[]) => system.run(["launchctl", ...args]);
  const isLoaded = async () => (await launchctl("print", target)).exitCode === 0;

  /** Unloads the agent and waits until launchd has let go of it (bootout returns before that). */
  const unload = async () => {
    if (!(await isLoaded())) return;
    const result = await launchctl("bootout", target);
    if (result.exitCode !== 0 && (await isLoaded())) throw new CliError(`launchctl bootout failed: ${describeFailure(result)}`);
    for (let attempt = 0; attempt < 50 && (await isLoaded()); attempt += 1) await system.sleep(100);
    if (await isLoaded()) throw new CliError("launchd did not unload the agent within 5 seconds; try again.");
  };

  const load = async () => {
    if (!system.exists(paths.plistPath)) throw new CliError("The agent is not installed. Run: bun run zeroeffect install");
    let result = await launchctl("bootstrap", domain, paths.plistPath);
    // Bootstrapping right after a bootout can fail transiently ("5: Input/output error"); retry once.
    if (result.exitCode !== 0 && !(await isLoaded())) {
      await system.sleep(500);
      result = await launchctl("bootstrap", domain, paths.plistPath);
    }
    if (result.exitCode !== 0 && !(await isLoaded())) throw new CliError(`launchctl bootstrap failed: ${describeFailure(result)}`);
  };

  const printStatus = async () => {
    const printed = await launchctl("print", target);
    if (printed.exitCode !== 0) {
      system.out(system.exists(paths.plistPath) ? "Agent installed but not loaded (stopped). Start it: bun run zeroeffect start" : "Agent not installed. Install it: bun run zeroeffect install");
      return;
    }
    const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(printed.stdout)?.[1]?.trim();
    const state = field("state") ?? "unknown";
    const pid = field("pid");
    const lastExit = field("last exit code");
    system.out(`launchd: ${state}${pid ? ` (pid ${pid})` : ""}${lastExit && lastExit !== "0" && lastExit !== "(never exited)" ? `, last exit: ${lastExit}` : ""}`);
    const status = await system.fetchStatus(`http://127.0.0.1:${port}/api/status`);
    if (!status) {
      system.out(`Server: not answering on http://127.0.0.1:${port}/ yet. Check: bun run zeroeffect logs`);
      return;
    }
    const ongoing = status.problems.filter((problem) => problem.resolvedAt === null);
    system.out(`Server: http://127.0.0.1:${port}/  Pub/Sub: ${status.pubSub.state}${status.pubSub.detail ? ` (${status.pubSub.detail})` : ""}`);
    system.out(ongoing.length === 0 ? "No ongoing background problems." : `${ongoing.length} ongoing problem(s):`);
    for (const problem of ongoing) system.out(`  - ${problem.source}${problem.accountId ? ` [${problem.accountId}]` : ""}: ${problem.message}`);
  };

  return {
    install: async () => {
      system.makeDirectory(paths.logDir);
      system.makeDirectory(dirname(paths.plistPath));
      await unload();
      system.writeFile(paths.plistPath, renderPlist(paths));
      const lint = await system.run(["plutil", "-lint", paths.plistPath]);
      if (lint.exitCode !== 0) throw new CliError(`The generated plist is invalid: ${describeFailure(lint)}`);
      await load();
      system.out(`Installed ${LABEL} (${paths.plistPath}). It starts now, at login, and whenever ${paths.repoDir} is mounted.`);
      system.out(`Logs: ${paths.logDir}. Status: bun run zeroeffect status`);
    },
    start: async () => {
      if (await isLoaded()) {
        await launchctl("kickstart", target);
      } else {
        await load();
      }
      system.out(`Started ${LABEL}.`);
    },
    /** Unloads the agent until the next start (or login): with KeepAlive, killing it would only restart it. */
    stop: async () => {
      await unload();
      system.out(`Stopped ${LABEL}. It starts again at the next login; run "bun run zeroeffect uninstall" to remove it.`);
    },
    restart: async () => {
      if (!(await isLoaded())) {
        await load();
      } else {
        const result = await launchctl("kickstart", "-k", target);
        if (result.exitCode !== 0) throw new CliError(`launchctl kickstart failed: ${describeFailure(result)}`);
      }
      system.out(`Restarted ${LABEL}.`);
    },
    status: printStatus,
    logs: async (follow: boolean) => {
      const files = [join(paths.logDir, "server.log"), join(paths.logDir, "server.error.log")].filter(system.exists);
      if (files.length === 0) {
        system.out(`No logs yet in ${paths.logDir}.`);
        return 0;
      }
      return system.runInteractive(follow ? ["tail", "-n", "100", "-F", ...files] : ["tail", "-n", "100", ...files]);
    },
    uninstall: async () => {
      await unload();
      system.removeFile(paths.plistPath);
      system.out(`Uninstalled ${LABEL}. Logs are kept in ${paths.logDir}.`);
    },
  };
};

const USAGE = `Usage: bun run zeroeffect <command>

  install     Install and start the background server (launchd agent; also starts at login)
  start       Start it
  stop        Stop it until the next start or login
  restart     Restart it (after pulling server changes)
  status      launchd state, Pub/Sub state and ongoing background problems
  logs [-f]   Show (or follow) the server logs
  uninstall   Stop it and remove the agent`;

export const runCli = async (argv: ReadonlyArray<string>, system: System, paths: AgentPaths, port: number): Promise<number> => {
  const cli = createCli(system, paths, port);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "install": await cli.install(); return 0;
      case "start": await cli.start(); return 0;
      case "stop": await cli.stop(); return 0;
      case "restart": await cli.restart(); return 0;
      case "status": await cli.status(); return 0;
      case "logs": return await cli.logs(rest.includes("-f") || rest.includes("--follow"));
      case "uninstall": await cli.uninstall(); return 0;
      default:
        system.out(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 1;
    }
  } catch (error) {
    if (error instanceof CliError) {
      system.out(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
};

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.error("The background server uses launchd and runs on macOS only.");
    process.exit(1);
  }
  // Bun loads the repo's .env for this script too, so PORT matches the server's.
  process.exitCode = await runCli(Bun.argv.slice(2), realSystem(), defaultPaths(), Number(process.env.PORT ?? 3838));
}
