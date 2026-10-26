# Universal Agent Kit

Reusable, project-neutral agent methodology for Codex, Cline, Kilo, Copilot, and (opt-in) Claude Code. The kit separates original universal methodology, optional stack/vendor modules, and project-owned skills.

> Previous projects are methodology references only, never visual or product templates.

New projects must define their own UI, product, architecture, data, security, and repository rules from their requirements and existing implementation. The kit deliberately contains no inherited brand or domain model.

## Start a project

1. Open the target project and inspect existing agent files and working-tree changes.
2. Copy `templates/bootstrap-prompt.md` into a Codex request and replace the placeholders.
3. Let Codex propose relevant core skills, opt-in core capabilities, optional stack/vendor skills, and project hooks separately; the user/project setup decides what to install. `data-visualization` is an opt-in core skill for chart selection, analytical encoding, visualization composition, interaction, responsive transformation, and truthfulness review.
4. Run `powershell -NoProfile -ExecutionPolicy Bypass -File <kit>/scripts/install/install.ps1 -ProjectRoot <project> -Tools codex,cline,kilo,copilot,claude -Skills safe-change,debugging -OptionalSkills web-design-guidelines` with only the approved selections. Add `claude` to `-Tools` only for Claude Code (see `adapters/claude/README.md`). Add `-CopilotAuditor` only when the optional read-only Copilot audit profile is wanted. The process-scoped execution-policy flag is useful on Windows hosts that block local scripts; it does not change the machine policy.
5. Complete the generated project hooks and merge them into the project's instruction system. If the installer created `AGENTS.md` from the template, fill its placeholders in place; if the project already had one, merge project-specific rules into it. Never create a second root `AGENTS.md`, and leave the managed policy blocks as installed.
6. Run `node <kit>/scripts/validation/validate-kit.mjs`, `node <kit>/scripts/validation/validate-installer.mjs`, `node <kit>/scripts/validation/validate-claude.mjs`, `node <kit>/scripts/validation/validate-policy.mjs`, and `node <kit>/scripts/validation/validate-install.mjs <project>`.

The installer checks every destination before writing anything and refuses to overwrite, so a conflict never leaves a partial installation. Use `-NoSkills` (instead of `-Skills`) to run an invocation that copies no skills, for example `-Tools claude -NoSkills` to add Claude to a project whose `.agents/skills` already exists.

A new project also receives a root `AGENTS.md` from `templates/project-rules/AGENTS.md` when it has none; an existing `AGENTS.md` is never modified by a normal install. Always-on universal policies (currently Git authorship) live in that template inside marker-delimited managed blocks, so every agent that reads `AGENTS.md` inherits them without per-adapter copies. Existing projects receive a newer block only through the explicit, standalone `install.ps1 -ProjectRoot <project> -UpdatePolicies`: it appends or replaces only the managed block, preserves everything else, is idempotent, and refuses (changing nothing) on malformed or duplicate markers. `validate-install.mjs` warns when a project lacks the current block.

Installation is an explicit, one-shot operation. It does not start agents, loops, commits, dependency installation, or synchronization.

The default `-Skills` selection stays compact. Install `data-visualization` explicitly with `-Skills data-visualization` or include it in a comma-separated core skill selection when visualization decisions are material.

`security-audit` is an adapted optional Cloudflare module, selected only with `-OptionalSkills security-audit`. Installation does not run an audit. On an existing project, use `-Skills @()` from a PowerShell session when adding only this optional module; `-NoSkills` cannot be combined with `-OptionalSkills`. The installer refuses existing destinations, so select tools whose adapter destinations are free rather than reinstalling existing adapters.

Activate it only by explicitly asking to use `security-audit`, for example: "Use security-audit for a source-only review of src/api; report in chat." It performs one sequential offline source pass without target execution, secret-value inspection, subagents, cloud/database MCP, or production access. Reports default to chat; a file requires an explicitly selected safe directory outside the target repository. Its `confirmed` verdict means statically proven and always carries `evidence_basis: source-only` and `runtime_validation: not_performed`; runtime-dependent leads remain `needs_validation`. These instructions do not establish an OS sandbox. Existing core workflows and permissions remain unchanged. See [provenance and differences](optional/vendored/security-audit/UPSTREAM.md).

Maintainers can run `node scripts/validation/validate-security-audit.mjs --fixtures` for local package/provenance and disposable copy/mirror checks and `node scripts/validation/validate-installer.mjs` for real disposable installation checks (requires `powershell` or `pwsh`). Copy fixtures do not substitute for the PowerShell installer suite. These checks do not run agents or establish behavioral compliance.

## Cross-platform CI

[Validate Agent Kit](.github/workflows/validate.yml) runs on pushes to `main`, pull requests targeting `main`, and manual dispatch. Both `windows-latest` and `macos-latest` use Node.js 24 and PowerShell 7 with a 15-minute job limit. Each validator runs separately: `validate-security-audit.mjs --fixtures`, `validate-kit.mjs`, `validate-policy.mjs`, `validate-claude.mjs`, `validate-data-visualization.mjs`, and `validate-installer.mjs`. Git checks verify whitespace and that tests leave the checkout clean.

The suites use disposable fixtures for default/explicit optional installation, Cline mirror parity, overwrite refusal, native Windows junctions, and macOS symlinks. No agent sessions, repository secrets, package installation/cache, global Agent Kit installation, deployment, publishing, or artifact uploads are involved. Checkout and Node setup require network access. `windows-latest` is a Windows Server runner, so CI does not replace a Windows 11 validation pass. Local equivalents are the same `node scripts/validation/<script>` commands; the installer suite requires `pwsh` (preferred) or `powershell`. macOS CI resolves its temporary directory to a canonical path before fixture tests.

Stable GitHub Releases use a separate explicitly dispatched workflow with exact-commit CI gates and create-only publication. See the [manual release process](docs/releasing.md); adding the workflow does not publish a release.

## Canonical source-of-truth model

```text
Agent Kit canonical core/optional source
  -> reviewed installation in project .agents/skills
       -> Codex / Kilo / Copilot
  -> validated Cline mirrors in project .cline/skills
  -> Claude Code: CLAUDE.md (@AGENTS.md) + generated, git-ignored .claude/skills link to .agents/skills
```

There is no `.kilo/skills` mirror. Genuinely tool-specific agents, permissions, and configuration remain in their native adapter directories. Project-specific hooks are authored in the target project and are never overwritten by kit updates.

Claude Code support is opt-in and adds no second skill tree: a small bridge, one `SessionStart` hook, and a generated link (Windows junction, POSIX relative symlink) to the canonical `.agents/skills`.

Copilot is a first-class supported execution environment and shares `.agents/skills` without another skill copy. Its currently validated and preferred role is independent read-only repository audit and second-opinion review; a coding role remains pending controlled project validation.

See `docs/architecture.md`, `docs/source-inventory.md`, `docs/promotion-and-updates.md`, and `docs/attribution.md`. Maintainer-only guidance for evidence-based behavioral checks of instruction changes is in [`core/methodology/behavioral-testing.md`](core/methodology/behavioral-testing.md).
