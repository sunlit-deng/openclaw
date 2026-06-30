#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ensure-openclaw-deps.sh --repo-path PATH [--root PATH] [--store-path PATH] [--force]

Installs OpenClaw dependencies with a shared pnpm store and per-worktree node_modules.
EOF
}

repo_path=""
root=""
store_path=""
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path)
      repo_path="${2:-}"
      shift 2
      ;;
    --root)
      root="${2:-}"
      shift 2
      ;;
    --store-path)
      store_path="${2:-}"
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$repo_path" ]]; then
  echo "--repo-path is required" >&2
  usage >&2
  exit 2
fi

repo_path="$(cd "$repo_path" && pwd -P)"
modules_file="$repo_path/node_modules/.modules.yaml"

if [[ -f "$modules_file" && "$force" -eq 0 ]]; then
  printf '{"repo":"%s","status":"skipped","reason":"node_modules already exists; pass --force after lockfile or package changes"}\n' "$repo_path"
  exit 0
fi

if [[ -z "$store_path" ]]; then
  if [[ -z "$root" ]]; then
    repo_parent="$(dirname "$repo_path")"
    if [[ "$(basename "$repo_parent")" == "worktrees" ]]; then
      root="$(dirname "$repo_parent")"
    else
      root="$(pwd -P)"
    fi
  fi
  store_path="$root/.pnpm-store"
fi

mkdir -p "$store_path"
pnpm --dir "$repo_path" install --frozen-lockfile --prefer-offline --store-dir "$store_path"

printf '{"repo":"%s","status":"installed","store":"%s"}\n' "$repo_path" "$store_path"
