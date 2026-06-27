param(
  [Parameter(Mandatory = $true)]
  [int]$Issue,
  [string]$Topic = "",
  [string]$Root = "C:\Users\Yang\Documents\OpenClawWork",
  [string]$Base = "origin/main",
  [string]$BranchPrefix = "sunlit/fix",
  [string]$OpenClawRemote = "https://github.com/openclaw/openclaw.git"
)

$ErrorActionPreference = "Stop"

function Slugify {
  param([string]$Value)
  $slug = $Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "-"
  $slug = $slug.Trim("-")
  return $slug
}

$name = "issue-$Issue"
if ($Topic.Trim()) {
  $name = "$name-$(Slugify $Topic)"
}

$repoRoot = Join-Path $Root "repos"
$mainRepo = Join-Path $repoRoot "openclaw"
$worktreeRoot = Join-Path $Root "worktrees"
$outputsRoot = Join-Path $Root "outputs"
$worktreePath = Join-Path $worktreeRoot $name
$outputPath = Join-Path $outputsRoot $name
$branch = "$BranchPrefix/issue-$Issue"
if ($Topic.Trim()) {
  $branch = "$branch-$(Slugify $Topic)"
}

New-Item -ItemType Directory -Force $repoRoot, $worktreeRoot, $outputsRoot, $outputPath | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $mainRepo ".git"))) {
  git clone $OpenClawRemote $mainRepo
}

git -C $mainRepo fetch origin

if (Test-Path -LiteralPath $worktreePath) {
  throw "Worktree already exists: $worktreePath"
}

$existingBranch = (& git -C $mainRepo branch --list $branch) -join ""
if ($existingBranch.Trim()) {
  git -C $mainRepo worktree add $worktreePath $branch
} else {
  git -C $mainRepo worktree add -b $branch $worktreePath $Base
}

$files = @{
  "pr-body.md" = ""
  "live-proof.md" = ""
  "local-review.md" = ""
  "ci-notes.md" = ""
}

foreach ($file in $files.Keys) {
  $path = Join-Path $outputPath $file
  if (-not (Test-Path -LiteralPath $path)) {
    New-Item -ItemType File -Path $path | Out-Null
  }
}

[pscustomobject]@{
  issue = $Issue
  name = $name
  branch = $branch
  worktree = $worktreePath
  outputs = $outputPath
  base = $Base
} | ConvertTo-Json

