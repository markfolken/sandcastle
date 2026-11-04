---
"@ai-hero/sandcastle": minor
---

Add `@ai-hero/sandcastle/checks`, a library of checks for issue-driven factories: preflight checks that refuse to start on a stale base, a credential in git config or a stale worktree; postflight checks that refuse to report success without an exit code of 0, an open PR, a well-formed PR body and terminal CI; ticket lint for issues; and a report with conventional exit codes. Every check takes an injected `Runner`. See `docs/guide/checks.md`.
