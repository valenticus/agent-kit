# Agent Kit v1.8.0

## Highlights

- New opt-in `security-audit` module for a bounded, source-only security review without changing existing core workflows or default skill selection.
- Cross-platform GitHub Actions validation with Node.js 24 and PowerShell 7.
- A separate guarded, manually dispatched GitHub Release workflow using the standard GITHUB_TOKEN.
- More portable PowerShell installer-test selection, error matching, and diagnostics.

## Security Audit Skill

The optional module adapts principles from [Cloudflare Security Audit Skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8), pinned to upstream commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. The complete Cloudflare MIT notice is preserved in [LICENSE](../optional/vendored/security-audit/LICENSE); [UPSTREAM.md](../optional/vendored/security-audit/UPSTREAM.md) records the source mapping and deliberate adaptations.

Installation requires explicit optional selection; installation does not start an audit. Invocation requires an explicit user request naming `security-audit`. Codex metadata disables implicit invocation on supporting hosts; other hosts use the textual activation gate and their existing controls.

The review maps architecture and trust boundaries, traces source evidence, and tracks reviewed, partial, blocked, unreviewed, and out-of-scope areas in a compact coverage table. Findings distinguish:

- `confirmed`: a complete statically proven boundary violation, always marked `evidence_basis: source-only` and `runtime_validation: not_performed`;
- `needs_validation`: a source-grounded hypothesis with a specific unresolved fact, without severity;
- `rejected`: a candidate refuted by concrete source evidence, without severity.

Only confirmed findings receive severity. Facts, assumptions, hardening suggestions, and coverage gaps remain distinct. This confirmation contract intentionally differs from upstream's execution-based verification.

The module uses one sequential offline pass, remains read-only toward the target, and defaults to reporting in chat. It prohibits target code execution, tests, builds, package scripts, subagents, automatic delegation, cloud/database MCP, production API access, and secret-value inspection. A report file requires an explicitly selected safe directory outside the target repository.

## Cross-platform CI

[Validate Agent Kit](../.github/workflows/validate.yml) runs on pushes to main, pull requests targeting main, and manual dispatch. Its Windows and macOS jobs each run six separate validators: security-audit with disposable fixtures, kit, policy, Claude adapter, data visualization, and installer. Git checks verify whitespace and that tests leave the checkout clean.

The suites cover default and explicit optional installation, distribution for all five supported tool adapters, Cline mirror parity, overwrite refusal, native Windows junctions, and macOS symlinks. Official checkout and Node setup actions are pinned to full commit SHAs. Validation uses read-only repository permissions, no repository secrets or package cache, and a 15-minute job timeout.

Installer tests prefer `pwsh`, report the chosen executable and version, and return a clear BLOCKED result when neither supported PowerShell executable is available. Expected-error checks normalize ANSI styling, wrapped-line gutters, and whitespace while retaining strict matching of the refusal reason. Bounded diagnostics preserve both the beginning and end of longer output. Local tests cover valid, incorrect, truncated, and unexpectedly successful results.

## Guarded Manual Releases

[Release Agent Kit](../.github/workflows/release.yml) runs only through explicit workflow_dispatch on main. It requires a stable SemVer tag and the full current main commit SHA. A read-only preflight checks VERSION/tag agreement, release notes, absence of existing tag/Release, human commit-author metadata, and successful exact-SHA push validation with both matrix jobs and every required validator step.

Only the publishing job receives contents/write. It repeats the gates, binds publication to the same evidence fingerprint, and uses create-only GitHub REST calls for an annotated tag object, tag reference, and non-prerelease Release. It verifies the final tag-to-commit and Release-to-tag relationships. It does not force, overwrite, automatically delete, or blindly retry mutations. See [the release process](releasing.md) for dispatch and recovery requirements.

## Validation

Before release preparation, [validation run 40307200925](https://github.com/valenticus/agent-kit/actions/runs/40307200925) passed on both macOS and Windows for commit `47d480954041f2c32fff6bf51f79640218144800`.

The guarded release logic passed 20 offline mock tests, including invalid inputs, version mismatch, missing/failed/stale CI, skipped steps, duplicate tags/releases, changed main or CI attempts, repeated runs, and ambiguous partial mutations. Those tests performed no real write API calls.

The release-preparation commit must independently pass the exact-SHA validation workflow before publication. The manual publishing workflow has not yet been exercised end-to-end against real tag/Release creation. No new agent behavioral experiments were performed for this release.

## Limitations

- Source-only security review is not runtime penetration testing, deployment validation, or a guarantee that a project is secure. Runtime-dependent hypotheses remain unresolved until separately authorized validation.
- Skill instructions do not create an OS sandbox. Reports must distinguish instructional restrictions from technical controls actually verified on the host. Permitted source can contain incidental secrets; values must not be retained or disclosed.
- Windows CI uses a Windows Server runner, not Windows 11. It does not replace a Windows 11 validation pass or behavioral testing inside each agent product.
- GitHub tag and Release creation are separate, non-atomic operations. A failure may leave a tag without a Release, or an unknown mutation outcome. Recovery requires inspection and separate approval.
- Runner images and available tooling change over time. The manual release workflow does not bypass repository rulesets or token restrictions.

## Upgrade Notes

This is a backward-compatible MINOR release from v1.7.0. Existing core skill logic, installer behavior, adapters, routing, permissions, and hooks are unchanged by these additions; no optional module is installed by default.

Review the [full diff](https://github.com/valenticus/agent-kit/compare/v1.7.0...v1.8.0). Select `security-audit` explicitly through `-OptionalSkills security-audit` only when wanted. The installer refuses existing destinations: preserve project-owned modifications and follow the reviewed update process rather than forcing replacement. Keep the canonical shared skills and any Cline mirrors consistent.

For maintainers, VERSION and the current-version assertion now expect `1.8.0`. Publication remains a separate manual action after release-commit CI passes; preparing this commit does not create a tag or GitHub Release.
