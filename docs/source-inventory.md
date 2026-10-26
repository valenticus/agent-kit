# Source inventory and classification

Inventory derived from the source repository before extraction.

| Source | System | Purpose | Canonical/mirror | Classification | Dependencies |
|---|---|---|---|---|---|
| `AGENTS.md` | Codex/shared | Root project rules and skill routing | canonical project rules | adaptable + project-only | product docs, framework-local docs |
| `CLAUDE.md` | Cline-compatible | Imports shared root instructions | adapter | universal mechanism | `AGENTS.md` |
| `.agents/skills/spilno-*` | Codex/shared | Eight task workflows | canonical | adaptable | project rules/hooks |
| `.cline/skills/spilno-*` | Cline | Byte mirrors of eight skills | generated mirror | adaptable | `.agents/skills` |
| `scripts/check-skill-sync.mjs` | validation | Frontmatter, set, and byte-sync checks | canonical script | universal mechanism | Node.js |
| `.agents/skills/supabase-postgres-best-practices` | vendor | Database guidance | canonical-only vendor | universal optional | Supabase, MIT |
| `.agents/skills/vercel-react-best-practices` | vendor | React/Next performance guidance | canonical-only vendor | universal optional | Vercel, MIT |
| `.agents/skills/web-design-guidelines` | vendor | UI review checklist | canonical-only vendor | universal optional | Vercel Labs, MIT |
| `.kilo/kilo.jsonc` | Kilo | Permissions and agent overrides | tool-specific | adaptable | exact Kilo version |
| `.kilo/agents/spilno-designer.md` | Kilo | Read-only design agent | tool-specific | adaptable + project-only identity | project UI/product skills |
| `.kilo/package*.json`, `.kilo/.gitignore` | Kilo | Local plugin runtime metadata/ignores | tool-specific | project/tool-specific | Kilo plugin package |
| `.github/copilot-instructions.md` | Copilot | Small bridge to canonical project instructions and shared skill discovery | adapter | universal mechanism | `AGENTS.md`, `.agents/skills` |
| `.github/agents/project-auditor.agent.md` | Copilot | Optional read-only audit profile | tool-specific adapter | adaptable | `AGENTS.md`, relevant shared skills |
| `docs/PROJECT_RULES.md`, `docs/DESIGN_SYSTEM.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md` | shared | Product/UI/architecture/data sources | project canonical | project-only | application implementation |

Current Agent Kit additions that were independently authored after the initial source extraction:

| Source | System | Purpose | Canonical/mirror | Classification | Dependencies |
|---|---|---|---|---|---|
| `core/skills/data-visualization` | shared | Question-first visualization decisions, truthfulness, composition, interaction, responsive behavior, accessibility, and QA | canonical opt-in core | original universal | project data semantics and UI realization |
| `core/skills/handoff` | shared | Prepare and resume verifiable handoffs of unfinished work between sessions and agents | canonical opt-in core | original universal | Git, project rules |
| `scripts/install/policy-block.mjs` and the `destructive-operations` and `multi-agent` managed blocks in `templates/project-rules/AGENTS.md` | shared | Named managed policy blocks in `AGENTS.md`; destructive-operation approval and multi-agent isolation rules | canonical | original universal | Node.js for `-UpdatePolicies` |
| `scripts/install/skill-catalog.mjs`, `scripts/install/skill-catalog.json`, `scripts/install/skill-update.mjs` | shared | Released skill content versions and a read-only update planner | canonical | original universal mechanism | Node.js; Git history and tags for catalog generation only |
| `adapters/claude/claude-bootstrap.mjs`, `scripts/install/claude-adapter.mjs` | Claude Code | Generated `.claude/skills` link, `CLAUDE.md` bridge, settings hook merge, gitignore entry | adapter | original universal mechanism | Node.js, `AGENTS.md`, `.agents/skills` |

The eight Cline copies were verified identical to their `.agents` counterparts. Vendor skills were intentionally not mirrored. Product names, financial rules, tables/RPCs, brand tokens, components, locale details, and screen names were excluded from active universal behavior and replaced with project hooks.

In Agent Kit v1.1.0, Supabase/Postgres and Web Design are optional vendored modules with preserved MIT notices; Vercel React Best Practices is an optional referenced module because its inspected distribution declared MIT without including a complete license notice. None is part of the default core installation.

Copilot consumes the canonical project `.agents/skills` materialization directly, so no `.github/skills` mirror is maintained. The Copilot bridge and optional auditor are the only Copilot-specific adapter files.

`optional/vendored/security-audit` is an adapted third-party optional module from Cloudflare security-audit-skill commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (MIT). Its canonical package includes SKILL.md, two local review/report references, UPSTREAM.md, the complete license, and explicit-only Codex invocation metadata. It depends only on permitted local source reading/search during use; it ships no execution helpers or upstream validators. The maintainer structural validator is outside the distributed package. Source mapping and adaptation version are recorded in [UPSTREAM.md](../optional/vendored/security-audit/UPSTREAM.md). It uses existing approved optional distribution and is never selected by default.

The v1.9.0 handoff skill, the generalized managed-policy mechanism, and the destructive-operations and multi-agent policies were written for Agent Kit. The need for them was identified while reviewing the third-party IT-Shelter-Labs/Claude-Mods repository, whose license could not be established; no code or text from that repository was used.

The `data-visualization` skill was independently authored. External chart research was treated only as evidence; no third-party chart taxonomy, wording, templates, visual system, code, examples, validator, screenshots, or assets were incorporated.
