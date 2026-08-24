#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
validator="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"

skills=("$repo_root"/.codex/skills/auto-pr-*)
for skill in "${skills[@]}"; do
  [[ -d "$skill" ]] || continue
  skill_name="$(basename "$skill")"
  claude_skill="$repo_root/.claude/skills/$skill_name"
  if [[ ! -L "$claude_skill" ]]; then
    echo ".claude/skills/$skill_name must be a symlink to the canonical .codex skill" >&2
    exit 1
  fi
  canonical_skill="$(cd "$skill" && pwd -P)"
  resolved_claude_skill="$(cd "$claude_skill" && pwd -P)"
  if [[ "$canonical_skill" != "$resolved_claude_skill" ]]; then
    echo ".codex and .claude skill paths resolve to different content: $skill_name" >&2
    exit 1
  fi
  bash -n "$skill"/scripts/*.sh
  for file in "$skill"/scripts/*.mjs "$skill"/scripts/lib/*.mjs; do
    [[ -e "$file" ]] && node --check "$file"
  done
  node "$repo_root/scripts/validate-skill.mjs" "$skill"
done
for file in "$repo_root"/.codex/auto-pr-core/*.mjs; do
  node --check "$file"
done
node --test "$repo_root"/tests/*.test.mjs

if [[ -f "$validator" ]] && python3 -c 'import yaml' >/dev/null 2>&1; then
  for skill in "${skills[@]}"; do
    [[ -d "$skill" ]] && python3 "$validator" "$skill"
  done
else
  echo "Supplemental skill-creator validator unavailable; deterministic local skill validation passed."
fi

git -C "$repo_root" diff --check
echo "auto-pr validation passed"
