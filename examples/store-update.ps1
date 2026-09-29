<#
  store-update.ps1 — trigger Microsoft Store (MSIX/Appx) app updates.

  Windows exposes no supported CLI to LIST pending Store app updates, so this is
  a fire-and-forget trigger: it asks Windows to scan for and install Store app
  updates in the background, then returns. Progress is NOT shown here — open the
  Store's "Library" (Get updates) to watch it.

  It uses triggers verified to exist on current Windows 11 Pro versions:
    - rundll32 AppxDeploymentClient.dll,ScheduleAppInstallerBackgroundUpdate
      (the Appx/app-installer background update, driven by the AppInstallerUpdater task)
    - the InstallService task ScanForUpdatesAsUser (runs as AllUsers, so it
      works WITHOUT elevation)
    - the MDM update-scan method, if accessible (optional)

  Everything here is tried unelevated: no UAC prompt. The sibling task
  ScanForUpdates runs as SYSTEM and needs admin to start, so it is deliberately
  left alone — it drives the same scan code path for the machine-wide app set.

  Run from the updater as a "Custom scripts" entry.
#>

$ErrorActionPreference = 'Continue'

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

# 2) InstallService per-user scan task.
#
# ScanForUpdatesAsUser runs as AllUsers (S-1-5-4) and its task ACL grants
# Interactive Users start rights, so it works WITHOUT elevation — verified.
# Its sibling ScanForUpdates runs as SYSTEM and returns "Access is denied"
# unelevated; starting that one needs admin. It is deliberately NOT attempted
# here: adding it would mean a UAC prompt for a scan that covers the same
# InstallService code path, and this script stays prompt-free.
#
# Both tasks are ComHandler actions on the same class
# ({A558C6A5-B42B-4C98-B610-BF9559143139}) with empty Execute/Arguments — they
# invoke the same scan, differing only in the account they run as. The SYSTEM
# one is the machine-wide pass; this one covers the current user's apps, which
# is what the Store UI shows.
$taskPath = '\Microsoft\Windows\InstallService\'
$taskName = 'ScanForUpdatesAsUser'
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "  ($taskName not present on this system)"
} else {
  # Start-ScheduledTask only reports that the request was accepted. Compare
  # LastRunTime before/after so we can tell an actual run from a no-op, rather
  # than trusting the absence of an exception.
  $before = (Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName).LastRunTime
  try {
    Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop

    $ran = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 250
      $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName
      if ($info.LastRunTime -ne $before) {
        $ran = $true
        if ($info.LastTaskResult -ne 0) {
          Write-Host "  (task ${taskName} ran but reported code $($info.LastTaskResult))"
        }
        break
      }
    }

    if ($ran) {
      $triggered += "task ${taskName}"
    } else {
      Write-Host "  (task ${taskName} accepted but did not run — it may be queued)"
    }
  } catch {
    Write-Host "  (task ${taskName} could not be started: $($_.Exception.Message))"
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
