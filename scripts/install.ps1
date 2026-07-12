$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$target = Join-Path $repoRoot ".codex\skills\auto-pr-openclaw"

if (-not (Test-Path -LiteralPath $target)) {
  throw "Project-local skill not found: $target"
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$validator = Join-Path $codexHome "skills\.system\skill-creator\scripts\quick_validate.py"
if (Test-Path -LiteralPath $validator) {
  python $validator $target
} else {
  "Skill validator not found at $validator; skipped validation."
}

$parseErrors = @()
Get-ChildItem -LiteralPath (Join-Path $target "scripts") -Filter "*.ps1" | ForEach-Object {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
  $parseErrors += $errors
}
if ($parseErrors.Count -gt 0) {
  $parseErrors | ForEach-Object { Write-Error $_.Message }
  throw "PowerShell syntax validation failed"
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  Get-ChildItem -LiteralPath (Join-Path $target "scripts") -Recurse -Filter "*.mjs" | ForEach-Object {
    & node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Node syntax validation failed: $($_.FullName)" }
  }
  $bodyTests = Join-Path $repoRoot "tests\pr-body-validator.test.mjs"
  & node --test $bodyTests
  if ($LASTEXITCODE -ne 0) { throw "Node tests failed" }
} else {
  "node not found; skipped Node syntax checks and tests."
}

"Project-local auto-pr-openclaw is ready at $target"
