# Agent Kit repository instructions

This file contains the active repository-level instructions for developing Agent Kit itself. `templates/project-rules/AGENTS.md` is the canonical consumer-project template; merge or adapt that template in consumer projects rather than treating it as this repository's active instructions.

## Communication language

- Respond to the user in Ukrainian by default.
- Keep code, identifiers, file paths, shell commands, commit messages, API names, configuration keys, and quoted source text in their original or technically appropriate language.
- Use another language only when the user explicitly requests it or when the task requires exact-language output.

## Repository discipline

- Preserve the canonical-source and clean-room boundaries documented in this repository. Do not copy project-specific or license-incompatible material into universal methodology.
- Preserve the one-primary-skill routing architecture. Keep reusable workflow rules with their canonical owner instead of duplicating detailed guidance across skills or adapters.
- Keep consumer-project rules in `templates/project-rules/AGENTS.md`; add a rule here only when it is always applicable to development of Agent Kit itself.
- Make the smallest coherent change and run validation proportional to its scope. Preserve unrelated user changes.
- Do not commit, push, tag, publish, or release unless the user explicitly requests it.
