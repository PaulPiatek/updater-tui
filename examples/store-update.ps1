<#
  store-update.ps1 — trigger Microsoft Store (MSIX/Appx) app updates.

  Windows exposes no supported CLI to LIST pending Store app updates, so this is
  a fire-and-forget trigger: it asks Windows to scan for and install Store app
  updates in the background, then returns. Progress is NOT shown here — open the
  Store's "Library" (Get updates) to watch it.

  It uses triggers verified to exist on this machine:
    - rundll32 AppxDeploymentClient.dll,ScheduleAppInstallerBackgroundUpdate
      (the Appx/app-installer background update, driven by the AppInstallerUpdater task)
    - the InstallService scheduled tasks ScanForUpdates / ScanForUpdatesAsUser
    - the MDM update-scan method, if accessible (it usually needs admin, so it is
      attempted but not required)

  Run from the updater as a "Custom scripts" entry.
#>

$ErrorActionPreference = 'Continue'

function Write-Step([string]$text) { Write-Host $text }

Write-Host "=== Microsoft Store updates ==="

$triggered = @()

# 1) The Appx app-installer background update — the most direct Store trigger.
try {
  & "$env:SystemRoot\System32\rundll32.exe" 'AppxDeploymentClient.dll,ScheduleAppInstallerBackgroundUpdate'
  if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
    $triggered += 'Appx app-installer background update'
  }
} catch {
  Write-Host "  (app-installer trigger failed: $($_.Exception.Message))"
}

# 2) InstallService scan tasks (they usually need admin — attempt, but verify).
foreach ($name in 'ScanForUpdates', 'ScanForUpdatesAsUser') {
  $task = Get-ScheduledTask -TaskPath '\Microsoft\Windows\InstallService\' -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { continue }
  try {
    Start-ScheduledTask -TaskPath '\Microsoft\Windows\InstallService\' -TaskName $name -ErrorAction Stop
    $triggered += "task ${name}"
  } catch {
    Write-Host "  (task ${name} needs elevation — skipped)"
  }
}

# 3) MDM update scan, when it is accessible (often needs admin — optional).
try {
  $mgr = Get-CimInstance -Namespace 'root\cimv2\mdm\dmmap' `
    -ClassName 'MDM_EnterpriseModernAppManagement_AppManagement01' -ErrorAction Stop
  if ($mgr) {
    Invoke-CimMethod -InputObject $mgr -MethodName 'UpdateScanMethod' | Out-Null
    $triggered += 'MDM update scan'
  }
} catch {
  # Access denied is expected without elevation — not an error for us.
}

if ($triggered.Count -eq 0) {
  Write-Host "!! No Store update trigger could be started."
  exit 1
}

foreach ($what in $triggered) { Write-Host "  triggered: $what" }
Write-Host ""
Write-Host "Store updates are running in the background."
Write-Host "Open Store > Library > 'Get updates' to watch progress."
