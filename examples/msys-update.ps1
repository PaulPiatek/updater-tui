<#
  msys-update.ps1 — update the MSYS2 environment (pacman -Syu), looping until
  nothing is left to do.

  Delegates to MSYS2's own bash so pacman runs with the correct environment
  (its DLLs, /etc, and the pacman database). Uses `-l` (login shell) so the
  MSYS variables are set up.

  `pacman -Syu` is interactive and often needs TWO passes: the first updates
  pacman/core and tells you to restart the shell, the second installs the rest.
  This script repeats the command until pacman reports nothing to do, so one
  click finishes the job.

  It is still interactive — pacman's prompts (confirm, [Y/n]) go to the real
  terminal, which the updater provides. Pass -NoConfirm to add --noconfirm.

  Adjust MSYS_ROOT below if your install moves.
#>

param(
  [switch]$NoConfirm
)

$ErrorActionPreference = 'Continue'

$MSYS_ROOT = 'G:\msys64'
$bash = Join-Path $MSYS_ROOT 'usr\bin\bash.exe'
$pacmanArgs = if ($NoConfirm) { '-Syu --noconfirm' } else { '-Syu' }

if (-not (Test-Path $bash)) {
  Write-Host "!! MSYS2 bash not found at $bash"
  exit 1
}

Write-Host "=== MSYS2 update (pacman $pacmanArgs, looping) ==="
Write-Host "Working in: $MSYS_ROOT"
Write-Host ""

$maxPasses = 5
$pass = 0
$exit = 0
$done = $false

while ($pass -lt $maxPasses) {
  $pass++
  Write-Host "--- pass $pass ---"

  # Run pacman directly on the terminal — never through a PowerShell pipeline.
  # Piping its output makes stdout a pipe, which block-buffers it and hides
  # pacman's "[Y/n]" prompt (it has no trailing newline, so the pipeline never
  # emits it) even though pacman still reads the answer from your keyboard.
  & $bash -lc "cd / && pacman $pacmanArgs"
  $exit = $LASTEXITCODE

  # Anything left? The first pass may only update pacman/core and defer the
  # rest to a second run, so ask pacman what is still upgradable. Check this
  # *before* the exit code: a core update deliberately terminates MSYS2
  # processes, which can make that pass exit non-zero even though the update is
  # progressing fine and simply needs another run to finish.
  $pending = @(& $bash -lc "pacman -Qu" 2>$null)
  if ($pending.Count -eq 0) {
    Write-Host ""
    Write-Host "MSYS2 is up to date."
    $done = $true
    break
  }

  if ($exit -ne 0) {
    Write-Host "!! pacman exited with code $exit"
    Write-Host "   $($pending.Count) package(s) still upgradable — running another pass."
  }

  Write-Host ""
}

if ($done) {
  # Nothing left to upgrade — treat that as success even if the pass that
  # finished the job exited non-zero because it terminated the MSYS2 session.
  $exit = 0
} else {
  Write-Host "Stopped after $maxPasses passes — re-run if pacman still reports updates."
}

# Keep the window up so the output can be read. Skipped when there is no
# interactive console (piped output, CI), so this can never hang.
if ($Host.UI.RawUI -and -not [Console]::IsInputRedirected) {
  Write-Host ""
  Write-Host "Press any key to continue..."
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

exit $exit
