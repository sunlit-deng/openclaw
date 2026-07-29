#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
skill="$repo_root/.codex/skills/auto-pr-openclaw"
claude_skill="$repo_root/.claude/skills/auto-pr-openclaw"
validator="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"

if [[ ! -L "$claude_skill" ]]; then
  echo ".claude/skills/auto-pr-openclaw must be a symlink to the canonical .codex skill" >&2
  exit 1
fi
canonical_skill="$(cd "$skill" && pwd -P)"
resolved_claude_skill="$(cd "$claude_skill" && pwd -P)"
if [[ "$canonical_skill" != "$resolved_claude_skill" ]]; then
  echo ".codex and .claude skill paths resolve to different content" >&2
  exit 1
fi

bash -n "$skill"/scripts/*.sh
for file in "$skill"/scripts/*.mjs "$skill"/scripts/lib/*.mjs; do
  node --check "$file"
done
node --test "$repo_root"/tests/*.test.mjs
node "$repo_root/scripts/validate-skill.mjs"

if [[ -f "$validator" ]] && python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 "$validator" "$skill"
else
  echo "Supplemental skill-creator validator unavailable; deterministic local skill validation passed."
fi

git -C "$repo_root" diff --check
echo "auto-pr validation passed"
