# Source-only report contract

This adaptation deliberately changes Cloudflare's confirmation contract: `confirmed` means statically proven, not locally executed or independently verified. State this distinction in every report.

## Verdicts

- `confirmed`: a complete source trace proves a concrete trust-boundary violation. Identify the lower-trust principal, controllable input/action, intended control, affected principal/resource, and consequence. Check the strongest source-visible preventing controls. Every decisive premise must be established from permitted source; if runtime, framework behavior, active configuration, or deployment reachability is decisive and unknown, use `needs_validation` instead. Include `evidence_basis: source-only` and `runtime_validation: not_performed` on every confirmed record. Severity is allowed only here and must follow proven impact and stated conditions, without implying an observed runtime result.
- `needs_validation`: a specific source-grounded boundary hypothesis has an exact unresolved fact. Include the supporting source, blocker, assumptions, and what evidence would resolve it. Do not assign severity or invent execution results. A validation recommendation is a handoff for a separate authorized task, not a command to run now or probe production.
- `rejected`: concrete source evidence refutes the candidate. Cite the preventing control, impossible prerequisite, or failed trace and explain why. Lack of time or evidence is not rejection. No severity.

Missing best practices and defense-in-depth suggestions without a proven boundary failure are separate hardening notes, not confirmed vulnerabilities. Do not fill a clean report with speculative findings.

## Report structure

1. **Scope and limits:** target identifier, available revision/dirty state (or unknown), paths in scope, exclusions, source-only/offline policy, actual technical controls versus instructional constraints, and stopping reason. State that target code/tests/builds were not run and deployment/runtime behavior was not validated.
2. **Architecture:** compact component/principal/resource map and source-visible trust boundaries.
3. **Coverage:** the table from source-review.md, with explicit partial, blocked, unreviewed, and out-of-scope areas.
4. **Confirmed findings:** ordered by justified severity, or an explicit zero. For each: stable ID, title, verdict, required evidence markers, linked coverage IDs, repository-relative `file:line` evidence, ordered source trace, intended invariant, established consequence, conditions, assumptions (none may be decisive and unproven), severity rationale, and smallest suggested source correction. Describe the invariant to fix without editing code.
5. **Needs validation:** IDs, source evidence, exact unresolved facts, and a safe evidence handoff. Keep these leads separate from confirmed findings and without severity.
6. **Rejected candidates:** IDs, specific refuting source locations, and reasons. Do not present these as vulnerabilities.
7. **Residual risk and hardening:** material gaps, source-only limitations, and optional suggestions. No complete-coverage, production-safety, or runtime-success claim.

Use concrete repository-relative locations and minimal non-secret excerpts. Do not include credentials, raw payload dumps, environment dumps, or entire source files. Unknown facts stay unknown. A source line number supports inspection; it does not prove deployed behavior.

No separate JSON output, report-schema execution, report-validation loop, or independent verifier is required. Return the finished report and stop.
