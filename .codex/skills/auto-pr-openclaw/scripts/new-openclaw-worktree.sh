#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: new-openclaw-worktree.sh --issue N [--topic TEXT] [--root PATH] [--base REF]
                               [--branch-prefix PREFIX] [--remote URL]
                               [--install-dependencies] [--store-path PATH]
EOF
}

slugify() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

issue=""
topic=""
root="/Users/yangjiajun/projects/auto-pr/workspace/openclaw"
base="origin/main"
branch_prefix="sunlit/fix"
remote="https://github.com/openclaw/openclaw.git"
install_deps=0
store_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)
      issue="${2:-}"
      shift 2
      ;;
    --topic)
      topic="${2:-}"
      shift 2
      ;;
    --root)
      root="${2:-}"
      shift 2
      ;;
    --base)
      base="${2:-}"
      shift 2
      ;;
    --branch-prefix)
      branch_prefix="${2:-}"
      shift 2
      ;;
    --remote)
      remote="${2:-}"
      shift 2
      ;;
    --install-dependencies)
      install_deps=1
      shift
      ;;
    --store-path)
      store_path="${2:-}"
      shift 2
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

if [[ -z "$issue" ]]; then
  echo "--issue is required" >&2
  usage >&2
  exit 2
fi

name="issue-$issue"
branch="$branch_prefix/issue-$issue"
if [[ -n "${topic// }" ]]; then
  topic_slug="$(slugify "$topic")"
  name="$name-$topic_slug"
  branch="$branch-$topic_slug"
fi

repo_root="$root/repos"
main_repo="$repo_root/openclaw"
worktree_root="$root/worktrees"
outputs_root="$root/outputs"
worktree_path="$worktree_root/$name"
output_path="$outputs_root/$name"

mkdir -p "$repo_root" "$worktree_root" "$outputs_root" "$output_path"

if [[ ! -d "$main_repo/.git" ]]; then
  git clone "$remote" "$main_repo"
fi

git -C "$main_repo" fetch origin

if [[ -e "$worktree_path" ]]; then
  echo "Worktree already exists: $worktree_path" >&2
  exit 1
fi

if git -C "$main_repo" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$main_repo" worktree add "$worktree_path" "$branch"
else
  git -C "$main_repo" worktree add -b "$branch" "$worktree_path" "$base"
fi

for file in pr-body.md live-proof.md local-review.md ci-notes.md; do
  touch "$output_path/$file"
done

dependencies="not_requested"
if [[ "$install_deps" -eq 1 ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [[ -n "$store_path" ]]; then
    "$script_dir/ensure-openclaw-deps.sh" --repo-path "$worktree_path" --root "$root" --store-path "$store_path"
  else
    "$script_dir/ensure-openclaw-deps.sh" --repo-path "$worktree_path" --root "$root"
  fi
  dependencies="ensured"
fi

printf '{"issue":%s,"name":"%s","branch":"%s","worktree":"%s","outputs":"%s","base":"%s","dependencies":"%s"}\n' \
  "$issue" "$name" "$branch" "$worktree_path" "$output_path" "$base" "$dependencies"
