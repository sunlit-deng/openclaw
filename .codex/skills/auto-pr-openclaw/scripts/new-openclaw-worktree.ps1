param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$Issue,
  [string]$Topic = "",
  [string]$Root = "",
  [string]$BranchPrefix = "sunlit/fix",
  [string]$OpenClawRemote = "https://github.com/openclaw/openclaw.git",
  [string]$PnpmStorePath = "",
  [switch]$InstallDependencies,
  [switch]$SkipInstall,
  [string]$SkipInstallReason = ""
)

$ErrorActionPreference = "Stop"

function Slugify {
  param([string]$Value)
  $slug = $Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "-"
  return $slug.Trim("-")
}

if (-not $Root.Trim()) {
  $autoPrRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
  $Root = Join-Path $autoPrRoot "workspace\openclaw"
}
if ($SkipInstall -and -not $SkipInstallReason.Trim()) {
  throw "-SkipInstall requires -SkipInstallReason"
}
if (-not $SkipInstall -and $SkipInstallReason.Trim()) {
  throw "-SkipInstallReason requires -SkipInstall"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is required to create workflow.json"
}
if (-not $SkipInstall -and -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required unless -SkipInstall is used with a reason"
}

$Root = [System.IO.Path]::GetFullPath($Root)
$name = "issue-$Issue"
$branch = "$BranchPrefix/issue-$Issue"
if ($Topic.Trim()) {
  $topicSlug = Slugify $Topic
  if (-not $topicSlug) { throw "-Topic must contain a letter or number" }
  $name = "$name-$topicSlug"
  $branch = "$branch-$topicSlug"
}

$repoRoot = Join-Path $Root "repos"
$mainRepo = Join-Path $repoRoot "openclaw"
$worktreeRoot = Join-Path $Root "worktrees"
$outputsRoot = Join-Path $Root "outputs"
$worktreePath = Join-Path $worktreeRoot $name
$outputPath = Join-Path $outputsRoot $name
if (-not $PnpmStorePath.Trim()) {
  $PnpmStorePath = Join-Path $Root ".pnpm-store"
}
$PnpmStorePath = [System.IO.Path]::GetFullPath($PnpmStorePath)

New-Item -ItemType Directory -Force $repoRoot, $worktreeRoot, $outputsRoot, $outputPath, $PnpmStorePath | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $mainRepo ".git"))) {
  & git clone $OpenClawRemote $mainRepo
  if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
}

& git -C $mainRepo fetch origin main
if ($LASTEXITCODE -ne 0) { throw "git fetch origin main failed with exit code $LASTEXITCODE" }
$baseRef = "refs/remotes/origin/main"
$baseSha = (& git -C $mainRepo rev-parse "$baseRef`^{commit}" | Select-Object -First 1).Trim()
if ($LASTEXITCODE -ne 0 -or -not $baseSha) { throw "Unable to resolve latest origin/main" }

if (Test-Path -LiteralPath $worktreePath) {
  throw "Worktree already exists: $worktreePath"
}
$existingBranch = (& git -C $mainRepo show-ref --verify --quiet "refs/heads/$branch")
if ($LASTEXITCODE -eq 0) {
  throw "Local branch already exists and will not be reused implicitly: $branch. Use the existing-PR maintenance workflow or choose a topic suffix."
}

& git -C $mainRepo worktree add -b $branch $worktreePath $baseSha
if ($LASTEXITCODE -ne 0) { throw "git worktree add failed with exit code $LASTEXITCODE" }

foreach ($file in @("pr-body.md", "live-proof.md", "ci-notes.md")) {
  $path = Join-Path $outputPath $file
  [System.IO.File]::WriteAllText($path, "")
}

$dependencyStatus = "installed"
if ($SkipInstall) {
  $dependencyStatus = "skipped"
} else {
  $ensureDeps = Join-Path $PSScriptRoot "ensure-openclaw-deps.ps1"
  & $ensureDeps -RepoPath $worktreePath -Root $Root -PnpmStorePath $PnpmStorePath
}

$headSha = (& git -C $worktreePath rev-parse HEAD | Select-Object -First 1).Trim()
$stateWriter = Join-Path $PSScriptRoot "write-workflow-state.mjs"
& node $stateWriter `
  --mode new-issue `
  --issue $Issue `
  --root $Root `
  --repo-path $worktreePath `
  --output-path $outputPath `
  --branch $branch `
  --base-ref origin/main `
  --base-sha $baseSha `
  --head-sha $headSha `
  --pnpm-store-path $PnpmStorePath `
  --pr-body-path (Join-Path $outputPath "pr-body.md") `
  --preflight-path (Join-Path $outputPath "preflight.json") `
  --dependency-status $dependencyStatus `
  --skip-reason $SkipInstallReason
if ($LASTEXITCODE -ne 0) { throw "workflow state writer failed with exit code $LASTEXITCODE" }
