# Promotion and update workflow

## Project to kit

Project change -> classify as UNIVERSAL, ADAPTABLE, or PROJECT-ONLY -> for universal/adaptable changes extract only reusable methodology -> update canonical kit sources -> validate adapters, links, leakage, and behavior -> increment version -> offer to future projects.

Never copy project identity, domain answers, vendor modifications, or one-off feedback into the kit automatically. PROJECT-ONLY changes remain in that project. Optional vendor modules are updated from upstream with license/provenance review, not promoted from project-local edits.

## Kit to an existing project

New kit version -> review release/diff against the project's current stack and hooks -> select only compatible relevant universal changes -> regenerate or merge selected adapters -> keep project hooks and rules untouched -> validate project behavior.

A fresh install creates `AGENTS.md` from the project-rules template when absent, and a normal install never overwrites an existing one. A newly introduced universal always-on policy reaches an existing project only through the explicit, standalone `install.ps1 -UpdatePolicies` step, which touches only the managed block in `AGENTS.md`, preserves everything else (including link targets, encoding, and file mode), and refuses on ambiguous markers or non-UTF-8 content.

There is no blind bidirectional sync. Existing project mirrors may be compared with their recorded canonical version, but changes require human-reviewed import. A newer kit version must never overwrite project-specific skills or hooks.

## Versioning

- PATCH: wording, bug fixes, validation fixes without intended contract change.
- MINOR: new skill/methodology or backward-compatible agent improvement.
- MAJOR: breaking layout, discovery, generated-file, or agent-contract change.
