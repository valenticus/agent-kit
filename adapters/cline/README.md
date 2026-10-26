# Cline adapter

Cline receives generated mirrors under `.cline/skills/` for approved core and vendored optional selections. `CLAUDE.md` may import the shared root instruction file with `@AGENTS.md`; the opt-in Claude Code adapter (`adapters/claude/README.md`) accepts such an existing bridge unchanged. Mirrors are validated recursively against project `.agents/skills`, byte-for-byte apart from CRLF/LF line endings (the same identity the skill catalog uses); edit Agent Kit canonical sources or reviewed project-owned skills, not generated mirrors.
