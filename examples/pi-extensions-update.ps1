$ErrorActionPreference = 'Continue'

Write-Host "=== Pi extensions update ==="
Write-Host ""

$pi = Get-Command pi -ErrorAction SilentlyContinue
if (-not $pi) {
  Write-Host "!! pi not found on PATH"
  exit 127
}

& pi update --extensions
$exit = $LASTEXITCODE

if ($Host.UI.RawUI -and -not [Console]::IsInputRedirected) {
  Write-Host ""
  Write-Host "Press any key to continue..."
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

exit $exit
