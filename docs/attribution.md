# Attribution and license hygiene

The compact design methodology was independently generalized from the source project's original synthesis. Research influences retained as references:

- RubenGlez/mobile-design (MIT): mobile process, navigation, states, touch, accessibility, and selective references.
- grapeot/design_skill: evaluation-first critique and progressive disclosure.
- Shin1122/Human-UI-Design-Skill: product-specific and anti-generic UI critique; no text vendored because a clear license was not established in the inspected source notes.
- MaxMiksa/Auto-Company: conceptual separation of product, interaction, and UI roles.

## Optional stack/vendor modules

- `supabase-postgres-best-practices` v1.1.1 is vendored unchanged from the inspected source package. It declares MIT and includes the authoritative `Copyright (c) 2025 Supabase` MIT notice recovered from the installed Supabase plugin package. Upstream: https://github.com/supabase/agent-skills.
- `web-design-guidelines` v1.0.0 is vendored unchanged, including its Vercel Labs MIT license and checklist pinned to commit `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1`. Upstream: https://github.com/vercel-labs/web-interface-guidelines.
- `vercel-react-best-practices` v1.0.0 is referenced, not vendored. Its package and upstream frontmatter declare MIT, but the inspected distribution/upstream repository did not provide a complete license notice suitable for redistribution. Use the maintained `vercel:react-best-practices` plugin skill when available or perform a separate, user-approved upstream installation. Upstream: https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices.

These modules remain third-party material, separate from the kit's original universal methodology. They are never installed by default and their provenance must be preserved on updates.
