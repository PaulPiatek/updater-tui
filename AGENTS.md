# AGENTS.md

Instructions for anyone (human or AI agent) working on **updater-tui**.

It provides one interactive flow that upgrades npm globals, winget packages,
Windows Update, Microsoft Store apps, and custom scripts, with the terminal UI
built on **OpenTUI**.

---

## The goal

An **OpenTUI** app (the library `opencode` uses): a full-screen, pane-based
terminal UI.

- **Left pane:** selections — two stages:
  1. pick sources
  2. pick packages
- **Right pane:** live output / status (scan progress, per-item results, custom
  script output).
- **Bottom:** summary and an exit prompt.

OpenTUI was chosen **deliberately**, for panes, focus, scrolling and custom keys.
Do not "simplify" it back to prompts — the richer UI is the point.

---

## The reliable core (keep it working)

These are **UI-agnostic** adapters that the app is built on. Treat them as the
reliable core; the bug fixes in them were hard-won.

| File | Purpose |
| --- | --- |
| `src/types.ts` | `Source`, `UpgradeItem`, `UpgradeOptions`, `UpgradeResult`, `RunMode` |
| `src/sources/npm.ts` | global npm packages (`npm outdated -g --json`) |
| `src/sources/winget.ts` | Windows Package Manager (parses the fixed-width table) |
| `src/sources/windows-update.ts` | Windows Update Agent COM API, one elevated batch |
| `src/sources/store.ts` | Microsoft Store apps (via the StoreCLI) |
| `src/sources/custom.ts` | user-defined executables from config |
| `src/sources/index.ts` | registry (`createSources(config)`) |
| `src/config.ts` | `ignore` / `pin` / `scripts`, user + project files |
| `src/proc.ts` | `Bun.spawn` helper (`run`, `which`) |
| `src/console-mode.ts` | **critical Windows fix** — see below |

The `Source` interface is the contract: the UI must consume `UpgradeItem[]` and
call `source.list()` / `upgrade()` / `upgradeBatch()`. **Do not put UI code in
the sources.**

---

## The rules that still apply

### 1. Stop and ask first

If a request needs significant custom work — hand-rolled rendering, fighting the
library's design, vendored internals — **do not start building it. Stop and ask
the user first**, explain the effort/fragility trade-off, and offer a simpler
option or "skip it".

The user's consistent preference: **keep it simple and idiomatic; accept a small
functional loss over a large pile of custom code.**

A hard-won example: an in-picker "press `p` to pin" feature needed a fully custom
render and was removed. OpenTUI gives us panes and custom keys *natively* — so
use its APIs, don't reimplement them.

### 2. Windows console input mode is shared and fragile  ← **do not lose this**

`src/console-mode.ts` exists because an interactive child (and any prompt UI) can
leave the Windows console in the wrong input mode, after which later prompts — and
custom scripts' own `pause`/`input()` — can't read keys.

- It happens after **elevated (UAC)** children especially, e.g. the Windows
  Update batch.
- Bun's `process.stdin.setRawMode(false)` does **not** restore the real mode
  (it lands on `0x7`, losing flags).
- `console-mode.ts` snapshots the real `GetConsoleMode` value via `bun:ffi` and
  restores it **exactly** with `SetConsoleMode`.
- `proc.run()` wraps every `inherit: true` spawn in `withConsoleModeRestored`.

**Keep this.** Whatever UI you build, route inherited children through
`proc.run()` so the console is restored. Verified: `0x1f7` → `0x1f7` even when a
child leaves it at raw `0x208`.

### 3. Custom scripts run in an embedded terminal overlay

The `custom` source declares `runMode: "stream"`. `App.runUpgrade` hosts each
script in `src/ui/overlay-terminal.ts`: the app raises a bordered overlay, runs
the child on a `Bun.Terminal` (ConPTY), and wires the two directions —

```
child stdout (pty data) → EmbeddedTerminalRenderable.write()
your keys (panel onData) → pty.write()
```

so output streams inside the app and the child's prompts work, without giving up
the whole screen.

- **All keys go to the child**, so interactive scripts (pacman's `[Y/n]`) work.
- **Reserved keys:** `Ctrl+Q` / `Esc` kill the child (while it is running) and
  close the overlay. `Ctrl+C` is *not* reserved — it is forwarded so the script
  receives the interrupt it expects.
- The overlay **auto-closes** when the child exits (after a brief `exited N`).
- **Elevated children cannot be captured or pty-hosted.** `Start-Process -Verb
  RunAs` opens its own console, so Windows Update keeps the old `suspend()` /
  `resume()` path and cannot stream. The app therefore has **two** presentation
  modes; that is expected.

The app stays tool-agnostic: it exposes a `hostProcess` capability on
`UpgradeOptions`, and the source calls it with its own argv. When `hostProcess`
is absent (headless, `--dry-run`, tests) the source runs the process itself via
`proc.run(..., { inherit: true })` — see rule 2 for why that matters.

A script does **not** need a trailing `pause` — but it may keep one to let the
user read the output. Any such pause must be guarded so a piped or scripted run
can't block (the same rule as `scripts/install.ts`):

```powershell
if ($Host.UI.RawUI -and -not [Console]::IsInputRedirected) {
  Write-Host "Press any key to continue..."
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
```

`examples/msys-update.ps1` ends this way.

### 4. Windows gotchas

- **`.py` has no file association** → `CustomScript.interpreter` exists for this.
  The PATH `python.exe` is the Microsoft Store stub; real Python is uv-managed.
- **`.cmd` shims** → resolve executables with `Bun.which()` (see `proc.ts`).
- **Elevation** → write a `.ps1` to temp, `Start-Process -Verb RunAs -Wait`, read
  results from a temp JSON file. One process = one UAC prompt (`upgradeBatch`).

### 5. Parsing tool output (already implemented — don't "fix" it)

- **winget has no JSON**; its fixed-width table is sliced at header offsets. A
  narrow console can truncate an `Id` with `…` — that row fails with winget's
  own error.
- **npm exits `1` when outdated packages exist** — that's success, not failure.
- **Windows Update** JSON via PowerShell: `ConvertTo-Json` returns an object for
  one item, an array for many — handle both. UTF-8 output + strip BOM.

#### Why Windows Update uses the WUA COM API, not `UsoClient.exe`

`UsoClient.exe` is **not a supported interface** and cannot replace the WUA
scripts. Verified on current Windows 11 Pro versions: it emits **no output at
all**, so it cannot list pending updates, and the install verbs are rejected —
`StartScan` returns `0` (while doing nothing observable) but `StartDownload`,
`StartInstall`, `RefreshSettings` and `ResumeUpdate` all return **87**
(`ERROR_INVALID_PARAMETER`). `0`-on-failure is the same "reports success
regardless" trap this project has already been bitten by.

It is an undocumented internal tool for the Update Orchestrator service
(`UsoSvc`); `wuauclt` is documented by Microsoft as deprecated, and on current
Windows 11 Pro versions `/DetectNow` also just exits `0` without output. **Don't
re-investigate either** — `Microsoft.Update.Session` (the WUA COM API) is the API
to use, and it is what `src/sources/windows-update.ts` already does. It also
gives what `UsoClient` cannot: a list with titles/KBs/sizes, per-update results,
and one elevated batch (one UAC prompt).

#### Microsoft Store uses the StoreCLI (`store.exe`), not a script

Windows 11 ships a supported `store` command inside the Microsoft Store app (an
app-execution alias to `store.exe`). `src/sources/store.ts` uses it directly:
`store updates` lists pending apps, `store update <app> --apply` installs one.
This replaced the old `rundll32 AppxDeploymentClient.dll,ScheduleAppInstallerBackgroundUpdate`
+ `ScanForUpdatesAsUser` scheduled-task trigger and its `store-update.ps1`
example — do not bring those back.

**Do not confuse it with `microsoft/msstore-cli` (`msstore.exe`)** — that repo is
the Partner Center *publishing* CLI (`apps list`, `submission`, `publish`,
requires Azure AD credentials). It cannot list or update the apps installed on a
machine. Different tool, different job.

Two behaviours to remember (both handled in `src/sources/store.ts`):

- Output is a **coloured box table on stdout** (CRLF), with **no `--json`**.
- The **exit code is untrustworthy**: an unknown parameter prints
  `Unknown parameter(s): …` and still exits `0`. Parse the output; don't trust
  `$?`.

The `updates` table columns are **Name / Publisher / Version / Date** (verified
against a real pending update) — the same renderer as `installed`, and with **no
target-version column**, so `latest` is `"update"` and the picker shows
`1.24.11321.0 → update`. The parser is header-driven (like the winget table
parser) and is exercised against **real captured output** in
`tests/store.test.ts` (both `updates` and `installed`, the latter for wrapped
cells).

`store updates` is **interactive**: even without `--apply` it asks "Would you
like to install the N Store update(s) now? [y/n]". With no stdin it prints
`Failed to read input in non-interactive mode.` and installs nothing, so listing
through `proc.run` is safe. **Never list with `--apply`** — that is the install.
Results are read from the output (`✅ Installed` / `❌ Cancelled` / `❌ Error`),
not from the exit code.

### 6. Never let a non-interactive path hang

Any prompt or wait must check `process.stdin.isTTY` / `process.stdout.isTTY`
first and no-op when there is no terminal (so `--json`-style and piped use can't
block). The old `scripts/install.ts` hung once by prompting on a dead stdin.

---

## Config

- User: `%USERPROFILE%\.config\updater\config.json` (auto-created; `~/.config` elsewhere).
- Project override: `./updater.config.json`, **per key** (not deep-merged).
- Keys: `ignore`, `pin`, `scripts`. Rules are `source:pattern` or bare
  `pattern`, case-insensitive, matched against name, full id, and source id.

---

## Developing

```sh
bun install
bun run start
bun test
bun run typecheck
```

Keep these standards:

- **Strict TS** (`noUncheckedIndexedAccess` on), explicit types at boundaries.
- **Sources stay self-contained adapters**; the app knows nothing tool-specific.
- **Tests mock `src/proc.ts`** — never hit the network or real package managers
  (except custom-source tests, which use local temp `.cmd` files).
- Run `bun test` and `bun run typecheck` before committing.

### Building and installing

To ship a fresh binary:

```sh
bun run build:exe && bun run install
```

`install` copies `dist/updater-tui.exe` (~93 MB) to
`%USERPROFILE%\.local\bin\updater-tui.exe` (already on PATH), asking for
confirmation; `--yes` skips the prompt. It stages to a `.new` file and renames,
so re-installing over a running `updater-tui.exe` is safe.

Two gotchas learned the hard way:

- **If the copy is interrupted** (e.g. an agent harness kills the process
  mid-copy), a stale `updater-tui.exe` is left in place and the install reports
  nothing. Verify by timestamp/size against the fresh `dist/updater-tui.exe`. A
  direct `Copy-Item` to a `.new` file followed by `Move-Item` is the equivalent
  recovery.
- **Always rebuild before installing** to test a fix — the installed exe is a
  snapshot, not a link to the source. `bun run start` reads the source directly,
  so it picks up changes without a rebuild.

This repo's exe is larger (OpenTUI) and, like the old one, **unsigned** —
SmartScreen may warn on first run.

> Both apps live in `~/.local/bin` and **share one config**
> (`~/.config/updater/config.json`), so a `scripts` entry added for one appears
> in the other with no code changes.

---

## Testing interactive UI

You cannot drive a TUI by piping stdin — it needs a real terminal. Two layers:

- **Unit / frame tests:** `@opentui/core/testing` gives an in-memory renderer
  (`createTestRenderer`, `captureCharFrame`, `mockInput`, `waitForFrame`). This
  is deterministic and is what `tests/checklist.test.ts` and `tests/app.test.ts`
  use. Prefer this — no PTY, no diffing, no flake.
- **End-to-end:** `scripts/pty-check.ts` spawns the real app on **Bun's built-in
  PTY** (`Bun.spawn(cmd, { terminal: { … } })`, ConPTY on Windows) and watches
  the raw stream for markers. `scripts/pty-exe-check.ts` does the same for the
  built `dist/updater-tui.exe`. These are manual harnesses (tens of seconds), not
  part of `bun test`.

A PTY's output is **diffed** — a static screen emits almost nothing, so don't
assert on "the screen contains X" there; assert on a marker that implies a
*change* (a scan line, a result). For frame assertions use the test renderer.

`@xterm/headless` is not needed (and must not be added to app deps).

---

## Why the UI is imperative (no Solid/React)

OpenTUI has `@opentui/solid` and `@opentui/react` bindings, and they work from
source — **but not in `bun build --compile` executables.** Verified with minimal
probes: a compiled Solid app mounts once and then never re-renders. A timer
driven `createSignal` never updates, `useKeyboard` never fires, and
`renderer.destroy()` never resolves. The equivalent **core** app compiles and
works fine.

Since a standalone `.exe` is a requirement, the UI uses **`@opentui/core`'s
imperative API** (`BoxRenderable`, `TextRenderable`, `ScrollBoxRenderable`, and
`renderer.keyInput`). Do not reintroduce a reactive binding without first
re-verifying it survives `bun run build:exe` — see `scripts/pty-exe-check.ts`.

Two more consequences of the exe:

- **No `bunfig.toml`.** A compiled exe re-reads `bunfig.toml` from the current
  directory and fails with `preload not found "…"` when run elsewhere. There is
  no `bunfig.toml` in this repo for that reason. The preload/transform is not
  needed because the UI has no JSX.
- **Test the exe from another directory** (`scripts/pty-exe-check.ts` runs with
  `cwd` set to a temp dir) — that is the case that catches the above.

---

## Layout: size panes with flex weights, not `%`

The two panes in `src/ui/app.ts` use `flexGrow: 1` + `flexBasis: 0`, **not**
`width: "50%"`. A percentage on a pane nested inside the app's root box resolved
against the wrong basis: the pane stayed a fixed width while the terminal grew,
so changing `45%` → `50%` → `60%` looked identical on screen. Measured with the
real `App` tree at a 180-column terminal, `width: "50%"` produced a 60-column
pane; flex weights produce 90.

`tests/app.test.ts` has a regression test that asserts the panes fill the
terminal and each stays near half at 120/180/200 columns. When a pane looks the
wrong size, **measure the real tree** (`setup.renderer.root.getChildren()…`) —
eyeballing a screenshot of a nested flex layout is how this was mis-diagnosed
twice.

---

## Colours come from the terminal palette, not from us

`src/ui/theme.ts` maps every semantic colour onto an **ANSI palette slot**
(`RGBA.fromIndex(0..15)`), so the terminal resolves it against the user's scheme
and re-theming the terminal recolours the app live. Do not put hex back.

- **Slots 16–255 are not theme colours** — they are the fixed xterm RGB cube and
  greys.
- **`RGBA.defaultForeground()` does not work here.** The docs say it emits
  `SGR 39`; measured against `renderer.currentRenderBuffer` it resolves to the
  native's built-in white snapshot (`ESC[38;2;255;255;255m`), which would be
  invisible on a light scheme. Body text is slot 7 instead.
  `RGBA.defaultBackground()` *is* fine on a background channel (it emits
  `SGR 49`) and is used for the scroll track.
- **`createTextAttributes({ reverse: true })` is a trap.** With no background
  set, OpenTUI packs *both* fg and bg as the text's own colour (measured:
  `fg=indexed/12 bg=indexed/12 attrs=0x20`), so a "reverse video" highlight
  renders as solid accent with invisible text. The active row uses an explicit
  box `backgroundColor` instead.

The caveat of slots 0–15: a scheme defines "white" (7/15) as near-white, so on a
*light* terminal scheme body text can wash out. That is a limitation of the
16-colour palette, not a bug — the fix would be `renderer.themeMode` or
`getPalette()`, both of which are deliberately not used.

`tests/theme.test.ts` guards all of this: it renders the real `Checklist` in the
in-memory renderer and asserts every non-blank glyph carries a palette intent.

---

## Accepted: embedded terminal overlay for custom scripts

Custom scripts are hosted in an overlay on a pty and rendered live via OpenTUI's
`EmbeddedTerminalRenderable`, instead of suspend/resume taking over the whole
terminal. See rule 3 for how it works.

It was **built once before and reverted**, and the note that used to live here is
worth keeping because the cause is now understood:

- `EmbeddedTerminalRenderable` works on Windows x64 — **including inside a
  compiled exe** — fed by `Bun.spawn(..., { terminal })` / a `Bun.Terminal`.
  Output renders, typed keys reach the child, prompts work.
- **Elevated commands cannot be captured.** `Start-Process -Verb RunAs` opens its
  own console, so a pty sees nothing. Windows Update stays on suspend/resume.

**Why it failed the first time — and the fix.** The streamed child exited
immediately instead of waiting at its prompt. Cause: when a single keypress both
*starts* an embedded terminal and *focuses* it, the renderer delivers that same
key to the just-created renderable — so the upgrade `Enter` leaked into the child
as `\r` and answered its first prompt. The fix is to create **and** focus the
panel on the **next tick**, after the triggering key has been dispatched.
`tests/enter-race.test.ts` locks both halves down: it asserts a synchronous
create+focus *does* leak (so the mechanism can't silently change) and that the
deferred pattern does not.

When debugging this class of problem, build the in-process harness first (live
test renderer + panel + simulated key, iterated with `bun test`); PTY runs are
~30 s each and were the main time sink. `scripts/tui-terminal-prototype.ts` and
`scripts/embedded-terminal-probe.ts` are the standalone probes;
`scripts/overlay-check.ts` drives the real app under a PTY.

---

## Environment

- Windows 11 Pro (current versions), Windows Terminal (PowerShell 7).
- Bun 1.4.2, Node 24.x.
- Package managers present: `npm`, `winget`, `bun`, `uv`. **No** scoop/choco/
  pipx/cargo/go/gem.
- `~/.local/bin` is on PATH (uv Python shims, the old `updater.exe`, and now
  `updater-tui.exe`).

---

## Status

Done:

- [x] Researched OpenTUI, verified it renders on current Windows 11 Pro versions.
- [x] Layout: left = two-stage selection, right = output, bottom = summary/hints.
- [x] Ported the flow; `Source`/config/`console-mode.ts` wired in.
- [x] Script output inside the full-screen app — **embedded terminal overlay**,
  see rule 3 and the "Accepted" note below.
- [x] Config in `%USERPROFILE%\.config\updater\config.json` (shared by every
  updater install on the machine, so it is configured once).
- [x] `build:exe` + `install` revived (see the imperative-UI note above).
- [x] Microsoft Store apps as a first-class source via the StoreCLI (`store.exe`)
  — see rule 5. Parses the real Name/Publisher/Version/Date table; the one gap is
  that the CLI exposes no target version, so items read `current → update`.

Not done / deliberately:

- No `--source` in the TUI's own UI (it is a CLI filter only). The picker is the
  way to choose sources interactively.
- No in-GUI pin/ignore toggle (config-only).
- No `@xterm/headless`: the test renderer covers frame assertions.

