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

---

## Testing interactive UI

You cannot drive a TUI by piping stdin — it needs a real terminal. Use **Bun's
built-in PTY** (`Bun.spawn(cmd, { terminal: { cols, rows, data } })`, ConPTY on
Windows) and reconstruct the screen with `@xterm/headless`. This is how the old
repo's UI was verified byte-for-byte. Install `@xterm/headless` only in a temp
harness dir, **never in this app's dependencies**.

---

## Environment (this machine)

- Windows 11 Pro, Windows Terminal (PowerShell 7).
- Bun 1.4.2, Node 24.x.
- Package managers present: `npm`, `winget`, `bun`, `uv`. **No** scoop/choco/
  pipx/cargo/go/gem.
- `~/.local/bin` is on PATH (uv Python shims, and the old `updater.exe`).

---

## Status / TODO

- [ ] **Research OpenTUI first** (API, Windows support, pane/focus/scroll,
      examples — ideally how `opencode` uses it) before writing UI code.
- [ ] Verify OpenTUI installs and renders on this machine.
- [ ] Design the layout: left = two-stage selection, right = output, bottom =
      summary/exit.
- [ ] Port the app flow; wire `Source`/config/`console-mode.ts` in.
- [ ] Solve script output inside a full-screen app (see rule 3).
- [ ] Decide: share the old config file, or a new one.
