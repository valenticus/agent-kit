# Agent Kit v1.10.0

## Highlights

A MINOR release that adds a safe way to update Agent Kit skills already installed in a project, and hardens every installer file operation against links that lead outside the project. Skills, managed policy blocks, templates, and the default skill selection are unchanged.

- **Skill catalog.** [`scripts/install/skill-catalog.json`](../scripts/install/skill-catalog.json) records every released version of the 13 distributed skills (core and vendored optional) as SHA-256 hashes after CRLF -> LF normalization, generated from release tags v1.0.0 through v1.9.1 plus this release.
- **Dry run.** `install.ps1 -ProjectRoot <project> -UpdateSkills -DryRun` lists each installed kit skill in `.agents/skills` and `.cline/skills` as current, update, or conflict, plus skipped and absent skills, and writes nothing.
- **Selective update.** `-UpdateSkills` updates every installed kit skill, or only those named with `-Skills` (core) and `-OptionalSkills` (vendored optional modules).
- **Apply and recover.** Updates are verified, staged, journaled, and swapped one skill at a time; `install.ps1 -ProjectRoot <project> -RecoverSkillUpdate` completes or reverts an interrupted update.
- **File-operation protection.** Installation, the Claude adapter, `-UpdatePolicies`, skill updates, and recovery never write outside the project through a symbolic link, junction, or other reparse point.

## Updating installed skills

- A skill is updated only when its files match a released Agent Kit version exactly (line endings aside). Edited, added, or missing files are a conflict, and any conflict or blocker in the selection stops the whole update with nothing changed; narrow the selection to update the rest. Updates never add skills and never touch project-owned skills.
- Each update re-plans and refuses a plan that changed, takes `.agent-kit-update.lock` in the project root, stages verified copies under `.agents/.agent-kit-update` or `.cline/.agent-kit-update`, writes a journal once, and replaces each skill with two renames. A failed second rename is reversed; transient Windows errors are retried a bounded number of times only while nothing changed.
- If an update is interrupted, each skill is left either in its previous or its new version, or with the previous version kept in staging. `-RecoverSkillUpdate` classifies every skill before changing anything, finishes or restores it, removes staged copies (including half-removed ones), and refuses with a diagnostic whenever it cannot prove what the leftovers are. Ordinary installs are refused while leftovers exist.
- `-UpdateSkills` and `-RecoverSkillUpdate` are standalone, need Node.js, and never commit or run Git commands.

## File-operation protection

- Skill updates and recovery re-check, immediately before every rename, deletion, directory or file creation, and staged-tree read, that each path component from the project root (`.agents` or `.cline`, `skills`, staging, `old`, `new`) is a real directory. Content checks run before these link checks, and after each restore recovery verifies that the skill arrived where expected; otherwise it stops without reporting success and keeps the lock and journal. Journals and locks are validated against the catalog; target paths are always derived from the project root.
- The installer refuses any symbolic link, junction, or reparse point on a destination path (`.agents`, `.cline`, `.github`, `.kilo`, and their subdirectories) before its first write. Skill names must be plain names (`^[a-z0-9]+(-[a-z0-9]+)*$`). `-ProjectRoot` is resolved literally, and every path passed to Node.js is quoted, because PowerShell on macOS and Linux expands wildcard characters such as `[1]` in native command arguments.
- The Claude adapter checks `.claude`, `.claude/agent-kit`, `.claude/settings.json`, its bootstrap copy, `.agents`, and `.agents/skills` in its preflight, before `install.ps1` copies any skill. `CLAUDE.md` and `.gitignore` may be links only to a regular file inside the project. `.gitignore` is never appended in place: its bytes are kept, the entry is added, and the file is replaced by rename with the same permissions, so a hard link to a file outside the project is unchanged.
- `-UpdatePolicies` updates a linked `AGENTS.md` only when its real target is a regular file inside the project; broken, circular, and outside links are refused.
- Broken `AGENTS.md` and `CLAUDE.md` links are refused instead of being silently skipped or failing after a partial install.

## Validation

The validators were extended with crash recovery at every step, forged journals and locks, links and junctions in every path component, concurrent processes, rename check ordering, redirected restores, installer containment through the real `install.ps1` with whole-fixture snapshots (external and internal links, hard links, broken links, literal `-ProjectRoot`, idempotent reruns), and Claude adapter and policy link cases. Each security fix was confirmed by reverting it and observing the corresponding test fail.

All six validators passed locally on macOS with PowerShell 7.6.8. [Validate Agent Kit](../.github/workflows/validate.yml) passed on macOS and Windows for the final fix commit `fd51045f1bcae79fda7e57387c3f84479244992c` ([run 40495466818](https://github.com/valenticus/agent-kit/actions/runs/40495466818)). The release-preparation commit must independently pass the exact-SHA validation workflow before publication.

Two independent security audits of the update and installer file operations preceded this release; their confirmed findings are fixed in this release.

## Limitations

- **Concurrent path swaps.** Node.js has no `openat`, `renameat`, or `O_NOFOLLOW` for directories, so a process that swaps a directory for a link in the instant between a check and a rename is not excluded. In a local stress test, a process doing this in a tight loop redirected about 1 in 1,000 restores; no deletion outside the project was observed, and recovery reports a redirected restore instead of success. Run `-UpdateSkills` and `-RecoverSkillUpdate` only while no other agent, `git checkout`, synchronizer, or other process is changing the project. The maintainer accepted this residual risk for release under that condition.
- Updates do not force data to disk (`fsync`); after a power loss recovery refuses what it cannot prove. A temporary lock file left by a crash at the very start of an update (`.agent-kit-update.lock.<operation>.tmp`) is not removed automatically. Each skill is replaced on its own; an update is not atomic across skills.
- Windows CI uses a Windows Server runner with PowerShell 7. Windows 11, Windows PowerShell 5.1, and OneDrive Files On-Demand placeholders (which may carry the reparse-point attribute and be refused) are not validated. File symlink cases run only on macOS CI.

## Upgrade Notes

Backward-compatible for ordinary projects; installer arguments and defaults are unchanged and the new switches are opt-in. Behavior that is now stricter:

- `install.ps1` refuses a destination path that passes through any link, junction, or reparse point, including one that stays inside the project; earlier versions followed links to existing directories. Replace such links with real directories.
- The Claude adapter refuses links at `.claude`, `.claude/agent-kit`, `.claude/settings.json`, `.agents`, and `.agents/skills`, and `CLAUDE.md` or `.gitignore` links that leave the project.
- `-UpdatePolicies` refuses an `AGENTS.md` link that leaves the project; earlier versions updated its target wherever it was.
- A `.gitignore` that was hard-linked to another file becomes a separate file when the Claude adapter adds its entry.

Projects installed with earlier versions can run `install.ps1 -ProjectRoot <project> -UpdateSkills -DryRun` to see which skills would be updated. Review the [full diff](https://github.com/valenticus/agent-kit/compare/v1.9.1...v1.10.0). For maintainers, VERSION and the current-version assertion now expect `1.10.0`, and the skill catalog records this release. Publication remains a separate manual action after release-commit CI passes; preparing this commit does not create a tag or GitHub Release.
