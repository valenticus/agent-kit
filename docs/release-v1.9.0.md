# Agent Kit v1.9.0 — Agent Reliability

## Highlights

- Managed `AGENTS.md` policy blocks generalized from the single Git-authorship block to any number of named policies, with full backward compatibility.
- New managed Destructive Operations policy: effect-based, per-operation approval for irreversible, history-rewriting, database, infrastructure, and production actions.
- New managed Multi-Agent policy: one writer per working tree, separate worktrees for parallel writers, and explicit approval before extra agents or sessions.
- New opt-in `handoff` skill for preparing and resuming verifiable handoffs of unfinished work between sessions and agents.
- No new dependencies, hooks, background processes, permissions, CI jobs, or default skills.

## Managed policy blocks

[`policy-block.mjs`](../scripts/install/policy-block.mjs) now manages every `<!-- agent-kit:<policy>:start/end -->` block found in [`templates/project-rules/AGENTS.md`](../templates/project-rules/AGENTS.md); the template defines the policy set and its order, so adding a policy needs no installer change. The template now carries three blocks in this order: Git authorship, destructive operations, and multiple agents. This repository's root `AGENTS.md` carries identical blocks, and `validate-kit.mjs` enforces parity for each.

`install.ps1 -UpdatePolicies` remains the only path that changes an existing `AGENTS.md`. It replaces stale blocks in place and inserts a missing block right after the nearest present managed block (otherwise before the next one, otherwise at the end of the file), keeping template order. Every block is checked before planning: malformed, duplicate, reversed, or overlapping markers in any block refuse the whole update with no write, and the existing single temporary-file-and-rename write is unchanged. Markers of policies absent from the template are ordinary project text.

Backward compatibility:

- The Git-authorship block, its markers, placement, messages, and existing module exports are unchanged. Before adding new policies, a differential comparison of the previous and generalized implementations over 7,215 generated inputs found no difference in actions, content, or refusal messages, including 3,328 refusals.
- A v1.8.0 project, whether created from the template or upgraded with `-UpdatePolicies`, gains only the two new blocks right after its Git-authorship block. Project sections, LF/CRLF line endings, and a UTF-8 BOM are preserved byte for byte, and a second run is a no-op. The same holds for projects with any shorter prefix of the current policy set.
- A normal install still never modifies an existing `AGENTS.md`. `validate-install.mjs` now warns per policy when a block is missing or stale.

## Destructive Operations Policy

The `destructive-operations` block judges risk by an operation's effect rather than its command, tool, MCP server, script, or language; wrappers, aliases, generated scripts, SDKs, and API calls with the same effect need the same approval.

Explicit user approval is required before each operation that can irreversibly delete or overwrite data; discard uncommitted Git work; force-push, rewrite published history, or delete branches or tags; bulk-modify, purge, or truncate database data, or reset, roll back, or repair migrations; remove containers, volumes, or infrastructure resources; write to production, deploy, or change secrets, credentials, or access settings; or run potentially expensive or sensitive production reads such as log queries, large selections, bulk exports, or quota-consuming calls.

The request must name the target, scope, likely consequences, reversibility, and recovery path, preferring a backup, snapshot, branch, or dry run. Approval covers only that operation on that target within the current task. Ordinary approved work needs no extra approval: local reads, read-only Git, local tests and builds, in-scope edits, new files, and clearly identified temporary artifacts. Production is read-only by default, which does not permit unbounded or sensitive reads.

Project templates gained short fields for forbidden operations, production projects and environments (for example Supabase project refs or Cloudflare accounts, zones, and Workers), platform restrictions, quotas, rate limits, and paid APIs, and backup and recovery steps before destructive data or migration changes.

## Multi-Agent Isolation

The `multi-agent` block (846 bytes) allows one agent with write access per working tree; parallel writers each use a separate Git worktree and branch. Additional agents, subagents, and parallel sessions start only after explicit user approval naming their number, tool, read or write mode, and scope, and costly parallel sessions never start automatically. Approved read-only agents may share a working tree while they change no files. Agents check the working tree before starting and before writing, stop and report unexpected changes, and integrate another worktree's changes only after diff review and user approval.

## Session Handoff

[`handoff`](../core/skills/handoff/SKILL.md) is an opt-in core skill, installed only with `-Skills handoff` and not part of the default selection. It is plain Markdown with no runtime.

- Prepare records the goal and constraints, completed work split into verified facts and assumptions, Git HEAD, branch, `git status --short`, and `git diff --stat`, changed files, check results and unrun or stale checks, blockers, and next actions. It excludes secrets, private data, full diffs, and large logs.
- Resume treats the handoff as claims to verify: it re-checks HEAD, branch, and the working tree, stops and reports any mismatch, and treats earlier checks as unverified until rerun.
- Output stays in chat by default; a file is written only at a new path the user names, never overwritten or committed. The skill never clears context, commits, stashes, resets, pushes, starts other agents, or changes the working tree.

A deferred `handoff-fidelity` scenario was added to the behavioral-testing catalog; no behavioral runs were performed.

## Windows and macOS

All changes are Markdown and the existing Node.js policy module; the PowerShell installer arguments are unchanged. Policy updates preserve LF or CRLF line endings, a UTF-8 BOM, link targets, and file mode as before. The installer suite exercises `-UpdatePolicies` and `-Skills handoff` through real `pwsh` on both CI runners; locally it was also run on macOS with PowerShell 7.6.8. The Claude adapter exposes `handoff` through its existing junction (Windows) or symlink (macOS).

## Validation

The six existing validators were extended without new CI jobs: canonical parity and required content for each policy block, absence of absolute-safety or complete-isolation claims, a 1 KiB limit for the multi-agent block, multi-block placement and all-or-nothing refusal, upgrades from v1.8.0 and earlier policy sets with CRLF/BOM and idempotency, the handoff skill's required content, and explicit `-Skills handoff` installation for all five tools through the real PowerShell installer with an unchanged default selection.

[Validate Agent Kit](../.github/workflows/validate.yml) passed on both macOS and Windows for each feature commit, most recently [run 40334266510](https://github.com/valenticus/agent-kit/actions/runs/40334266510) for commit `65a1d968bf9964f30c019dd1abe14fb236382c49`. The release-preparation commit must independently pass the exact-SHA validation workflow before publication. No agent behavioral experiments were performed for this release.

## Limitations

- The destructive-operations and multi-agent policies are instructions, not technical controls. They do not block commands and cannot guarantee that no damage occurs; enforcement depends on each tool's own permissions and sandboxing, which Agent Kit does not configure automatically.
- Git worktrees separate files only. They share refs and object storage, and they do not isolate production services, databases, or other external resources. There are no lock files: concurrent writers are detected only by agents checking the working tree.
- A handoff is a summary of claims. It cannot capture every detail of a session, and its correctness depends on the preparing agent; Resume reduces but does not remove that risk.
- New always-on text increases every session's instruction context: about 2.3 KB for destructive operations and 0.8 KB for multiple agents.
- Windows CI uses a Windows Server runner, not Windows 11. It does not replace a Windows 11 validation pass or behavioral testing inside each agent product.

## Upgrade Notes

This is a backward-compatible MINOR release from v1.8.0. Default skill selection, adapters, routing, and installer arguments are unchanged.

Review the [full diff](https://github.com/valenticus/agent-kit/compare/v1.8.0...v1.9.0). Existing projects receive the new managed policies only by running `install.ps1 -ProjectRoot <project> -UpdatePolicies`; review the inserted blocks and complete the new project-template fields from verified project facts. Install `handoff` explicitly with `-Skills handoff` when wanted; the installer refuses existing destinations.

For maintainers, VERSION and the current-version assertion now expect `1.9.0`. Publication remains a separate manual action after release-commit CI passes; preparing this commit does not create a tag or GitHub Release.
