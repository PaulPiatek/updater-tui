# Example custom scripts

Ready-made scripts you can reference from your updater config's `scripts` array.
They are **examples, not code** — the app never imports them; you point your
config at them (or copy them to your own location and edit freely).

They are PowerShell, so each needs an **interpreter** (see [Wiring it
up](#wiring-it-up)) — `.ps1` files generally have no Windows file association.

> Microsoft Store updates are **no longer a script**: they are a built-in source
> (`Microsoft Store apps`) driven by the official StoreCLI — `store updates`
> lists pending apps and `store update <app> --apply` installs one. The old
> fire-and-forget `store-update.ps1` (rundll32 + scheduled-task triggers) has
> been removed; see the "Microsoft Store uses the StoreCLI" note in the top-level
> `README.md`.

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

### Wiring it up

Give the script an **interpreter** — that also pins the PowerShell version you
want:

```json
{
  "scripts": [
    {
      "name": "MSYS2",
      "path": "C:\\path\\to\\msys-update.ps1",
      "interpreter": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    }
  ]
}
```

Add it to your config (`%USERPROFILE%\.config\updater\config.json`) and the row
appears under **Custom scripts**.
