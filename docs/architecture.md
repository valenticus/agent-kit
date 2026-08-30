# Architecture and discovery

`core/skills` is canonical for original universal methodology. `optional/vendored` is canonical for redistributable stack/vendor packages, while `optional/catalog.json` records both vendored and referenced modules. Tool adapters materialize approved selections into a project. Project hooks remain project-owned and are never synchronized back automatically.

```text
Agent Kit canonical source -> project .agents/skills -> validated .cline/skills mirror
```

Codex uses root `AGENTS.md` plus `.agents/skills`. Cline uses generated `.cline/skills` mirrors and can share root instructions through a small import file. Core and vendored optional selections follow the same canonical-to-mirror path.

Kilo keeps native permissions and custom-agent frontmatter in `.kilo`, while consuming shared project skills from `.agents/skills` where supported. The kit never creates `.kilo/skills`; that would be an uncontrolled third copy. Genuinely tool-specific agents, permissions, schemas, and configuration remain exceptions under their adapter/native directories.

The kit has no model lock. Agent model choice belongs to environment/project configuration.

## Instruction ownership and loading

Root project instructions own routing, precedence, permissions, context-loading policy, and always-on repository constraints. Each reusable workflow rule has one canonical skill owner; companion skills point to that owner and add only task-local consequences. This avoids maintaining the same checklist in several skills.

Context loads progressively from root instructions to one primary skill, any justified risk companion, the nearest relevant project/module documentation, and task-required references. Projects may name exceptional authoritative documents, but should not preload a documentation tree or maintain an exhaustive context map.
