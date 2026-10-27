# Claude Code adapter

Opt-in adapter (`-Tools claude`). Agent Kit stays agent-neutral: `AGENTS.md` and `.agents/skills` remain the only canonical instruction and skill locations, and this adapter only *exposes* them to Claude Code. Claude Code does not read `AGENTS.md` everywhere and does not discover `.agents/skills`, but it natively discovers `.claude/skills` and `CLAUDE.md`.

```text
AGENTS.md ──────────────► CLAUDE.md            (one line: @AGENTS.md)
.agents/skills ─ bootstrap ─► .claude/skills   (generated link, git-ignored)
                                  └─► Claude native skill discovery
```

## Installed files

| Path | Tracked | Purpose |
|---|---|---|
| `CLAUDE.md` | yes | Bridge containing only `@AGENTS.md`; no policy is duplicated. |
| `.claude/settings.json` | yes | Gains one `SessionStart` command hook; everything else is preserved. |
| `.claude/agent-kit/claude-bootstrap.mjs` | yes | Auditable copy of `adapters/claude/claude-bootstrap.mjs` (Node.js, no dependencies). |
| `.claude/skills` | **no** | Generated link to `.agents/skills`. Never a second skill tree. |
| `.gitignore` | yes | Gains `/.claude/skills`. The rule has no trailing slash because Git sees a link as a file, not a directory. `.claude/` as a whole is not ignored. |

Install: `install.ps1 -ProjectRoot <project> -Tools claude -Skills safe-change,debugging`. `claude` joins `codex`, `kilo`, and `copilot` in sharing one `.agents/skills` materialization, so combining tools never duplicates skills. To add Claude to a project that already has Agent Kit skills, pass `-Tools claude -NoSkills`: no skills are copied and the link exposes the existing `.agents/skills`. `-NoSkills` cannot be combined with `-Skills` or `-OptionalSkills`, and it is refused if `.agents/skills` does not exist.

The installer plans and checks every destination (skills, tool files, Claude adapter) before writing anything; a predictable conflict fails the whole invocation with nothing changed.

## Bootstrap and platforms

The hook is `node "$CLAUDE_PROJECT_DIR/.claude/agent-kit/claude-bootstrap.mjs"`. Claude Code runs project `SessionStart` hooks before native skill discovery (verified in Claude Code on the web), so the link exists before the first prompt. The bootstrap is idempotent and silent on success (hook stdout would become model context).

| Environment | `.claude/skills` |
|---|---|
| Windows | Junction to `.agents/skills`. Needs no elevation, Developer Mode, or `core.symlinks`. |
| macOS / Linux / Claude Cloud | Relative symlink `../.agents/skills`. |

`.claude/skills` is not committed: a committed symlink breaks Windows checkouts (it becomes a text file, or checkout fails with `core.symlinks=true` and no privilege), and Git traverses a junction and would stage duplicate skill files. The ignore rule prevents that.

## Conflict behavior

Nothing is overwritten or deleted; the installer validates everything before writing and refuses with an actionable message.

- `CLAUDE.md`: absent → created. Present with an `@AGENTS.md` line → left as is. Otherwise refused; add the import manually.
- `.claude/settings.json`: absent → created. Present strict JSON → the hook is appended to `hooks.SessionStart`, other keys, hooks, indentation, line endings, and a UTF-8 BOM preserved, and re-installs never duplicate it. Comments, trailing commas, or an unexpected shape (`hooks` not an object, `SessionStart` not an array) are refused with the exact hook to add manually. A rewrite re-serializes the JSON file.
- `.claude/agent-kit/claude-bootstrap.mjs`: identical → no-op; different → refused.
- `.claude/skills`: correct link → no-op; wrong or broken link, real directory, or ordinary file → refused (the bootstrap fails with exit code 2 and a stderr diagnostic, leaving the path untouched). Recursive copy is never a fallback.
- `.agents/skills` missing → refused; no broken adapter is created.
- Links: nothing is written outside the project. `.claude`, `.claude/agent-kit`, `.claude/settings.json`, the bootstrap copy, `.agents`, and `.agents/skills` must be real directories and files; a symbolic link or junction there is refused, even one inside the project. `CLAUDE.md` and `.gitignore` may be links whose real target is a regular file inside the project (`.gitignore` is then updated at that target). `.gitignore` is never appended in place: its bytes are kept, the entry is added, and the result replaces the file by rename with the same permissions, so a hard link to a file outside the project is left unchanged; if that is not possible, the install stops before any adapter file is written; broken, circular, or outside links are refused. These checks run in the preflight, before `install.ps1` copies any skill. The installed bootstrap itself is unchanged, so existing copies keep matching.

An unexpected write error after these checks (for example a full disk) can stop the install part-way, such as after the bootstrap copy but before `.claude/settings.json` gains the hook. That state is inert: the bootstrap runs only from the hook, and a failed settings write leaves the original file unchanged. `validate-install.mjs` reports the incomplete adapter. Complete it with `install.ps1 -ProjectRoot <project> -Tools claude -NoSkills`, which reuses the existing `.agents/skills` and overwrites nothing; repeating the original command with `-Skills` is refused because those skills already exist.

## Trust

The `SessionStart` hook is executable project behavior: opening the project in Claude Code runs the committed local bootstrap. It uses no network, secrets, remote code, or package installation, and writes only `.claude/skills`. Review `.claude/agent-kit/claude-bootstrap.mjs` like any other project script. Node.js must be on `PATH`; if it is missing the hook fails visibly and Claude Code still works without the skills link.

Validation: `node scripts/validation/validate-claude.mjs` (bootstrap, settings merge, gitignore, installer step) plus `validate-installer.mjs` and `validate-install.mjs <project>`.
