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

"Project-local auto-pr-openclaw is ready at $target"
