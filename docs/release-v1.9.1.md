# Agent Kit v1.9.1

## Highlights

A PATCH release that fixes defects confirmed by a technical audit of v1.9.0. Policy contracts, managed policy blocks, the `handoff` skill, installer arguments, default skill selection, and agent behavior are unchanged.

- `validate-install.mjs` now detects a Cline mirror that lacks a kit skill.
- All six kit validators pass in an ordinary local macOS environment without manual setup.
- The Claude adapter keeps a UTF-8 BOM in `.claude/settings.json` and writes it through a safe temporary file.
- Policy updates never delete an existing file that happens to share the temporary file name.
- Documentation for updating existing projects, kit validation, safe marker examples, and component origins.

## Fixes

- **Cline mirror validation (V1).** When `.cline/skills` exists, [`validate-install.mjs`](../scripts/validation/validate-install.mjs) requires every kit-distributed skill (core or vendored optional) present in `.agents/skills` to be mirrored. Previously it checked only skills already in the mirror, so a skill added without `-Tools cline` passed while Cline could not see it. Project-owned and referenced skills remain exempt. The error names the missing skills and the `-Tools cline` remedy.
- **Local macOS validation (V2).** [`validate-claude.mjs`](../scripts/validation/validate-claude.mjs) uses a canonical temporary directory, so its mocked Windows junction check no longer fails where the system temp path is a link (macOS `/var` to `/private/var`); the bootstrap's own link verification is unchanged. [`validate-installer.mjs`](../scripts/validation/validate-installer.mjs) pins PowerShell to its absolute path before simulating a PATH without Node.js, so a shared `node`/`pwsh` directory (as installed by MacPorts) no longer hides PowerShell. The node-free check still runs without Node.js.
- **Claude settings BOM (S1).** Merging the SessionStart hook into an existing `.claude/settings.json` now keeps its UTF-8 BOM, alongside the existing preservation of keys, indentation, and line endings. A file without a BOM does not gain one, and re-installs stay byte-identical.
- **Claude settings temporary file (S2).** The merged settings are written to a uniquely named temporary file beside `settings.json`, created exclusively so it never replaces another file, then renamed into place. The temporary file is removed on failure only if this install created it; a failed write or rename leaves the original `settings.json` unchanged. A `settings.json.agent-kit-tmp` left by earlier versions is never touched.
- **Policy update temporary file.** `install.ps1 -UpdatePolicies` ([`policy-block.mjs`](../scripts/install/policy-block.mjs)) created its temporary file exclusively but removed the temporary path unconditionally on failure, so an existing file of the same name could be deleted after an `EEXIST` error. It now removes the file only when the update created it.

Each fix has a regression test, and each new test was confirmed to fail against the previous code.

## Documentation

- README: a new "Update an existing project" section covers `-UpdatePolicies`, adding skills to installed projects (which tools to pass, and which existing destinations the installer refuses), manual update or removal of skills and adapter files, and safe ways to show managed-policy markers in documentation. A new "Validate the kit" section lists all six validators and their Node.js and PowerShell needs.
- [Claude adapter](../adapters/claude/README.md): the incomplete state left by an unexpected write error during installation is inert, `validate-install.mjs` reports it, and `install.ps1 -Tools claude -NoSkills` completes it without overwriting anything.
- [Source inventory](source-inventory.md) and [attribution](attribution.md) record the origin of the v1.9.0 components: written for Agent Kit, with the need identified during a review of a third-party repository whose license could not be established; no code or text from it was used.
- The behavioral-testing catalog gains deferred `destructive-operations` and `parallel-writer` scenarios. No behavioral runs were performed.
- [Release process](releasing.md) wording no longer refers to v1.8.0.

## Validation

All six validators passed locally on macOS with PowerShell 7.6.8 in the default environment, including real `pwsh` runs of `install.ps1`. [Validate Agent Kit](../.github/workflows/validate.yml) passed on macOS and Windows for both fix commits: [run 40381904506](https://github.com/valenticus/agent-kit/actions/runs/40381904506) for `472f36e06f2104019c43fc01cdf81e0c26fefbb1` and [run 40383360652](https://github.com/valenticus/agent-kit/actions/runs/40383360652) for `553785e9cf504cd13b86963ea8dda955c9d01b9b`. The release-preparation commit must independently pass the exact-SHA validation workflow before publication.

## Limitations

- The Claude adapter install is not atomic across files: an unexpected write error can leave the bootstrap copy without the settings hook. That state is inert and recoverable as described above, but it is not rolled back automatically.
- Installed skills are still not updated by the installer; see the README for the manual procedure. A dedicated update mechanism is planned separately.
- The open policy and handoff refinements from the v1.9.0 audit are not part of this patch.
- Windows CI uses a Windows Server runner, not Windows 11, and covers PowerShell 7 only. Windows PowerShell 5.1 and behavior inside each agent product are not validated by CI.

## Upgrade Notes

This is a backward-compatible PATCH release from v1.9.0. No managed policy block, skill, template, or installer argument changed, so existing projects need no update; running `validate-install.mjs` may newly report an incomplete Cline mirror, which `install.ps1 -Tools cline -Skills <names>` fixes.

Review the [full diff](https://github.com/valenticus/agent-kit/compare/v1.9.0...v1.9.1). For maintainers, VERSION and the current-version assertion now expect `1.9.1`. Publication remains a separate manual action after release-commit CI passes; preparing this commit does not create a tag or GitHub Release.
