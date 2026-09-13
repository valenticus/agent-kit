# Project instructions

Fill this from the current project's verified requirements and implementation. Keep detailed product, UI, architecture, data, and security knowledge in their project hooks; use this file for routing, precedence, permissions, context loading, and always-on repository constraints.

## Communication language

- Respond to the user in Ukrainian by default.
- Keep code, identifiers, file paths, shell commands, commit messages, API names, configuration keys, and quoted source text in their original or technically appropriate language.
- Use another language only when the user explicitly requests it or when the task requires exact-language output.

Default to one primary skill for the requested outcome. Add a companion only for a distinct material risk, boundary, or required deliverable. One may be added with clear justification; each beyond that requires a distinct named reason. Security or irreversible data-integrity requirements may exceed this budget. Do not stack overlapping workflows for reassurance; load another skill later if investigation discovers a new boundary. Pure reading or explanation does not automatically require an implementation skill.

Discover context nearest-first: this file, the primary skill, any mandatory justified companion, the nearest relevant project or module documentation, and only references required by the active task. Nearby documents cannot silently override higher-level project rules. Avoid preloading documentation trees and large static maps; add explicit pointers only for exceptional authoritative documents.

Canonical workflow owners are `safe-change` for minimal scope and proportional verification, `debugging` for reproduction and root-cause tracing, `security` for authority and data-integrity boundaries, `ui` for visual implementation and accessibility, and `final-audit` for broad release/readiness review. Other skills contain only local consequences and pointers to these owners, not copies of their general checklists.

## Agent routing baseline

Choose Codex, Cline, Kilo, or Copilot based on scope, complexity, dependencies, risk, validated capability, and available allowance. Agent selection remains separate from skill routing. Project-specific instructions may narrow or override this baseline.

- Use Codex for complex, high-risk, architecture, backend, security, or refactor-heavy work.
- Use Cline for medium-scope implementation and focused multi-file changes.
- Use Kilo for small, localized, low-risk work and validated tool-specific roles.
- Use Copilot primarily for independent repository audits and second-opinion reviews when its allowance is available.
- Copilot is validated for evidence-based read-only audits, including running non-mutating tests and lint checks when permitted by the project.
- Copilot may receive explicitly assigned experimental implementation tasks only when they are small, localized, reversible, and low risk. Require a clean starting state, minimal diff, relevant tests/checks, and final diff review. Do not use this experimental scope for architecture, security, authentication, authorization, database/RLS/migrations, sensitive data flows, broad refactors, dependency changes, deployment, or unattended commit/push. Expand Copilot's implementation role only after controlled coding tests justify an explicit routing update.

- Project purpose and scope:
- Instruction source-of-truth hierarchy:
- Stack/directory summary:
- Change discipline and user-owned work policy:
- Required skill routing:
- Agent routing overrides or restrictions:
- Verification commands:
- Git, dependency, external-action, and destructive-action permissions:
- Exceptional authoritative documentation pointers, if any:

Previous projects are methodology references only, never visual or product templates.
