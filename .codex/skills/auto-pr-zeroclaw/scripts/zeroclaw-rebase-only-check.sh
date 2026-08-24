#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../../../.." && pwd -P)"
exec node "$repo_root/.codex/skills/auto-pr-openclaw/scripts/openclaw-rebase-only-check.mjs" "$@"
