#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: new-openclaw-worktree.sh --issue N [--topic TEXT] [--root PATH]
                               [--branch-prefix PREFIX]
                               [--account PROFILE]
                               [--store-path PATH]
                               [--skip-install --skip-install-reason TEXT]

Dependencies are installed by default with a shared pnpm store. Skipping the
install requires an explicit reason and is recorded in workflow.json.
EOF
}

slugify() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
auto_pr_root="$(cd "$script_dir/../../../.." && pwd -P)"

issue=""
topic=""
root="$auto_pr_root/workspace/openclaw"
branch_prefix="sunlit/fix"
store_path=""
account_profile=""
skip_install=0
skip_install_reason=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) issue="${2:-}"; shift 2 ;;
    --topic) topic="${2:-}"; shift 2 ;;
    --root) root="${2:-}"; shift 2 ;;
    --branch-prefix) branch_prefix="${2:-}"; shift 2 ;;
    --account) account_profile="${2:-}"; shift 2 ;;
    --store-path) store_path="${2:-}"; shift 2 ;;
    --install-dependencies) shift ;;
    --skip-install) skip_install=1; shift ;;
    --skip-install-reason) skip_install_reason="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$issue" =~ ^[1-9][0-9]*$ ]]; then
  echo "--issue must be a positive integer" >&2
  exit 2
fi
if [[ "$skip_install" -eq 1 && -z "${skip_install_reason// }" ]]; then
  echo "--skip-install requires --skip-install-reason" >&2
  exit 2
fi
if [[ "$skip_install" -eq 0 && -n "$skip_install_reason" ]]; then
  echo "--skip-install-reason requires --skip-install" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to create workflow.json" >&2
  exit 1
fi
if [[ "$skip_install" -eq 0 ]] && ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required unless --skip-install is used with a reason" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required for authenticated OpenClaw repository setup" >&2
  exit 1
fi

root="$(mkdir -p "$root" && cd "$root" && pwd -P)"
account_args=(shell-env --root "$root")
if [[ -n "$account_profile" ]]; then
  account_args+=(--profile "$account_profile")
fi
eval "$(node "$script_dir/openclaw-account.mjs" "${account_args[@]}")"
gh auth status >/dev/null
gh auth setup-git

name="issue-$issue"
branch="$branch_prefix/issue-$issue"
if [[ -n "${topic// }" ]]; then
  topic_slug="$(slugify "$topic")"
  [[ -n "$topic_slug" ]] || { echo "--topic must contain a letter or number" >&2; exit 2; }
  name="$name-$topic_slug"
  branch="$branch-$topic_slug"
fi

repo_root="$root/repos"
main_repo="$repo_root/openclaw"
worktree_root="$root/worktrees"
outputs_root="$root/outputs"
worktree_path="$worktree_root/$name"
output_path="$outputs_root/$name"
store_path="${store_path:-$root/.pnpm-store}"

mkdir -p "$repo_root" "$worktree_root" "$outputs_root" "$output_path" "$store_path"
store_path="$(cd "$store_path" && pwd -P)"

if [[ ! -d "$main_repo/.git" ]]; then
  gh repo clone openclaw/openclaw "$main_repo"
fi

if ! git -C "$main_repo" fetch origin main; then
  echo "Unable to fetch current origin/main through the gh-authenticated repository." >&2
  echo "Stop here; do not continue with cached local refs." >&2
  exit 1
fi
base_ref="refs/remotes/origin/main"
base_sha="$(git -C "$main_repo" rev-parse "$base_ref^{commit}")"

if [[ -e "$worktree_path" ]]; then
  echo "Worktree already exists: $worktree_path" >&2
  exit 1
fi
if git -C "$main_repo" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "Local branch already exists and will not be reused implicitly: $branch" >&2
  echo "Use the existing-PR maintenance workflow or choose a topic suffix." >&2
  exit 1
fi

git -C "$main_repo" worktree add -b "$branch" "$worktree_path" "$base_sha"
git -C "$worktree_path" config user.name "$OPENCLAW_ACCOUNT_USERNAME"
git -C "$worktree_path" config user.email "$OPENCLAW_ACCOUNT_EMAIL"

for file in pr-body.md live-proof.md ci-notes.md; do
  : > "$output_path/$file"
done

dependency_status="installed"
if [[ "$skip_install" -eq 1 ]]; then
  dependency_status="skipped"
else
  "$script_dir/ensure-openclaw-deps.sh" \
    --repo-path "$worktree_path" --root "$root" --store-path "$store_path"
fi

head_sha="$(git -C "$worktree_path" rev-parse HEAD)"
node "$script_dir/write-workflow-state.mjs" \
  --mode new-issue \
  --issue "$issue" \
  --root "$root" \
  --repo-path "$worktree_path" \
  --output-path "$output_path" \
  --branch "$branch" \
  --base-ref origin/main \
  --base-sha "$base_sha" \
  --head-sha "$head_sha" \
  --pnpm-store-path "$store_path" \
  --pr-body-path "$output_path/pr-body.md" \
  --preflight-path "$output_path/preflight.json" \
  --dependency-status "$dependency_status" \
  --skip-reason "$skip_install_reason" \
  --account-profile "$OPENCLAW_ACCOUNT_PROFILE" \
  --account-username "$OPENCLAW_ACCOUNT_USERNAME" \
  --account-email "$OPENCLAW_ACCOUNT_EMAIL" \
  --account-login "$OPENCLAW_ACCOUNT_LOGIN" \
  --account-push-remote "$OPENCLAW_ACCOUNT_PUSH_REMOTE"
