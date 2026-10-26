# Upstream and adaptation record

- Upstream: https://github.com/cloudflare/security-audit-skill
- Reviewed commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- Adaptation version: `1.0.0`
- Distribution: adapted third-party optional module, not an unchanged upstream copy.
- License: MIT; the complete Cloudflare notice is preserved unchanged in LICENSE.

## Source mapping

All paths below are relative to `skills/security-audit/` at the reviewed commit.

| Upstream source | Used in this adaptation |
|---|---|
| `SKILL.md` | Boundary/result discipline, source visibility, no live probing, target read-only intent; rewritten for explicit activation and no execution |
| `RECONNAISSANCE.md` | Architecture/principal/control mapping; simplified coverage table in references/source-review.md |
| `HUNTING.md`, `ATTACK-CLASSES.md` | Source-to-sink reasoning and preventing-control checks; no orchestration or verbatim hunter prompts |
| `VALIDATION-AND-REPORTING.md`, `report-schema.json` | Distinct verdicts, evidence and uncertainty separation; rewritten Markdown contract in references/report-format.md |
| `DATA-ISOLATION-AND-LIFECYCLE.md`, `CLOUD-AND-DEPLOYMENT.md`, `SUPPLY-CHAIN-AND-RELEASE.md`, `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` | Selected static boundary questions; no complete companion catalog copied |

## Deliberate differences

1. Explicit user request naming `security-audit` is required. Installation and generic security tasks do not activate it. agents/openai.yaml disables implicit invocation for hosts supporting that Codex policy; other hosts rely on the description/body activation gate and their existing controls.
2. One sequential, bounded source-only pass replaces the six-phase audit. No subagents, delegation, critics, retries, background work, automatic prior-run loading, or follow-up waves.
3. No target execution, imports, builds, tests, package scripts, dependency installation, cloud/database MCP, network traffic, production API, or secret-value inspection.
4. `confirmed` means a full statically proven boundary violation, with `evidence_basis: source-only` and `runtime_validation: not_performed`. Unlike upstream, local observed execution and independent verification are not required or claimed. Runtime-dependent hypotheses remain `needs_validation`; severity belongs only to confirmed records.
5. A compact Markdown coverage table replaces deterministic combinatorial IDs, JSON ledgers, archived attempts, and fingerprints across runs. Reports default to chat; external files require a user-selected safe external destination.
6. Upstream report schema, both CLI validators, their tests, sandbox execution and artifact-promotion machinery are not distributed. In particular, the CLI readers require O_NOFOLLOW and O_NONBLOCK and have no native Windows fallback. This text-only module does not weaken or bypass those readers.
7. Safety constraints are instructions, not a sandbox implementation. Reports must distinguish them from verified host controls. Existing project rules and workflow ownership remain authoritative.

## Updates

Review a specific upstream commit manually, including its complete license and changes to evidence/safety semantics. Update this mapping, adaptation version, and catalog metadata together. Never replace this package blindly with the upstream workflow, install from a moving branch, or import project-local modifications automatically. Run local structural and disposable installer checks; agent behavior and isolation require separate evidence and are not proven by those checks.
