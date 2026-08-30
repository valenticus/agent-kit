# Kilo adapter

Kilo uses `.kilo/kilo.jsonc` for permissions and `.kilo/agents/*.md` for custom agents. Its skill tool consumes approved core/optional/project skills from project `.agents/skills` where supported. The kit never creates `.kilo/skills`: if a future Kilo version genuinely requires a different discovery format, add a validated tool adapter rather than an independently edited third source. Adapt `kilo.template.jsonc` to the project's exact Kilo version and permission policy.
