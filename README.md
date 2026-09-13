# Universal Agent Kit

Reusable, project-neutral agent methodology for Codex, Cline, Kilo, and Copilot. The kit separates original universal methodology, optional stack/vendor modules, and project-owned skills.

> Previous projects are methodology references only, never visual or product templates.

New projects must define their own UI, product, architecture, data, security, and repository rules from their requirements and existing implementation. The kit deliberately contains no inherited brand or domain model.

## Start a project

1. Open the target project and inspect existing agent files and working-tree changes.
2. Copy `templates/bootstrap-prompt.md` into a Codex request and replace the placeholders.
3. Let Codex propose relevant core skills, optional stack/vendor skills, and project hooks separately; the user/project setup decides what to install.
4. Run `powershell -NoProfile -ExecutionPolicy Bypass -File <kit>/scripts/install/install.ps1 -ProjectRoot <project> -Tools codex,cline,kilo -Skills safe-change,debugging -OptionalSkills web-design-guidelines` with only the approved selections. The process-scoped execution-policy flag is useful on Windows hosts that block local scripts; it does not change the machine policy.
5. Complete the generated project hooks and merge them into the project's instruction system.
6. Run `node <kit>/scripts/validation/validate-kit.mjs` and `node <kit>/scripts/validation/validate-install.mjs <project>`.

Installation is an explicit, one-shot operation. It does not start agents, loops, commits, dependency installation, or synchronization.

## Canonical source-of-truth model

```text
Agent Kit canonical core/optional source
  -> reviewed installation in project .agents/skills
  -> validated Cline mirrors in project .cline/skills

Kilo -> shared project .agents/skills where supported
     -> only Kilo-specific agents/config in .kilo
```

There is no `.kilo/skills` mirror. Genuinely tool-specific agents, permissions, and configuration remain in their native adapter directories. Project-specific hooks are authored in the target project and are never overwritten by kit updates.

See `docs/architecture.md`, `docs/source-inventory.md`, `docs/promotion-and-updates.md`, and `docs/attribution.md`.
