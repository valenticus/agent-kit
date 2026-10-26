# Attribution and license hygiene

The compact design methodology was independently generalized from the source project's original synthesis. Research influences retained as references:

- RubenGlez/mobile-design (MIT): mobile process, navigation, states, touch, accessibility, and selective references.
- grapeot/design_skill: evaluation-first critique and progressive disclosure.
- Shin1122/Human-UI-Design-Skill: product-specific and anti-generic UI critique; no text vendored because a clear license was not established in the inspected source notes.
- MaxMiksa/Auto-Company: conceptual separation of product, interaction, and UI roles.

## Agent reliability components (v1.9.0)

The `handoff` skill, the generalized managed-policy mechanism, and the destructive-operations and multi-agent policies were written for Agent Kit. A review of the third-party IT-Shelter-Labs/Claude-Mods repository, whose license could not be established, identified the need for them; no code or text from that repository was used, so it is a research reference only.

## Optional stack/vendor modules

- `security-audit` adaptation v1.0.0 derives from Cloudflare's MIT-licensed [security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8), pinned to commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. It preserves the complete `Copyright (c) 2025-2026 Cloudflare, Inc.` notice in [LICENSE](../optional/vendored/security-audit/LICENSE). It is adapted, not an unchanged vendor copy: source-only confirmation, explicit activation, a sequential pass, and Markdown coverage replace upstream execution, agents, and validators. [UPSTREAM.md](../optional/vendored/security-audit/UPSTREAM.md) maps sources and records semantic differences.

- `supabase-postgres-best-practices` v1.1.1 is vendored unchanged from the inspected source package. It declares MIT and includes the authoritative `Copyright (c) 2025 Supabase` MIT notice recovered from the installed Supabase plugin package. Upstream: https://github.com/supabase/agent-skills.
- `web-design-guidelines` v1.0.0 is vendored unchanged, including its Vercel Labs MIT license and checklist pinned to commit `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1`. Upstream: https://github.com/vercel-labs/web-interface-guidelines.
- `vercel-react-best-practices` v1.0.0 is referenced, not vendored. Its package and upstream frontmatter declare MIT, but the inspected distribution/upstream repository did not provide a complete license notice suitable for redistribution. Use the maintained `vercel:react-best-practices` plugin skill when available or perform a separate, user-approved upstream installation. Upstream: https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices.

These modules remain third-party material, separate from the kit's original universal methodology. They are never installed by default and their provenance must be preserved on updates.
