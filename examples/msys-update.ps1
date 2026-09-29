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

while ($pass -lt $maxPasses) {
  $pass++
  Write-Host "--- pass $pass ---"

  # Capture output so we can tell whether pacman actually did anything, while
  # still printing it live. (Tee-Object -Variable drops the pass-through here.)
  $lines = [System.Collections.Generic.List[string]]::new()
  & $bash -lc "cd / && pacman $pacmanArgs" 2>&1 | ForEach-Object {
    $line = $_.ToString()
    $lines.Add($line)
    Write-Host $line
  }
  $exit = $LASTEXITCODE
  $text = ($lines -join "`n")

  if ($exit -ne 0) {
    Write-Host "!! pacman exited with code $exit"
    break
  }

  # Nothing left to install → done. pacman says "there is nothing to do".
  if ($text -match 'there is nothing to do') {
    Write-Host ""
    Write-Host "MSYS2 is up to date."
    break
  }

  # Otherwise pacman did something; loop again in case a core update was
  # deferred to the next run.
  Write-Host ""
}

if ($pass -ge $maxPasses) {
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
