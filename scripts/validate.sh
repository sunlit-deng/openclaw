#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
skill="$repo_root/.codex/skills/auto-pr-openclaw"
validator="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"

bash -n "$skill"/scripts/*.sh
for file in "$skill"/scripts/*.mjs "$skill"/scripts/lib/*.mjs; do
  node --check "$file"
done
node --test "$repo_root/tests/pr-body-validator.test.mjs"

if [[ -f "$validator" ]]; then
  python3 "$validator" "$skill"
else
  echo "Skill validator not found at $validator; skipped validation."
fi

git -C "$repo_root" diff --check
echo "auto-pr validation passed"
