param(
  [Parameter(Mandatory = $true)]
  [string]$Workflow,
  [string]$TestScript = "test:changed"
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "openclaw-preflight.mjs"
$arguments = @($runner, "--workflow", $Workflow, "--test-script", $TestScript)
& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
