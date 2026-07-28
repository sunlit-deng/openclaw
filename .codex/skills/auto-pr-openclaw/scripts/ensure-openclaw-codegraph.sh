#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ensure-openclaw-codegraph.sh --baseline-only --main-repo PATH
                                     --root PATH --base-sha SHA
       ensure-openclaw-codegraph.sh --repo-path PATH --main-repo PATH
                                     --root PATH --base-sha SHA

Maintains one CodeGraph baseline checkout at <root>/.codegraph-cache/repo,
then seeds a worktree-local index with copy-on-write when available and runs
an incremental sync for the target branch.

If the codegraph CLI is not installed, the command reports a skip and exits
successfully so CodeGraph remains an optional local developer aid.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
auto_pr_root="$(cd "$script_dir/../../../.." && pwd -P)"

repo_path=""
main_repo=""
root="$auto_pr_root/workspace/openclaw"
base_sha=""
baseline_only=0
codegraph_bin="${OPENCLAW_CODEGRAPH_BIN:-codegraph}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path) repo_path="${2:-}"; shift 2 ;;
    --main-repo) main_repo="${2:-}"; shift 2 ;;
    --root) root="${2:-}"; shift 2 ;;
    --base-sha) base_sha="${2:-}"; shift 2 ;;
    --baseline-only) baseline_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$main_repo" ]]; then
  echo "--main-repo is required" >&2
  exit 2
fi
if [[ "$baseline_only" -eq 0 && -z "$repo_path" ]]; then
  echo "--repo-path is required unless --baseline-only is used" >&2
  exit 2
fi
if [[ ! "$base_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "--base-sha must be a full 40-character commit SHA" >&2
  exit 2
fi
if ! command -v "$codegraph_bin" >/dev/null 2>&1; then
  echo "CodeGraph skipped: '$codegraph_bin' is not installed." >&2
  exit 0
fi

root="$(mkdir -p "$root" && cd "$root" && pwd -P)"
main_repo="$(cd "$main_repo" && pwd -P)"
if [[ "$baseline_only" -eq 0 ]]; then
  repo_path="$(cd "$repo_path" && pwd -P)"
fi

if [[ ! -e "$main_repo/.git" ]]; then
  echo "Main OpenClaw repository is missing: $main_repo" >&2
  exit 1
fi
if [[ "$baseline_only" -eq 0 && ! -e "$repo_path/.git" ]]; then
  echo "Target OpenClaw worktree is missing: $repo_path" >&2
  exit 1
fi
if ! git -C "$main_repo" cat-file -e "$base_sha^{commit}" 2>/dev/null; then
  echo "Base commit is unavailable in the main clone: $base_sha" >&2
  exit 1
fi

cache_root="$root/.codegraph-cache"
baseline_repo="$cache_root/repo"
baseline_sha_path="$cache_root/base-sha"
lock_dir="$cache_root/.lock"
mkdir -p "$cache_root"

release_lock() {
  if [[ -d "$lock_dir" ]]; then
    rm -f "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
}

acquire_lock() {
  local attempts=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    local owner=""
    owner="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [[ "$owner" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$owner" 2>/dev/null; then
      rm -f "$lock_dir/pid"
      rmdir "$lock_dir" 2>/dev/null || true
      continue
    fi
    attempts=$((attempts + 1))
    if [[ -z "$owner" && "$attempts" -ge 10 ]]; then
      rmdir "$lock_dir" 2>/dev/null || true
      continue
    fi
    if [[ "$attempts" -ge 120 ]]; then
      echo "Timed out waiting for CodeGraph cache lock: $lock_dir" >&2
      exit 1
    fi
    sleep 0.5
  done
  printf '%s\n' "$$" > "$lock_dir/pid"
  trap release_lock EXIT INT TERM
}

copy_on_write() {
  local source="$1"
  local destination="$2"
  rm -f "$destination"
  if cp -c "$source" "$destination" 2>/dev/null; then
    printf '%s' "clonefile"
    return
  fi
  rm -f "$destination"
  if cp --reflink=auto "$source" "$destination" 2>/dev/null; then
    printf '%s' "reflink"
    return
  fi
  rm -f "$destination"
  cp "$source" "$destination"
  printf '%s' "copy"
}

checkpoint_database() {
  local graph_dir="$1"
  local wal_path="$graph_dir/codegraph.db-wal"
  if [[ ! -s "$wal_path" ]]; then
    return
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    if ! sqlite3 "$graph_dir/codegraph.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null; then
      echo "Unable to checkpoint the CodeGraph baseline database." >&2
      exit 1
    fi
  fi
  if [[ -s "$wal_path" ]]; then
    echo "CodeGraph baseline still has an uncheckpointed WAL; refusing an inconsistent snapshot." >&2
    exit 1
  fi
}

acquire_lock

if [[ ! -e "$baseline_repo/.git" ]]; then
  if [[ -e "$baseline_repo" ]]; then
    echo "CodeGraph baseline path exists but is not a git worktree: $baseline_repo" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$baseline_repo")"
  git -c core.hooksPath=/dev/null -C "$main_repo" worktree add --detach "$baseline_repo" "$base_sha"
fi

if [[ -n "$(git -C "$baseline_repo" status --porcelain --untracked-files=no)" ]]; then
  echo "CodeGraph baseline worktree is dirty: $baseline_repo" >&2
  exit 1
fi

indexed_sha="$(cat "$baseline_sha_path" 2>/dev/null || true)"
baseline_head="$(git -C "$baseline_repo" rev-parse HEAD)"
if [[ "$baseline_head" != "$base_sha" ]]; then
  git -c core.hooksPath=/dev/null -C "$baseline_repo" checkout --detach "$base_sha"
fi

if [[ ! -f "$baseline_repo/.codegraph/codegraph.db" ]]; then
  (
    cd "$cache_root"
    CODEGRAPH_NO_WATCH= CODEGRAPH_FORCE_WATCH=1 "$codegraph_bin" init -i "$baseline_repo"
  )
  if [[ ! -f "$baseline_repo/.codegraph/codegraph.db" ]]; then
    echo "CodeGraph initialization completed without creating codegraph.db." >&2
    exit 1
  fi
  printf '%s\n' "$base_sha" > "$baseline_sha_path"
elif [[ "$indexed_sha" != "$base_sha" || "$baseline_head" != "$base_sha" ]]; then
  "$codegraph_bin" sync -q "$baseline_repo"
  printf '%s\n' "$base_sha" > "$baseline_sha_path"
fi

checkpoint_database "$baseline_repo/.codegraph"

if [[ "$baseline_only" -eq 1 ]]; then
  echo "CodeGraph baseline ready: repo=$baseline_repo base=$base_sha"
  exit 0
fi

target_graph="$repo_path/.codegraph"
copy_method="existing"
if [[ ! -f "$target_graph/codegraph.db" ]]; then
  mkdir -p "$target_graph"
  copy_method="$(copy_on_write "$baseline_repo/.codegraph/codegraph.db" "$target_graph/codegraph.db")"
  if [[ -f "$baseline_repo/.codegraph/.gitignore" ]]; then
    cp "$baseline_repo/.codegraph/.gitignore" "$target_graph/.gitignore"
  fi
fi

if [[ ! -f "$target_graph/.gitignore" ]]; then
  : > "$target_graph/.gitignore"
fi
if ! grep -qxF "openclaw-base-sha" "$target_graph/.gitignore"; then
  printf '%s\n' "openclaw-base-sha" >> "$target_graph/.gitignore"
fi

"$codegraph_bin" sync -q "$repo_path"
printf '%s\n' "$base_sha" > "$target_graph/openclaw-base-sha"

echo "CodeGraph ready: repo=$repo_path base=$base_sha seed=$copy_method"
