param(
  [Parameter(Mandatory = $true)]
  [string]$Workflow,
  [string]$TestScript = "test:changed",
  [switch]$SkipFetch
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "openclaw-preflight.mjs"
$arguments = @($runner, "--workflow", $Workflow, "--test-script", $TestScript)
if ($SkipFetch) { $arguments += "--skip-fetch" }
& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
