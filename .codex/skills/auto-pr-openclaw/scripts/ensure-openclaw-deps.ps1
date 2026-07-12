param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,
  [string]$Root = "",
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
  if (-not $Root.Trim()) {
    throw "Unable to infer the OpenClaw workspace root; pass -Root or -PnpmStorePath"
  }
  $PnpmStorePath = Join-Path $Root ".pnpm-store"
}

New-Item -ItemType Directory -Force $PnpmStorePath | Out-Null

pnpm --dir $repoPath install --frozen-lockfile --prefer-offline --store-dir $PnpmStorePath
if ($LASTEXITCODE -ne 0) {
  throw "pnpm install failed with exit code $LASTEXITCODE"
}

$expectedStore = [System.IO.Path]::GetFullPath($PnpmStorePath).TrimEnd('\', '/')
$actualStore = (& pnpm --dir $repoPath store path --store-dir $PnpmStorePath | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "pnpm store path failed with exit code $LASTEXITCODE"
}
$actualStore = [System.IO.Path]::GetFullPath($actualStore).TrimEnd('\', '/')
if ($actualStore -ne $expectedStore -and -not $actualStore.StartsWith("$expectedStore$([System.IO.Path]::DirectorySeparatorChar)")) {
  throw "pnpm store mismatch: expected $expectedStore, got $actualStore"
}

[pscustomobject]@{
  repo = $repoPath
  status = "installed"
  storeRoot = $expectedStore
  store = $actualStore
} | ConvertTo-Json
