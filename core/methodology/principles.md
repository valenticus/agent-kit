# Shared methodology

- Read the current project's instructions and inspect actual implementation before deciding.
- Treat existing user changes as owned; make the smallest coherent change and preserve authorization boundaries.
- Resolve conflicts by this order: user request, current project rules, executable implementation/tests, applicable skill, general methodology.
- Keep project identity in project hooks. Previous projects are methodology references only, never visual or product templates.
- Use progressive disclosure in this order: root project instructions, one primary skill, a justified companion when required, the nearest relevant project or module documentation, then only task-required references. Nearby documentation cannot override higher-level project rules. Do not preload documentation trees or maintain large static maps; reserve explicit pointers for exceptional authoritative documents.
- Select exactly one primary skill for the requested outcome. Add a companion only for a distinct material risk, boundary, or required deliverable. One may be added with clear justification; each beyond that requires a distinct named reason. Security or irreversible data-integrity requirements may exceed this budget. Do not stack overlapping workflows for reassurance, and load another skill later only when investigation discovers a new boundary. Pure reading or explanation does not automatically require an implementation skill.
- Verification must be proportional to risk and must include review of the final diff for implementation work.
- Support each material success claim with evidence that remains valid for that claim. Rerun only checks that later changes may have invalidated, and identify stale, manual, external, or unrun checks as such instead of presenting them as current automated evidence.
- Stop when the requested outcome is delivered, authority is missing, project sources conflict materially, or safe verification cannot proceed.

## Canonical rule ownership

Root project instructions own routing, instruction precedence, permissions, context loading, and always-on repository constraints. Canonical skills own their reusable workflows: `safe-change` owns minimal scope and proportional verification; `debugging` owns reproduction and root-cause tracing; `security` owns authorization, ownership, sensitive mutations, and data-integrity boundaries; `ui` owns visual implementation, interaction, and accessibility; and `final-audit` owns broad release/readiness review. Other skills state only their local consequence and point to the owner instead of duplicating its general checklist.
