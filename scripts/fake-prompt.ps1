#!/usr/bin/env pwsh
<#
  fake-prompt.ps1 — a tiny stand-in for an interactive updater script, for
  testing the embedded-terminal prototype when there is nothing to update.

  It prints a banner, asks one question, echoes the answer, waits briefly, then
  exits. No network, no installs.

  Run it through the prototype:
    bun run scripts/tui-terminal-prototype.ts -- pwsh -File scripts/fake-prompt.ps1
#>
$ErrorActionPreference = 'Continue'

Write-Host "=== fake updater ===" -ForegroundColor Cyan
Write-Host "Pretending to back up..."

$answer = Read-Host "Continue? [Y/n]"
Write-Host "You said: '$answer'"

Write-Host "Nothing to update. Done."
Write-Host ("" )
Write-Host "Press Enter to close..." -NoNewline
$null = Read-Host

exit 0
