param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,
  [string]$Root = "E:\Projects\auto-pr\workspace\openclaw",
  [string]$PnpmStorePath = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoPath = (Resolve-Path -LiteralPath $RepoPath).Path
$modulesFile = Join-Path $repoPath "node_modules/.modules.yaml"

if ((Test-Path -LiteralPath $modulesFile) -and -not $Force) {
  [pscustomobject]@{
    repo = $repoPath
    status = "skipped"
    reason = "node_modules already exists; pass -Force after lockfile or package changes"
  } | ConvertTo-Json
  return
}

if (-not $PnpmStorePath.Trim()) {
  $repoParent = Split-Path -Parent $repoPath
  if ((Split-Path -Path $repoParent -Leaf) -eq "worktrees") {
    $Root = Split-Path -Path $repoParent -Parent
  }
  $PnpmStorePath = Join-Path $Root ".pnpm-store"
}

New-Item -ItemType Directory -Force $PnpmStorePath | Out-Null

pnpm --dir $repoPath install --frozen-lockfile --prefer-offline --store-dir $PnpmStorePath

[pscustomobject]@{
  repo = $repoPath
  status = "installed"
  store = $PnpmStorePath
} | ConvertTo-Json
