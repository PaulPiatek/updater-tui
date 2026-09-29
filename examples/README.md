# Example custom scripts

Ready-made scripts you can reference from your updater config's `scripts` array.
They are **examples, not code** — the app never imports them; you point your
config at them (or copy them to your own location and edit freely).

Both are PowerShell, so both need an **interpreter** (see [Wiring them
up](#wiring-them-up)) — `.ps1` files generally have no Windows file association.

## `store-update.ps1` — trigger Microsoft Store app updates

Windows exposes **no supported CLI to list pending Store (MSIX/Appx) app
updates**, so this is a **fire-and-forget trigger**: it asks Windows to scan for
and install Store updates in the background, then returns. It cannot show
progress or list packages — open **Store → Library → "Get updates"** to watch it.

It uses mechanisms verified to exist on current Windows 11 Pro versions:

- `rundll32 AppxDeploymentClient.dll,ScheduleAppInstallerBackgroundUpdate`
  (the Appx/app-installer background update)
- the `InstallService` scheduled task `ScanForUpdatesAsUser` (runs as *AllUsers*,
  so it starts without elevation)
- the MDM update-scan method, when accessible (optional)

**No UAC prompt.** `ScanForUpdates` (the sibling task, which runs as *SYSTEM* and
does need admin to start) is deliberately not used: it drives the same
InstallService scan code path, so prompting for it would buy little. The script
confirms the per-user task actually ran by comparing its `LastRunTime` before and
after, rather than trusting that `Start-ScheduledTask` didn't throw.

## `msys-update.ps1` — update an MSYS2 install (`pacman -Syu`)

Runs `pacman -Syu` **through MSYS2's own login bash** (`usr\bin\bash.exe -lc`),
so pacman gets the right environment (DLLs, `/etc`, its database). Point the
`MSYS_ROOT` variable at your install (default `G:\msys64`).

- **Loops until nothing is left to do.** `pacman -Syu` often needs two passes —
  the first updates pacman/core and tells you to restart the shell. The script
  repeats until pacman reports "there is nothing to do" (capped at 5 passes).
- **Interactive** — pacman's prompts reach the real terminal (the updater gives
  scripts the real stdin/stdout). Add `-NoConfirm` via `args` for `--noconfirm`.
- Output streams live, and the exit code is pacman's.
- **Ends with a "press any key" pause** so you can read the result. It is
  guarded, so a piped or scripted run skips it instead of blocking.

### Wiring them up

Both scripts are `.ps1`, so give each an **interpreter** — that also pins the
PowerShell version you want:

```json
{
  "scripts": [
    {
      "name": "StoreUpdates",
      "path": "C:\\path\\to\\store-update.ps1",
      "interpreter": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    },
    {
      "name": "MSYS2",
      "path": "C:\\path\\to\\msys-update.ps1",
      "interpreter": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    }
  ]
}
```

Add these to your config (`%USERPROFILE%\.config\updater\config.json`) and the
rows appear under **Custom scripts**.
