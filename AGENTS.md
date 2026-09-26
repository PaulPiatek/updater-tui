# AGENTS.md

Instructions for anyone (human or AI agent) working on **updater-tui**.

This is a **new, self-contained rewrite** of the clack-based `updater` at
`C:\Users\me\dev\updater`. It keeps the same job — one interactive flow that
upgrades npm globals, winget packages, Windows Update, and custom scripts — but
replaces the terminal UI with **OpenTUI**.

**Read the old repo too.** `C:\Users\me\dev\updater\AGENTS.md` and its git
history are the institutional memory for *why* the non-UI parts work the way
they do. Most of the hard lessons below are ported from there.

---

## The goal

An **OpenTUI** app (the library `opencode` uses): a full-screen, pane-based
terminal UI.

- **Left pane:** selections — two stages, like the old tool.
  1. pick sources
  2. pick packages
- **Right pane:** live output / status (scan progress, per-item results, custom
  script output).
- **Bottom:** summary and an exit prompt.

OpenTUI was chosen **deliberately** over clack, for panes, focus, scrolling and
custom keys. Do not "simplify" it back to prompts — the whole reason for this
repo is the richer UI.

---

## What was copied from the old repo (keep it working)

These are **UI-agnostic** and were copied verbatim. Treat them as the reliable
core; the bug fixes in them were hard-won.

| File | Purpose |
| --- | --- |
| `src/types.ts` | `Source`, `UpgradeItem`, `UpgradeOptions`, `UpgradeResult`, `RunMode` |
| `src/sources/npm.ts` | global npm packages (`npm outdated -g --json`) |
| `src/sources/winget.ts` | Windows Package Manager (parses the fixed-width table) |
| `src/sources/windows-update.ts` | Windows Update Agent COM API, one elevated batch |
| `src/sources/custom.ts` | user-defined executables from config |
| `src/sources/index.ts` | registry (`createSources(config)`) |
| `src/config.ts` | `ignore` / `pin` / `scripts`, user + project files |
| `src/proc.ts` | `Bun.spawn` helper (`run`, `which`) |
| `src/console-mode.ts` | **critical Windows fix** — see below |

**What is NOT copied** (rebuild it): the clack UI (`ui/select.ts`) and the
imperative `runner.ts`. That is the entire point of this repo.

The `Source` interface is the contract: the UI must consume `UpgradeItem[]` and
call `source.list()` / `upgrade()` / `upgradeBatch()`. **Do not put UI code in
the sources.**

---

## The rules from the old repo that still apply

### 1. Stop and ask first

If a request needs significant custom work — hand-rolled rendering, fighting the
library's design, vendored internals — **do not start building it. Stop and ask
the user first**, explain the effort/fragility trade-off, and offer a simpler
option or "skip it".

The user's consistent preference: **keep it simple and idiomatic; accept a small
functional loss over a large pile of custom code.**

(The old repo learned this the hard way: an in-picker "press `p` to pin" feature
needed a fully custom clack `render()` and was removed. This time OpenTUI gives
us panes and custom keys *natively* — so use its APIs, don't reimplement them.)

### 2. Windows console input mode is shared and fragile  ← **do not lose this**

`src/console-mode.ts` exists because clack (and any interactive child) can leave
the Windows console in the wrong input mode, after which later prompts — and
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

### 3. Custom scripts inherit the real terminal

Scripts run with `stdin/stdout/stderr: "inherit"` so their output streams live
and their prompts work. In a **full-screen OpenTUI app** this is trickier than in
clack — think about this early:

- You cannot just let a child write to the terminal while OpenTUI owns the
  screen; you'll corrupt the UI.
- Likely approach: suspend/exit OpenTUI's screen (or use a dedicated output
  pane plus a pty) around an inherited script, then resume. **Research and test
  this specifically** — it's the hardest integration point.
- The `custom` source already declares `runMode: "stream"`; use that to know
  when output is coming from the child rather than a captured command.

### 4. Windows gotchas (from the old repo)

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

### 6. Never let a non-interactive path hang

Any prompt or wait must check `process.stdin.isTTY` / `process.stdout.isTTY`
first and no-op when there is no terminal (so `--json`-style and piped use can't
block). The old `scripts/install.ts` hung once by prompting on a dead stdin.

---

## Config (same as the old repo)

- User: `%USERPROFILE%\.config\updater\config.json` (auto-created; `~/.config` elsewhere).
- Project override: `./updater.config.json`, **per key** (not deep-merged).
- Keys: `ignore`, `pin`, `scripts`. Rules are `source:pattern` or bare
  `pattern`, case-insensitive, matched against name, full id, and source id.

**Decide:** should the TUI repo read the *same* config file (shared, recommended)
or its own (`updater-tui`)? Sharing means the user configures once.

---

## Developing

```sh
bun install
bun run start
bun test
bun run typecheck
```

Keep the old repo's standards:

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

## Rejected: streaming child output into the pane

A feature was built and then reverted: run custom scripts (and npm/winget) on a
pty and render their output live in the right pane via OpenTUI's
`EmbeddedTerminalRenderable`, instead of suspend/resume.

What was **proven** before abandoning it:

- `EmbeddedTerminalRenderable` works on Windows x64 — **including inside a
  compiled exe** — fed by `new Bun.Terminal()`. Output renders, typed keys reach
  the child, prompts work. (`Bun.spawn(..., { terminal })` is documented
  POSIX-only, but a `Bun.Terminal` instance works on Windows.)
- **Elevated commands cannot be captured.** `Start-Process -Verb RunAs` opens its
  own console, so a pty sees nothing. Windows Update must stay on
  suspend/resume regardless.

Why it was reverted: inside the running app the streamed child exited
immediately instead of waiting at its prompt, and the cause was not isolated.
The same script/argv/cwd/env on the same pty behaved correctly *outside* the app,
so it is something about the live-renderer context.

**If you retry this**, build the in-process harness first: a live test renderer +
the panel + a simulated Enter key, iterated with `bun test`. The PTY-based
debugging used here took ~30s per run and was the main time sink. Also note the
app's `keyInput` listeners run *before* the focused renderable — check whether
the key that starts the upgrade is being delivered into a freshly spawned pty.

---

## Environment (this machine)

- Windows 11 Pro, Windows Terminal (PowerShell 7).
- Bun 1.4.2, Node 24.x.
- Package managers present: `npm`, `winget`, `bun`, `uv`. **No** scoop/choco/
  pipx/cargo/go/gem.
- `~/.local/bin` is on PATH (uv Python shims, the old `updater.exe`, and now
  `updater-tui.exe`).

---

## Status

Done:

- [x] Researched OpenTUI, verified it renders on this machine.
- [x] Layout: left = two-stage selection, right = output, bottom = summary/hints.
- [x] Ported the flow; `Source`/config/`console-mode.ts` wired in.
- [x] Script output inside the full-screen app — see rule 3 (suspend/resume).
- [x] Config is **shared** with the old tool (same files, nothing new to decide).
- [x] `build:exe` + `install` revived (see the imperative-UI note above).

Not done / deliberately:

- No `--source` in the TUI's own UI (it is a CLI filter only). The picker is the
  way to choose sources interactively.
- No in-GUI pin/ignore toggle (config-only, same as the old repo).
- No `@xterm/headless`: the test renderer covers frame assertions.

