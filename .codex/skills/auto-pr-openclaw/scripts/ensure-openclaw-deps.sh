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
fingerprint_file="$repo_path/node_modules/.auto-pr-deps-fingerprint"
dependency_fingerprint="$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const hash = crypto.createHash("sha256");
  for (const file of process.argv.slice(1)) {
    hash.update(path.basename(file));
    hash.update("\0");
    if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  process.stdout.write(hash.digest("hex"));
' "$repo_path/package.json" "$repo_path/pnpm-lock.yaml")"

if [[ -f "$modules_file" && "$force" -eq 0 ]]; then
  installed_fingerprint=""
  if [[ -f "$fingerprint_file" ]]; then
    installed_fingerprint="$(tr -d '\r\n' < "$fingerprint_file")"
  fi
  if [[ "$installed_fingerprint" == "$dependency_fingerprint" ]]; then
    printf '{"repo":"%s","status":"skipped","reason":"dependency fingerprint unchanged","fingerprint":"%s"}\n' "$repo_path" "$dependency_fingerprint"
    exit 0
  fi
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
printf '%s\n' "$dependency_fingerprint" > "$fingerprint_file"

actual_store="$(pnpm --dir "$repo_path" store path --store-dir "$store_path")"
actual_store="$(cd "$actual_store" && pwd -P)"
expected_store="$(cd "$store_path" && pwd -P)"
if [[ "$actual_store" != "$expected_store" && "$actual_store" != "$expected_store/"* ]]; then
  echo "pnpm store mismatch: expected $expected_store, got $actual_store" >&2
  exit 1
fi

printf '{"repo":"%s","status":"installed","storeRoot":"%s","store":"%s","fingerprint":"%s"}\n' "$repo_path" "$expected_store" "$actual_store" "$dependency_fingerprint"
