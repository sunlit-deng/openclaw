# ZeroClaw PR body

Use the checked-out `.github/pull_request_template.md` as the source of truth and answer every applicable prompt. Template-only heading suffixes such as `(required)` are author guidance, not required text in the submitted body; omit them from final headings. This compact example shows the clean submitted shape.

```markdown
## Summary
- **Base branch:** `master` (all contributions)
- **What changed and why:**
  - ...
- **Scope boundary:**
- **Blast radius:**
- **Linked issue(s):** Related #123 (use `Implements #...` for an accepted RFC)
- **Labels:** `type:bug`, `risk:low`, `size:S`

## Testing
### How you can test (when useful)
- **Reviewer testing requested?** (`N/A`; no useful manual verification path)

### How I tested
- **CI checks relied on and why:** ...
- **Known CI coverage gap, if any:** None
- **Commands run and tail output:**

```text
$ cargo fmt --all -- --check
status: passed
```

- **Beyond CI, what did I manually verify?** N/A
- **If any command was intentionally skipped, why:** N/A

## Security & Privacy Impact
- New permissions, capabilities, or file system access scope? No
- New external network calls? No
- Secrets / tokens / credentials handling changed? No
- PII, real identities, or personal data in diff, tests, fixtures, or docs? No
- Prompt injection or untrusted model-visible text introduced/changed? No

## Compatibility
- Backward compatible? Yes
- Config / env / CLI surface changed? No
- Rust/MSRV/toolchain floor changed? No
- If backward compatibility is No or either surface/floor question is Yes: exact upgrade steps for existing users: N/A

## Rollback
Low-risk change: `git revert <sha>` is the plan.
```

For medium/high-risk changes, replace the rollback paragraph with the exact fast rollback command/path, feature flags or config toggles, and observable failure symptoms. Add `## Supersede Attribution` whenever the Summary uses `Supersedes #...`.

Do not copy local `/Users`, `/Volumes`, `/home`, `workspace`, `outputs`, or `worktrees` paths into the body. Do not add AI attribution footers. If no issue exists, omit the issue link rather than inventing one.
