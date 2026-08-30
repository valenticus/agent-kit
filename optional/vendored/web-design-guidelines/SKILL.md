---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
license: MIT
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Read the bundled checklist at `references/checklist.md`
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the checklist
4. Output findings in the terse `file:line` format

## Checklist Source

The checklist is vendored from Vercel Labs and pinned to upstream commit `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1`:

https://github.com/vercel-labs/web-interface-guidelines/blob/e3d624baaf29dc1fc645aff3e38f03e564d2d6b1/command.md

`references/checklist.md` is authoritative and works offline; do not fetch it at runtime. To upgrade, deliberately replace that file with a newer pinned revision and update this SHA. Distributed under the MIT license — see `references/LICENSE`.

## Usage

When a user provides a file or pattern argument:
1. Read `references/checklist.md`
2. Read the specified files
3. Apply all rules from the checklist
4. Output findings using the format specified in the checklist

If no files specified, ask the user which files to review.
