#!/usr/bin/env bun
/**
 * updater-tui — an interactive, pane-based terminal updater.
 *
 * A real TTY gets the OpenTUI app; anything else (pipes, CI, `--json`) takes the
 * non-interactive path so it can never hang waiting for a keypress.
 */
import { parseArgs } from "node:util";
import type { LogLevelName } from "./log";

const { runHeadless } = await import("./headless");
const {
  endLog,
  log,
  logPath,
  setLogFile,
  setLogLevel,
  setLogMode,
  startLog,
} = await import("./log");
const pkg = (await import("../package.json")).default;

const HELP = `
updater-tui — interactive terminal updater

Usage:
  updater-tui [options]

Options:
  -n, --dry-run        Show what would be upgraded without changing anything.
  -y, --yes            Skip the pickers and upgrade everything.
      --json           Print upgradable packages as JSON and exit.
      --source <id>    Only use the given source (repeatable).
      --log <path>     Write the diagnostic log here (default: %TEMP%\\updater-tui).
      --log-level <l>  off | debug | info | warn | error (default: info).
      --no-log         Do not write a log at all.
  -h, --help           Show this help.
  -v, --version        Show the version.

Sources:
  npm                  Globally installed npm packages.
  winget               Windows Package Manager packages.
  store                Microsoft Store apps (Windows 11 StoreCLI).
  windows-update       Pending Windows updates (needs admin to install).
  custom               Scripts defined in the config (shown when configured).

Interactive keys:
  ↑/↓ move   space toggle   a all/none   Enter scan/upgrade   Esc back   q quit

Flow: pick sources, pick packages, watch the results in the output pane.
Pinned packages are shown locked; ignored ones are hidden (see config).
`.trim();

interface Cli {
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  sources: string[];
  log: string | null;
  logLevel: LogLevelName | null;
  noLog: boolean;
  help: boolean;
  version: boolean;
}

const LOG_LEVELS: LogLevelName[] = ["off", "debug", "info", "warn", "error"];

function parseLevel(value: string): LogLevelName {
  const level = value.trim().toLowerCase();
  const match = LOG_LEVELS.find((candidate) => candidate === level);
  if (!match) throw new Error(`Unknown --log-level: ${value} (off|debug|info|warn|error)`);
  return match;
}

function parseCli(): Cli {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", short: "n" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      source: { type: "string", multiple: true },
      log: { type: "string" },
      "log-level": { type: "string" },
      "no-log": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  });

  const { values } = parsed;
  return {
    dryRun: values["dry-run"] ?? false,
    yes: values.yes ?? false,
    json: values.json ?? false,
    sources: values.source ?? [],
    log: values.log ?? null,
    logLevel: values["log-level"] === undefined ? null : parseLevel(values["log-level"]),
    noLog: values["no-log"] ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

/** Applies the log flags and writes `session.start`. */
function configureLog(cli: Cli, interactive: boolean): void {
  if (cli.noLog) setLogLevel("off");
  else if (cli.logLevel) setLogLevel(cli.logLevel);
  if (cli.log) setLogFile(cli.log);
  setLogMode(interactive ? "tui" : cli.json ? "json" : cli.dryRun ? "dry-run" : "headless");
  startLog({ version: pkg.version });
}

/**
 * A crash is the case that normally leaves nothing behind: the TUI cannot print
 * a stack over itself, and the terminal may already be unusable. Record it, then
 * point at the file.
 */
function installCrashHandlers(): void {
  const report = (event: string, value: unknown): void => {
    log(event, { error: value }, "error");
    const file = logPath();
    try {
      const detail = value instanceof Error ? (value.stack ?? value.message) : String(value);
      console.error(`\n${detail}`);
      if (file) console.error(`log: ${file}`);
    } catch {
      // Nothing left to report to.
    }
    process.exit(1);
  };
  process.on("uncaughtException", (err) => report("session.uncaught", err));
  process.on("unhandledRejection", (reason) => report("session.unhandledRejection", reason));
}

/** The interactive app: OpenTUI is imported lazily so headless runs stay light. */
async function runTui(cli: Cli): Promise<number> {
  const [{ createCliRenderer }, { App }] = await Promise.all([
    import("@opentui/core"),
    import("./ui/app"),
  ]);

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    // The app owns Ctrl+C so it can mean "go back" inside the flow.
    exitSignals: ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"],
  });

  try {
    const app = new App(renderer, {
      dryRun: cli.dryRun,
      sourceFilter: cli.sources,
    });
    return await app.run();
  } finally {
    renderer.destroy();
  }
}

async function main(): Promise<number> {
  let cli: Cli;
  try {
    cli = parseCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("Run `updater-tui --help` for usage.");
    return 2;
  }

  if (cli.help) {
    console.log(HELP);
    return 0;
  }
  if (cli.version) {
    console.log(pkg.version);
    return 0;
  }

  const interactive =
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    !cli.json &&
    !cli.yes;

  configureLog(cli, interactive);
  installCrashHandlers();
  const startedAt = performance.now();
  let code = 1;

  try {
    code = interactive
      ? await runTui(cli)
      : await runHeadless({
          dryRun: cli.dryRun,
          yes: cli.yes,
          json: cli.json,
          sourceFilter: cli.sources,
        });
    return code;
  } finally {
    endLog(code, {
      interactive,
      durationMs: Math.round(performance.now() - startedAt),
    });
    // The TUI prints the path in the output pane; a piped run has only stderr.
    if (code !== 0 && !interactive) {
      const file = logPath();
      if (file) console.error(`log: ${file}`);
    }
  }
}

process.exitCode = await main();
