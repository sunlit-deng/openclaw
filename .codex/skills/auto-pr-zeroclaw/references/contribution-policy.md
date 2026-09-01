# ZeroClaw contribution policy

Source of truth: the checked-out repository files and the official upstream documents:

- [CONTRIBUTING.md](https://github.com/zeroclaw-labs/zeroclaw/blob/master/CONTRIBUTING.md)
- [AGENTS.md](https://github.com/zeroclaw-labs/zeroclaw/blob/master/AGENTS.md)
- [Pull request template](https://github.com/zeroclaw-labs/zeroclaw/blob/master/.github/pull_request_template.md)
- [Testing guide](https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/contributing/testing.md)
- [Privacy guide](https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/contributing/privacy.md)

## Intake

- Target `master`; ZeroClaw no longer has a `main` branch.
- Use a non-`master` branch, normally `feat/<slug>` or `fix/<slug>`. The ZeroClaw profile defaults to `fix/issue-<N>` and records the exact branch in the workflow.
- Read the architecture map before architecture, workflow, configuration, security, CI, release, or agent-assisted changes. Read the owning module, tests, and documentation before editing.
- For substantial architecture, established-default, breaking-schema, cross-cutting, new-subsystem, governance, release, or contribution-model changes, inspect the RFC process before implementation. If the tracked issue is labelled `type:rfc`, require its durable `status:accepted` disposition before coding.
- Keep one concern per PR, keep the patch small, avoid unnecessary dependencies, and link an issue only when it genuinely applies.

## Implementation and validation

- Preserve trust boundaries, privacy guarantees, user confirmation, and existing security behavior. Never add secrets or PII to code, logs, fixtures, proof, or the PR body.
- Keep user-facing runtime text in the existing Fluent/i18n path; keep Markdown source in English.
- Prefer the smallest implementation and a regression test at the real behavior boundary.
- The default local Rust lane is:

  ```text
  cargo fmt --all -- --check
  cargo clippy --workspace --exclude zeroclaw-desktop --all-targets --features ci-all -- -D warnings
  cargo test --locked
  ```

- For documentation-only changes use the repository documentation gates. For a release-grade full check use `bash ./dev/ci.sh all`; do not claim a command passed unless its literal output is captured.
- Where relevant, enable `ZEROCLAW_STRICT_LINT=1`, `ZEROCLAW_DOCS_LINT=1`, and `ZEROCLAW_DOCS_LINKS=1`.

## PR and merge gates

- Fill every applicable section in the upstream template: `Summary`, `Testing`, `Security & Privacy Impact`, and `Compatibility`. The upstream template may annotate headings with `(required)`; omit that instructional suffix in the submitted body. Add `Rollback` for medium/high risk and `Supersede Attribution` when using `Supersedes #...`.
- Validation evidence must contain the actual command and captured output, not a prose assertion.
- Explain security/privacy impact, compatibility, blast radius, and rollback honestly. Use repository-root paths only.
- Do not add `Co-authored-by`, `Created with ...`, `Generated with ...`, or other bot/AI attribution footers. AI collaboration is allowed, but the contribution must remain human-owned and policy-compliant.
- Use conventional commits and squash before merge. Do not rewrite another contributor's authorship merely to normalize metadata.

## Explicit user-directed workflow override

The rules above are the default contribution and publication workflow. If the
user explicitly instructs Codex to bypass the workflow rules and publish, or to
bypass all local publication gates, use the shared publisher with
`--allow-workflow-rule-bypass --workflow-rule-bypass-reason "<user reason>"`.
The one-attempt override may bypass local validation, template, identity,
intake, duplicate, review/CI, dirty-worktree, and maintainer-edit gates. Record
the reason and bypassed checks in `workflow.json` and report them before the
write. It does not bypass higher-priority instructions, secret/PII protections,
authenticated account ownership, target repository/branch/PR identity, current
HEAD/body binding, remote-head lease protection, GitHub/API failures, or final
remote body verification. It does not authorize comments or review requests.
