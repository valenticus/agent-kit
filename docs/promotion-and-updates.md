# Promotion and update workflow

## Project to kit

Project change -> classify as UNIVERSAL, ADAPTABLE, or PROJECT-ONLY -> for universal/adaptable changes extract only reusable methodology -> update canonical kit sources -> validate adapters, links, leakage, and behavior -> increment version -> offer to future projects.

Never copy project identity, domain answers, vendor modifications, or one-off feedback into the kit automatically. PROJECT-ONLY changes remain in that project. Optional vendor modules are updated from upstream with license/provenance review, not promoted from project-local edits.

## Kit to an existing project

New kit version -> review release/diff against the project's current stack and hooks -> select only compatible relevant universal changes -> regenerate or merge selected adapters -> keep project hooks and rules untouched -> validate project behavior.

A fresh install creates `AGENTS.md` from the project-rules template when absent, and a normal install never overwrites an existing one. A newly introduced universal always-on policy reaches an existing project only through the explicit, standalone `install.ps1 -UpdatePolicies` step, which touches only the managed block in `AGENTS.md`, preserves everything else (including link targets, encoding, and file mode), and refuses on ambiguous markers or non-UTF-8 content.

There is no blind bidirectional sync. Existing project mirrors may be compared with their recorded canonical version, but changes require human-reviewed import. A newer kit version must never overwrite project-specific skills or hooks.

## Adapted security-audit updates

Review Cloudflare updates at an explicit commit, not a moving branch. Preserve the complete MIT notice and review source/evidence, execution, activation, and orchestration changes against the adapted contract. Update the package's UPSTREAM.md source mapping and differences, adaptation version, and optional catalog commit/version together. Never replace the adaptation with the six-phase upstream workflow or absorb project-local edits automatically.

Run the manual `validate-security-audit.mjs`, `validate-kit.mjs`, and disposable `validate-installer.mjs` checks after a package change; the installer suite requires PowerShell. Distribution checks establish copying and overwrite behavior, not agent compliance, OS isolation, or production security. Do not add behavioral sessions, automatic verification hooks, dependency fetching, or target execution as part of updating this package. Deployment to an existing consumer remains a separately approved installation with overwrite conflicts surfaced for review.

## Versioning

- PATCH: wording, bug fixes, validation fixes without intended contract change.
- MINOR: new skill/methodology or backward-compatible agent improvement.
- MAJOR: breaking layout, discovery, generated-file, or agent-contract change.
