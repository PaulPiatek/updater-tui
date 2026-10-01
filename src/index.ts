#!/usr/bin/env bun
/**
 * updater-tui — an interactive, pane-based terminal updater.
 *
 * A real TTY gets the OpenTUI app; anything else (pipes, CI, `--json`) takes the
 * non-interactive path so it can never hang waiting for a keypress.
 */
import { parseArgs } from "node:util";

const { runHeadless } = await import("./headless");
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
  help: boolean;
  version: boolean;
}

function parseCli(): Cli {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", short: "n" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      source: { type: "string", multiple: true },
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
    help: values.help ?? false,
    version: values.version ?? false,
  };
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

  if (!interactive) {
    return runHeadless({
      dryRun: cli.dryRun,
      yes: cli.yes,
      json: cli.json,
      sourceFilter: cli.sources,
    });
  }

  // Imported lazily so non-interactive runs never load the native TUI.
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

process.exitCode = await main();
