param(
  [string]$RepoPath = ".",
  [string]$Base = "origin/main",
  [string]$PrBodyDraft = "",
  [string]$ClawSweeperReport = "",
  [string]$ExpectedAuthorName = "sunlit-deng",
  [string]$ExpectedEmail = "yang.jiajun1@xydigit.com"
)

$ErrorActionPreference = "Stop"

function Run-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & git -C $RepoPath @Args
}

function Section {
  param([string]$Name)
  ""
  "## $Name"
}

function Get-FrontMatterValue {
  param([string]$Text, [string]$Key)
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Key)):\s*(.+?)\s*$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ""
}

$resolvedRepo = Resolve-Path -LiteralPath $RepoPath
$RepoPath = $resolvedRepo.Path

$inside = Run-Git "rev-parse" "--is-inside-work-tree"
if (($inside | Select-Object -First 1) -ne "true") {
  throw "RepoPath is not a git work tree: $RepoPath"
}

$branch = (Run-Git "branch" "--show-current" | Select-Object -First 1)
$head = (Run-Git "rev-parse" "HEAD" | Select-Object -First 1)
$mergeBase = (Run-Git "merge-base" $Base "HEAD" | Select-Object -First 1)
$status = @(Run-Git "status" "--porcelain")
$diffStat = @(Run-Git "diff" "--stat" "$mergeBase..HEAD")
$nameStatus = @(Run-Git "diff" "--name-status" "$mergeBase..HEAD")
$commitLines = @(Run-Git "log" "--format=%h%x09%an <%ae>%x09%cn <%ce>%x09%s" "$mergeBase..HEAD")

$authorProblems = @()
foreach ($line in $commitLines) {
  $parts = $line -split "`t"
  if ($parts.Count -ge 4) {
    if ($parts[1] -ne "$ExpectedAuthorName <$ExpectedEmail>") {
      $authorProblems += "Author mismatch: $line"
    }
    if ($parts[2] -ne "$ExpectedAuthorName <$ExpectedEmail>") {
      $authorProblems += "Committer mismatch: $line"
    }
  }
}

$prBodyStatus = "not provided"
if ($PrBodyDraft) {
  if (Test-Path -LiteralPath $PrBodyDraft) {
    $body = Get-Content -Raw -LiteralPath $PrBodyDraft
    $required = @(
      "## What Problem This Solves",
      "## Why This Change Was Made",
      "## User Impact",
      "## Evidence",
      "AI-assisted: built with Codex"
    )
    $missing = @($required | Where-Object { $body -notlike "*$_*" })
    $linkOk = $body -match "(?m)^(Fixes|Closes|Related):\s+#\d+"
    if ($missing.Count -eq 0 -and $linkOk) {
      $prBodyStatus = "ok"
    } else {
      $details = @()
      if ($missing.Count -gt 0) { $details += "missing: $($missing -join ', ')" }
      if (-not $linkOk) { $details += "missing visible Fixes/Closes/Related line" }
      $prBodyStatus = "needs attention ($($details -join '; '))"
    }
  } else {
    $prBodyStatus = "missing file: $PrBodyDraft"
  }
}

$clawStatus = "not provided"
if ($ClawSweeperReport) {
  if (Test-Path -LiteralPath $ClawSweeperReport) {
    $report = Get-Content -Raw -LiteralPath $ClawSweeperReport
    $result = Get-FrontMatterValue -Text $report -Key "result"
    if (-not $result) { $result = "unknown" }
    if ($result -eq "nothing_found") {
      $clawStatus = "pass ($result)"
    } else {
      $clawStatus = "not passed ($result)"
    }
  } else {
    $clawStatus = "missing file: $ClawSweeperReport"
  }
}

$gateProblems = @()
if ($status.Count -gt 0) { $gateProblems += "working tree is not clean" }
if ($authorProblems.Count -gt 0) { $gateProblems += "author/committer mismatch" }
if ($PrBodyDraft -and $prBodyStatus -ne "ok") { $gateProblems += "PR body draft needs attention" }
if ($ClawSweeperReport -and $clawStatus -notlike "pass *") { $gateProblems += "ClawSweeper local-review did not pass" }

Section "OpenClaw Pre-Push Check"
"Repo: $RepoPath"
"Branch: $branch"
"Head: $head"
"Base: $Base"
"Merge base: $mergeBase"

Section "Working Tree"
if ($status.Count -eq 0) { "clean" } else { $status }

Section "Diff Summary"
if ($diffStat.Count -eq 0) { "(no committed diff beyond base)" } else { $diffStat }

Section "Changed Files"
if ($nameStatus.Count -eq 0) { "(none)" } else { $nameStatus }

Section "Commits"
if ($commitLines.Count -eq 0) { "(none)" } else { $commitLines }

Section "Authorship"
if ($authorProblems.Count -eq 0) {
  "ok: expected $ExpectedAuthorName <$ExpectedEmail>"
} else {
  $authorProblems
}

Section "PR Body Draft"
$prBodyStatus
if ($PrBodyDraft) { "path: $PrBodyDraft" }

Section "ClawSweeper Local Review"
$clawStatus
if ($ClawSweeperReport) { "path: $ClawSweeperReport" }

Section "Gate Result"
if ($gateProblems.Count -eq 0) {
  "READY FOR HUMAN REVIEW: show this summary to the user before any GitHub write."
} else {
  "NOT READY:"
  $gateProblems | ForEach-Object { "- $_" }
}
