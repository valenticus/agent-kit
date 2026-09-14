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

The eight Cline copies were verified identical to their `.agents` counterparts. Vendor skills were intentionally not mirrored. Product names, financial rules, tables/RPCs, brand tokens, components, locale details, and screen names were excluded from active universal behavior and replaced with project hooks.

In Agent Kit v1.1.0, Supabase/Postgres and Web Design are optional vendored modules with preserved MIT notices; Vercel React Best Practices is an optional referenced module because its inspected distribution declared MIT without including a complete license notice. None is part of the default core installation.

Copilot consumes the canonical project `.agents/skills` materialization directly, so no `.github/skills` mirror is maintained. The Copilot bridge and optional auditor are the only Copilot-specific adapter files.

The `data-visualization` skill was independently authored. External chart research was treated only as evidence; no third-party chart taxonomy, wording, templates, visual system, code, examples, validator, screenshots, or assets were incorporated.
