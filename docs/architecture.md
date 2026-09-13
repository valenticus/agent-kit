# Architecture and discovery

`core/skills` is canonical for original universal methodology. `optional/vendored` is canonical for redistributable stack/vendor packages, while `optional/catalog.json` records both vendored and referenced modules. Tool adapters materialize approved selections into a project. Project hooks remain project-owned and are never synchronized back automatically.

```text
Agent Kit canonical source
  -> project .agents/skills -> Codex / Kilo / Copilot
  -> validated project .cline/skills mirror -> Cline
```

Codex uses root `AGENTS.md` plus `.agents/skills`. Cline uses generated `.cline/skills` mirrors and can share root instructions through a small import file. Core and vendored optional selections follow the same canonical-to-mirror path.

Kilo keeps native permissions and custom-agent frontmatter in `.kilo`, while consuming shared project skills from `.agents/skills` where supported. The kit never creates `.kilo/skills`; that would be an uncontrolled third copy. Genuinely tool-specific agents, permissions, schemas, and configuration remain exceptions under their adapter/native directories.

Copilot uses the root or nearest `AGENTS.md`, a small repository-wide `.github/copilot-instructions.md` bridge, and the same `.agents/skills` materialization as Codex and Kilo. The bridge does not duplicate canonical policy because Copilot gives repository-wide instructions precedence over agent instructions; it points back to `AGENTS.md` and the progressive skill-loading contract without redefining them. The optional `.github/agents/project-auditor.agent.md` profile is installed only on request and never runs automatically. No `.github/skills` or other Copilot skill mirror is created.

Copilot is a first-class supported adapter and execution environment. Its validated/preferred role is currently independent read-only audit and second-opinion review. Coding is not claimed as validated, although the general adapter does not block capabilities provided by Copilot; that routing policy can expand later without changing skill ownership or discovery.

The kit has no model lock. Agent model choice belongs to environment/project configuration.

## Instruction ownership and loading

Root project instructions own routing, precedence, permissions, context-loading policy, the default user-facing communication language, and other always-on repository constraints. Each reusable workflow rule has one canonical skill owner; companion skills point to that owner and add only task-local consequences. This avoids maintaining the same checklist in several skills.

Context loads progressively from root instructions to one primary skill, any justified risk companion, the nearest relevant project/module documentation, and task-required references. Projects may name exceptional authoritative documents, but should not preload a documentation tree or maintain an exhaustive context map.
