# Bootstrap Universal Agent Kit

Use Agent Kit at `<ABSOLUTE_KIT_PATH>` for project `<ABSOLUTE_PROJECT_PATH>`.

Remain within this one-shot bootstrap task. Do not start loops, delegate, install dependencies, commit, push, or overwrite existing agent infrastructure.

1. Inspect the project stack, architecture, UI, product documentation, data/security model, tests, working-tree changes, and all existing Codex/Cline/Kilo instructions.
2. Classify recommendations into CORE UNIVERSAL SKILLS from `core/skills`, OPTIONAL STACK/VENDOR SKILLS from `optional/catalog.json`, and PROJECT-SPECIFIC SKILLS/hooks authored from this project.
3. Recommend optional modules only when evidence makes them relevant: PostgreSQL/Supabase may use `supabase-postgres-best-practices`; React/Next.js may use `vercel-react-best-practices`; web-interface review may use `web-design-guidelines`. Unrelated projects must not receive them.
4. Draft project-ui, project-product, project-architecture, project-data, project-security, and project-rules from verified evidence. Leave unresolved questions explicit; do not import another project's answers or identity.
5. Show the grouped proposal, evidence, installation command, referenced-module instructions, and conflicts before writing. Stack detection proposes; it never installs autonomously.
6. Run the installer only with approved core and vendored optional selections. Referenced modules require their documented, separately approved installation path; never fetch them silently.
7. Merge project hooks carefully, validate, and report installed/generated files, skipped or referenced modules, unresolved questions, and results.

Example: for Supabase + Next.js, propose `safe-change`, `debugging`, `security`, and `ui`; optionally propose the Supabase and Vercel React modules; then create fresh project UI/product hooks. The user approves the final selection.

Previous projects are methodology references only, never visual or product templates.
