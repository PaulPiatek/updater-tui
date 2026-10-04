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
  the first updates pacman/core and (by design) terminates the MSYS2 session. The
  script keeps going while `pacman -Qu` still reports upgradable packages, so a
  non-zero exit from that terminating pass doesn't stop it (capped at 5 passes).
- **Interactive** — pacman's prompts reach the real terminal (the updater gives
  scripts the real stdin/stdout). Add `-NoConfirm` via `args` for `--noconfirm`.
- Output streams live, and the exit code is `0` once MSYS2 is fully up to date
  (an intermediate pass that deliberately closes the session may exit non-zero).
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

## `pi-extensions-update.ps1` — update pi's installed extensions

Runs `pi update --extensions` to refresh the extensions installed into the `pi`
coding agent. It deliberately does **not** update `pi` itself — that is an npm
package, upgraded separately through npm.

- **Fails fast** with a clear message and exit `127` when `pi` is not on `PATH`,
  instead of silently reporting success.
- Propagates `pi`'s exit code, so the updater's ✔ / ✖ reflects the result.
- **Ends with a guarded "press any key" pause**, skipped when input is redirected.

### Wiring it up

Same as `msys-update.ps1` — give it an **interpreter**:

```json
{
  "scripts": [
    {
      "name": "Pi",
      "path": "C:\\path\\to\\pi-extensions-update.ps1",
      "interpreter": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    }
  ]
}
```
