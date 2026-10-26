# Manual release process

The [Release Agent Kit workflow](../.github/workflows/release.yml) publishes stable releases only through manual `workflow_dispatch` on `main` in `valenticus/agent-kit`. Pushes and tags never trigger it, so merging release preparation to `main` never publishes by itself.

## Prepare and dispatch

1. Prepare a reviewed release commit on main: update VERSION and its current-version validation assertion together. Preserve historical version references. Add approved release notes at `docs/release-vMAJOR.MINOR.PATCH.md`, including scope, provenance, evidence, limitations, and update guidance. Keep notes directly under docs because the current kit validator expects files there. Notes are read as text, never executed.
2. Push normally and wait for the latest push-triggered Validate Agent Kit run for that exact commit to complete successfully on both macOS and Windows. Required validator steps must all pass. A previous SHA, PR merge run, older successful run, skipped step, pending attempt, or unknown API result is insufficient.
3. Open GitHub Actions -> Release Agent Kit -> Run workflow. Select main and provide `tag` (for example `v1.8.0`) and `release_sha` (the full lowercase 40-character current main SHA). The dispatch SHA must equal this SHA; if main advances, prepare a new dispatch after validating its new HEAD.
4. Inspect both preflight and release job results and the job summary. A successful publication reports the release URL, exact commit, and annotated tag object SHA. This workflow creates no commits and does not update VERSION.

## Gates and permissions

Workflow-level permissions are empty. Preflight receives only contents/read and actions/read. The release job receives contents/write and actions/read only after successful preflight. Both use GitHub-hosted Ubuntu and Python's standard library; there are no external actions, checkout, dependencies, artifacts, PATs, repository secrets, production APIs, deploys, or agent sessions. The standard ephemeral GITHUB_TOKEN is passed only to the API client, not logs.

The workflow checks repository/ref/event, exact dispatch SHA and current main HEAD, VERSION/tag equality, nonempty notes, absence of tag and Release, and a GitHub-associated human commit author with usable name/email. It preserves those human commit metadata as tagger identity, without inventing identities; this is not a claim of cryptographic signature verification. Ambiguous or agent/tool identities block publication.

Validation is located by `.github/workflows/validate.yml`, not display name. The newest exact-SHA push run on main and its current run_attempt must pass. Both expected matrix jobs and all six validators, environment preflight, and Git checks must succeed. API collections are paginated with a bounded limit; incomplete evidence blocks publication. The publishing job repeats these checks and requires the same evidence fingerprint (including notes and CI attempt) as preflight, then refreshes main and CI immediately before writing.

Annotated tag creation uses GitHub REST tag-object creation followed by create-only reference creation, then create-only Release creation with draft=false and prerelease=false. The workflow verifies tag-object -> commit and published Release -> tag. It never updates existing refs/releases, forces a write, or deletes tags. Repository rulesets or token restrictions may block publishing; this workflow does not change or bypass them.

## Races, failures, and recovery

One concurrency group serializes all releases with cancel-in-progress=false. It does not lock main, CI reruns, or writes by maintainers/other workflows. Exact SHA pinning prevents silently publishing a different commit; repeated checks narrow races but cannot provide an atomic transaction across GitHub endpoints.

Existing tags/releases block a new run even when they appear to match. Duplicate or concurrent create attempts fail without overwrite. There are no automatic POST retries: a timeout can mean the server accepted a write. The failure summary records the last attempted mutation and performs read-only reconciliation, then stops. Never interpret UNKNOWN as absent.

An annotated tag object may remain unreachable if reference creation fails. A visible tag may exist without a Release if publication fails. A Release may have been created even if its response or final verification failed. Do not rerun hoping to repair this, automatically delete the tag, or publish a replacement tag. Inspect the current tag object, peeled commit, Release, notes, and exact-SHA CI first; any completion or cleanup needs separate explicit approval. No recovery mode is included.

GitHub-created tag/release events using GITHUB_TOKEN generally do not trigger another workflow. This mechanism relies on already successful exact-commit validation and does not use tag creation to request CI. Windows CI uses a Windows Server runner and does not replace a Windows 11 validation pass. A source-only security audit is not runtime penetration testing or an OS-sandbox guarantee.
