#!/usr/bin/env bash
# Seed a freshly created OpenClaw worktree with tsgo incremental build info
# (tsbuildinfo) harvested from the most recently used sibling worktree.
#
# Why: the first targeted preflight in a new worktree pays a cold
# `tsgo:core:test` typecheck of 10-20 minutes. tsbuildinfo records source
# paths relative to the tsbuildinfo file itself, so a cache copied from a
# sibling worktree stays valid: tsgo re-checks whatever changed relative to
# that snapshot and rebuilds only what is stale. Worst case (fully stale
# cache) tsgo falls back to a full build - no correctness risk, only time.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: seed-openclaw-tsgo-cache.sh --repo-path PATH --root PATH [--source PATH]

  --repo-path  Worktree to seed (created by new-openclaw-worktree.sh or
               prepare-openclaw-pr-worktree.mjs).
  --root       auto-pr OpenClaw workspace root containing worktrees/.
  --source     Explicit seed directory (a .artifacts/tsgo-cache dir);
               overrides the newest-sibling heuristic.
EOF
}

repo_path=""
root=""
source_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path) repo_path="${2:-}"; shift 2 ;;
    --root) root="${2:-}"; shift 2 ;;
    --source) source_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -d "$repo_path" ]] || { echo "--repo-path does not exist: $repo_path" >&2; exit 2; }
[[ -d "$root" ]] || { echo "--root does not exist: $root" >&2; exit 2; }

target_dir="$repo_path/.artifacts/tsgo-cache"

if compgen -G "$target_dir/*.tsbuildinfo" > /dev/null; then
  echo "tsgo cache already present, skipping seed: $target_dir"
  exit 0
fi

if [[ -z "$source_dir" ]]; then
  newest_mtime=0
  newest_dir=""
  for candidate_dir in "$root"/worktrees/*/.artifacts/tsgo-cache; do
    [[ -d "$candidate_dir" ]] || continue
    [[ "$candidate_dir" == "$target_dir" ]] && continue
    candidate_mtime="$(find "$candidate_dir" -maxdepth 1 -name '*.tsbuildinfo' -newermt '@0' -print 2>/dev/null |
      head -1 | xargs -I{} stat -f '%m' {} 2>/dev/null || echo 0)"
    candidate_mtime="${candidate_mtime:-0}"
    if [[ "$candidate_mtime" -gt "$newest_mtime" ]]; then
      newest_mtime="$candidate_mtime"
      newest_dir="$candidate_dir"
    fi
  done
  source_dir="$newest_dir"
fi

if [[ -z "$source_dir" ]]; then
  echo "No sibling worktree has a tsgo cache to seed from; the first preflight will build one."
  exit 0
fi
if ! compgen -G "$source_dir/*.tsbuildinfo" > /dev/null; then
  echo "Seed directory has no tsbuildinfo files: $source_dir"
  exit 0
fi

mkdir -p "$target_dir"
copied=0
for tsbuildinfo in "$source_dir"/*.tsbuildinfo; do
  cp -p "$tsbuildinfo" "$target_dir/" && copied=$((copied + 1))
done

echo "Seeded $copied tsgo tsbuildinfo file(s) into $target_dir from $source_dir"
