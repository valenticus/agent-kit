# GitHub Copilot adapter

GitHub Copilot consumes root or nearest `AGENTS.md` instructions, repository-wide `.github/copilot-instructions.md`, project skills from `.agents/skills/<name>/SKILL.md`, and optional custom agents from `.github/agents/*.agent.md`.

Agent Kit keeps reusable methodology canonical in `core/skills` and materializes approved selections once in project `.agents/skills`, shared with Codex and Kilo. It does not create `.github/skills` or another Copilot skill mirror. Root `AGENTS.md` remains the canonical owner of routing, permissions, verification, context-loading policy, and always-on project constraints.

Selecting `copilot` in the installer also installs the small `copilot-instructions.md` bridge. Merge it manually if the project already owns that path; overwrite safety is intentional. The read-only `project-auditor.agent.md` profile is optional and is installed only with `-CopilotAuditor`.

Copilot is a supported execution environment. Its currently validated and preferred Agent Kit role is independent read-only repository audit and second-opinion review; implementation capability is not yet validated by this kit and is not artificially disabled by the general adapter.
