# updater-tui

An interactive **full-screen terminal updater**. It upgrades **globally installed
npm packages**, **Windows Package Manager (winget)** packages, **Microsoft Store
apps**, **Windows Update** software updates, and runs your own **custom update
scripts** — all from one pane-based UI, built with
[OpenTUI](https://opentui.com) (the library `opencode` uses).

## The UI

```
╭─ Sources ─────────────╮ ╭─ Output ─────────────────────────────────╮
│› [x] Global npm packages│ │· Select sources, then Enter to scan.     │
│  [x] winget            │ │· Checking Global npm packages…           │
│  [x] Store apps        │ │✔ winget: 3 update(s)                     │
│  [x] Windows Update    │ │✔ store: 1 update(s)                      │
│  [x] Custom scripts    │ │· Choose packages, then Enter to upgrade. │
╰────────────────────────╯ ╰──────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────╮
│ Done: 5 upgraded, 0 failed.             ↑/↓ move · space toggle …    │
╰──────────────────────────────────────────────────────────────────────╯
```

- **Left pane** — two stages: pick **sources**, then pick **packages**
  (grouped by source, each row showing `current → latest`).
- **Right pane** — live output: scan progress, per-item results, script framing.
- **Bottom** — summary and key hints.

The two panes split the window evenly. They're sized with `flexGrow` weights
rather than a `%` width — a percentage on a nested box resolved against the wrong
basis and left the pane a fixed size while the terminal grew. See `AGENTS.md`.

| Key       | Action                                   |
| --------- | ---------------------------------------- |
| `↑` / `↓` | move (`k` / `j` also work)               |
| `space`   | toggle the highlighted row               |
| `a`       | select all / none                        |
| `enter`   | scan (stage 1) / upgrade (stage 2)       |
| `esc`     | back to sources / quit                   |
| `q`       | quit                                     |

Pinned and unavailable items are shown **locked** (greyed, `[-]`) and can't be
selected. Ignored items never appear.

## Requirements

- [Bun](https://bun.sh) 1.4+ to run from source.
- The tools for whichever sources you use: `npm`, `winget`, PowerShell, and
  the Windows 11 Store CLI (`store`, shipped with the Microsoft Store app).
- The standalone `.exe` needs none of these to *run* — only the tools used by the
  sources themselves.

## Usage

```sh
bun run start                 # the TUI
bun run start --dry-run       # walk the flow, change nothing
bun run start --source npm    # restrict to one source (repeatable)
```

Non-interactive flags (no TTY, or when you ask for them) skip the TUI:

```sh
bun run start --json          # machine-readable list, no TUI
bun run start --yes           # upgrade everything without picking
bun run start --dry-run --yes # show the commands, run none
bun run start --help
```

`--json` and `--yes` never open the TUI, so they are safe to script. With no TTY
and neither flag, the app prints a clear message and exits `2` instead of hanging.

### Flags

| Flag            | Alias | Meaning                                                |
| --------------- | ----- | ------------------------------------------------------ |
| `--dry-run`     | `-n`  | List and select as usual, but print commands, run none |
| `--yes`         | `-y`  | Skip the pickers and upgrade everything                |
| `--json`        |       | Print the upgradable items as JSON and exit (no TUI)   |
| `--source <id>` |       | Only use this source (repeatable)                      |
| `--help`        | `-h`  | Show help                                              |
| `--version`     | `-v`  | Show the version                                       |

### Exit codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| `0`  | success (or nothing to do / nothing picked)  |
| `1`  | one or more upgrades failed, or a scan error |
| `2`  | invalid usage, or no TTY without `--yes`     |
| `130`| cancelled by the user                        |

## Configuration

The config is auto-created on first run — nothing to set up:

| Path                                        | Scope                            |
| ------------------------------------------- | -------------------------------- |
| `%USERPROFILE%\.config\updater\config.json` | user-wide default (auto-created) |
| `./updater.config.json`                     | project folder, overrides user   |

The project file overrides the user file **per key** (`ignore`, `pin`, `scripts`
are replaced wholesale, not merged). Rules are `source:pattern` or bare
`pattern`, case-insensitive, matched against name, full id, and source id.

```json
{
  "ignore": ["npm:@types/*", "winget:Ubisoft.Connect"],
  "pin": ["npm:npm-check-updates", "windows-update:*"]
}
```

- **ignore** — the item disappears entirely.
- **pin** — shown but locked, never selected or upgraded.

### Custom scripts

Add executables to the `scripts` array; each becomes a `Custom scripts` row:

```json
{
  "scripts": [
    { "name": "update-all", "path": "C:\\Users\\me\\scripts\\update-all.cmd" },
    {
      "name": "drivers",
      "path": "C:\\Users\\me\\tools\\drivers\\update.ps1",
      "args": ["-Silent"],
      "cwd": "C:\\Users\\me\\tools\\drivers"
    }
  ]
}
```

| Field         | Required | Meaning                                                          |
| ------------- | -------- | ---------------------------------------------------------------- |
| `path`        | yes      | The executable (absolute, or relative to the config file).       |
| `name`        | no       | Label in the picker. Defaults to the file name.                  |
| `interpreter` | no       | Run `path` with this program, e.g. a real `python.exe` for `.py`. |
| `args`        | no       | Arguments passed verbatim (no shell).                            |
| `cwd`         | no       | Working directory. Defaults to the executable's folder.          |

**Scripts run in an embedded terminal overlay.** When a script runs, the app
opens an overlay and hosts the script on a pty, rendering its output live
inside the app. Your keystrokes go to the script, so prompts work; `Ctrl+Q` or
`Esc` closes the overlay (and stops the script). Because the terminal stays open
for the whole run, a script does **not** need a `pause` at the end — but one is
fine if you want to read the output. If you add one, guard it so a piped or
scripted run cannot block:

```powershell
if ($Host.UI.RawUI -and -not [Console]::IsInputRedirected) {
  Write-Host "Press any key to continue..."
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
```

Use `interpreter` for types Windows can't execute directly (e.g. `.py` with no
file association). A missing executable is shown locked (`· not found`).

See [`examples/`](examples/) for ready-made scripts and how to wire them up:

- [`msys-update.ps1`](examples/msys-update.ps1) — updates an MSYS2 install
  (`pacman -Syu`, looping until done).
- [`pi-extensions-update.ps1`](examples/pi-extensions-update.ps1) — refreshes the
  extensions installed into the `pi` coding agent (`pi update --extensions`).

### Rule syntax

- `npm:@types/*` — every scoped `@types` package
- `winget:Ubisoft.Connect` — one winget package by id
- `npm` / `npm:*` — everything from npm
- `@opencode/cli` — bare pattern, matches on any source

`*` matches any characters (including `/`), `?` matches one character.

## Development

```sh
bun install
bun run start
bun test
bun run typecheck
```

| Target        | Command                        | Purpose                                                       |
| ------------- | ------------------------------ | ------------------------------------------------------------- |
| `start`       | `bun run src/index.ts`         | Run the TUI from source.                                      |
| `test`        | `bun test`                     | Unit + frame tests.                                           |
| `typecheck`   | `tsc --noEmit`                 | Strict type check.                                            |
| `icon`        | `bun run scripts/make-icon.ts` | Regenerate `assets/icon.ico` (drawn in code).                 |
| `build:exe`   | `bun build --compile …`        | Build `dist/updater-tui.exe`.                                 |
| `install:exe` | `bun run scripts/install.ts`   | Copy the exe to `~/.local/bin` (asks; `--yes` skips).         |

Interactive checks that need a real terminal (not part of `bun test`):

```sh
bun run scripts/pty-check.ts       # drives the app over a PTY
bun run scripts/pty-exe-check.ts   # drives the built exe over a PTY
```

**Always run `bun test` and `bun run typecheck` before committing.**

### Standalone executable

```sh
bun run build:exe    # -> dist/updater-tui.exe (~93 MB)
bun run install:exe  # -> %USERPROFILE%\.local\bin\updater-tui.exe (asks; --yes skips)
```

The exe is fully featured: all sources, the TUI, and the elevated Windows Update
batch work exactly as under `bun run start`. It is unsigned, so SmartScreen may
warn on first run ("More info → Run anyway").

> The UI uses OpenTUI's **imperative core API** on purpose. The Solid/React
> bindings work from source but **do not** in a compiled exe (reactivity never
> runs). See `AGENTS.md`.

## Architecture

```
src/
  index.ts          CLI entry: flags, TTY detection, TUI vs headless
  engine.ts         UI-agnostic engine: discover → scan → apply
  headless.ts       --json / --yes / --dry-run (never loads the TUI)
  state.ts          two-stage selection state (pure, unit-tested)
  proc.ts           Bun.spawn helper (restores the Windows console mode)
  console-mode.ts   snapshot/restore of the console input mode
  config.ts         ignore/pin/scripts from user + project config
  types.ts          UpgradeItem / Source / UpgradeResult
  ui/
    app.ts          the TUI: layout, flow, keyboard
    checklist.ts    scrollable multi-select (OpenTUI primitives)
    output.ts       append-only status log pane
    overlay-terminal.ts  embedded terminal overlay for hosted scripts
    theme.ts        colours and text helpers
  sources/
    index.ts        registry (built-ins + config-driven custom)
    npm.ts          global npm packages
    winget.ts       Windows Package Manager packages
    store.ts        Microsoft Store apps (via the StoreCLI)
    windows-update.ts  Windows Update (one elevated batch)
    custom.ts       user-defined executables
scripts/
  make-icon.ts      generates assets/icon.ico
  install.ts        installs the built exe into ~/.local/bin
  pty-check.ts      drives the app over a PTY (manual)
  pty-exe-check.ts  drives the built exe over a PTY (manual)
assets/
  icon.ico          app icon (generated)
tests/              bun:test unit + frame tests
```

Adding a source: implement `Source` in `src/sources/` and register it in
`src/sources/index.ts`. The engine, TUI, `--json`, `--dry-run` and `--yes` all
pick it up automatically. Sources stay self-contained adapters — the app knows
nothing tool-specific.

### Windows Update uses the WUA COM API

`src/sources/windows-update.ts` uses `Microsoft.Update.Session` through
PowerShell, not `UsoClient.exe` or `wuauclt`. Both of those are unsupported:
`UsoClient` is an undocumented internal tool for the Update Orchestrator service
— it prints nothing (so it cannot list updates) and its install verbs return
`87`/`ERROR_INVALID_PARAMETER`. The COM API is the only one that gives what the
picker needs: a list with titles/KBs/sizes, per-update results, and one elevated
batch (one UAC prompt). See `AGENTS.md` for the measurements.

### Microsoft Store uses the StoreCLI (`store.exe`)

Windows 11 ships a supported `store` command inside the Microsoft Store app (an
app-execution alias pointing at `store.exe`). `src/sources/store.ts` uses it
directly: `store updates` lists pending apps, `store update <app> --apply`
installs one. This replaces the old fire-and-forget `rundll32`/scheduled-task
trigger and gives the picker real entries with `current → latest`.

Do not confuse it with
[`microsoft/msstore-cli`](https://github.com/microsoft/msstore-cli)
(`msstore.exe`) — that is the Partner Center **publishing** CLI, a different tool
with no ability to list or update the apps installed on a machine.

The StoreCLI is marked **Preview**, prints an ANSI table on stdout with no
`--json`, and exits `0` even for an unknown parameter — so the source parses the
output rather than trusting the exit code. Its table is Name / Publisher /
Version / Date with **no target-version column**, so rows read
`1.24.11321.0 → update`. `store updates` also prompts to install; under the
captured (no-stdin) run it installs nothing, and the source never passes
`--apply` while listing. See `AGENTS.md`.
