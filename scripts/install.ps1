param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" })
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $repoRoot "skills\openclaw-pr-workflow"
$skillsRoot = Join-Path $CodexHome "skills"
$target = Join-Path $skillsRoot "openclaw-pr-workflow"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Skill source not found: $source"
}

New-Item -ItemType Directory -Force $skillsRoot | Out-Null

$resolvedSkillsRoot = (Resolve-Path -LiteralPath $skillsRoot).Path
if (Test-Path -LiteralPath $target) {
  $resolvedTarget = (Resolve-Path -LiteralPath $target).Path
  if (-not $resolvedTarget.StartsWith($resolvedSkillsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove target outside skills root: $resolvedTarget"
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $target -Recurse

$validator = Join-Path $CodexHome "skills\.system\skill-creator\scripts\quick_validate.py"
if (Test-Path -LiteralPath $validator) {
  python $validator $target
}

"Installed openclaw-pr-workflow to $target"

