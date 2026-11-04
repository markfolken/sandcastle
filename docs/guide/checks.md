# Checks

Run a [preflight check](./glossary.md#preflight-check) suite before spending a run, and a [postflight check](./glossary.md#postflight-check) suite after it, so that a broken foundation or a crashed publisher can't pass for a code failure or a success:

```typescript
import { spawnSync } from "node:child_process";
import {
  exitCodeFor,
  renderText,
  runPostflight,
  runPreflight,
} from "@ai-hero/sandcastle/checks";
import type { CheckContext, Runner } from "@ai-hero/sandcastle/checks";

const run: Runner = (cmd, args, opts) => {
  const result = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const ctx: CheckContext = {
  repoPath: process.cwd(),
  baseBranch: "main",
  branch: "agent/issue-42",
  slug: "owner/repo",
  env: process.env,
  run,
};

const before = await runPreflight(ctx);
console.log(renderText(before));
if (exitCodeFor(before) !== 0) process.exit(exitCodeFor(before));

const loopExitCode = 0; // whatever your factory's loop returned

const after = await runPostflight(ctx, { exitCode: loopExitCode });
console.log(renderText(after));
process.exit(exitCodeFor(after));
```

Checks don't change `run()`, and `run()` doesn't call them: your factory decides when they run. They take no hidden input. Everything comes through the `CheckContext`, and all shell access goes through its `Runner`, so you can test a factory's checks with a fake `Runner` and no git, gh or network.

`baseBranch` is the branch your factory starts work from and merges PRs into. It's your factory's setting, unrelated to the [target branch](./glossary.md#target-branch) of a `run()`.

## Preflight checks

`runPreflight(ctx, options?)` runs all of these, and every check runs whatever the others find.

| Check                 | Severity | What it prevents                                                                                                                                                                                                                                                                                 |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseCurrent`         | block    | Starting from the wrong commit. Fetches, then requires the local base to equal `origin/<base>` or be able to fast-forward to it. A base that is only behind passes, and the detail says so: your factory fast-forwards it. A base with commits `origin/<base>` lacks is refused, with both SHAs. |
| `noCredentials`       | block    | An [agent](./glossary.md#agent) reading a token out of `git config` and pushing with it. Scans remote URLs and every config key and value visible from the repo and the branch's [worktree](./glossary.md#worktree).                                                                             |
| `worktreeClean`       | block    | A `WorktreeError` on the next run, from a stale worktree registration for the branch. The fix names `git worktree prune` and `git worktree remove`.                                                                                                                                              |
| `testCommandRunnable` | block    | A run whose tests can't start. `FACTORY_TEST_CMD`, or the key you configure, must be set and its interpreter must exist.                                                                                                                                                                         |
| `agentTokenValid`     | warn     | Starting with no token or an expired one. Warns, never blocks, since the caller may refresh. Tries the env vars you configure, then the file `AGENT_TOKEN_FILE` names, and reads a JWT `exp` or a JSON `expiresAt`, `expires_at`, `expiry` or `exp`.                                             |
| `branchHasOpenPR`     | warn     | Surprise at an existing PR. It names the PR. Publishing is idempotent, so this is information.                                                                                                                                                                                                   |

`noCredentials` recognises `@` in an `http(s)` URL's authority, GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), `x-access-token` and `Authorization:`. It reports the key that holds a credential, never the credential. Reports also redact these patterns from every check's text, since a report often ends up in a CI log.

```typescript
await runPreflight(ctx, {
  testCommand: { envKey: "MY_TEST_CMD" },
  agentToken: { envKeys: ["MY_TOKEN"], tokenFileEnvKey: "MY_TOKEN_FILE" },
});
```

`baseCurrent` runs `git fetch`, and the `Runner` you write runs on the [host](./glossary.md#host). When a [sandbox provider](./glossary.md#sandbox-provider) mounts the repo, an agent can write the repo's git config, and several config keys name a program for git to run. If an agent has already had this repo, don't run preflight checks against it through a plain `spawnSync`: use a fresh clone, or a `Runner` that overrides those keys.

## Postflight checks

`runPostflight(ctx, { exitCode, prBody?, ci? })` runs all of these. A tool that can't answer never reads as a good answer: when gh fails, the check says it could not confirm, and blocks.

| Check         | Severity                          | What it prevents                                                                                                                                          |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runExited`   | block                             | Ignoring a loop that exited non-zero.                                                                                                                     |
| `prExists`    | block                             | The run that looks successful with no PR, because a publisher crashed after printing a passing review.                                                    |
| `prBodyShape` | block                             | A PR without its required sections. Each heading must be on its own line. Defaults to `## Summary`, `## Evidence`, `## Review` and `## Merge Danger`.     |
| `ciTerminal`  | block on failure, warn on timeout | Merging on CI nobody saw finish. A failing run blocks and names itself. A timeout warns, and says `TIMED OUT` and `NOT confirmed` rather than pretending. |

`ciTerminal` waits ten minutes by default and looks every fifteen seconds:

```typescript
await runPostflight(ctx, {
  exitCode: loopExitCode,
  prBody: { headings: ["## Why", "## Evidence"] },
  ci: { timeoutMs: 1_800_000, pollIntervalMs: 30_000 },
});
```

A run CI hasn't started, an outcome it doesn't recognise and a timeout are all warnings, so exit code 0 here doesn't mean CI passed: read the report for a `WARN ciTerminal` line, or treat any warning as a stop in your own gate. If gh can't read the check runs at all, that blocks.

## Ticket lint

[Ticket lint](./glossary.md#ticket-lint) reads an issue before a run is spent on it:

```typescript
import { ticketLint } from "@ai-hero/sandcastle/checks";

const findings = ticketLint({ title, body }, (cmd, args) =>
  run(cmd, args, { cwd: repoPath }),
);
```

Each finding has a `kind`, a `severity`, the offending `line` quoted, a `message` and sometimes a `suggestion`. To lint `ctx.issue` as a report instead, call `runTicketLint(ctx)`.

| Kind                     | Severity | Finds                                                                                                                                                                                                          |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nonexistent-path`       | block    | A backticked path not in `git ls-files`, with the closest match when there is one. It's a warning on a line that may mean to create the file (`add`, `create`, `new`…).                                        |
| `wrong-install-name`     | block    | `pipx install X`, `pip install X` or `uv tool install X` where PyPI returns 404 for `X`, with a likely real name when one is on PyPI. Paths, URLs, placeholders and commands naming another index are skipped. |
| `unverifiable-criterion` | warn     | A criterion that rests on an env-var-gated test, claims an artifact on PyPI or npm that isn't there, or says "verified by running" and names no command. Comes with a rewrite.                                 |
| `scope-creep`            | warn     | "While you're there", "also update the docs", "make everything consistent" and similar invitations to touch files outside the ticket. Advises a separate ticket.                                               |
| `lint-incomplete`        | warn     | A check that could not run: no network, no `curl`, a registry error, no repository. Only a 404 counts as "not on PyPI", so a network failure never blocks a ticket.                                            |

## Exit codes

`exitCodeFor(report)` gives the exit code a factory should end with. Each is also an exported constant.

| Code | Constant                 | Meaning                                                                                      |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------- |
| 0    | `EXIT_OK`                | Nothing blocked. There may be warnings.                                                      |
| 1    | `EXIT_CRASH`             | A blocking check threw, so there is no verdict. A warning check that throws stays a warning. |
| 2    | `EXIT_BLOCKED_BY_GATE`   | A postflight check blocked. It's also yours to use for a gate of your own.                   |
| 3    | `EXIT_PREFLIGHT_REFUSED` | A preflight check refused to start the work.                                                 |
| 4    | `EXIT_REFUSED`           | Any other refusal, such as ticket lint. It's also yours to use.                              |

A real block outranks a crash, since rerunning won't clear it.

## Reports

`renderText(report)` prints one line per check (status, name, detail), then the fix for each failure:

```text
preflight: exit 3
PASS  worktreeClean: no worktree registered for agent/issue-42
BLOCK baseCurrent: main (a1b2…) has diverged from origin/main (c3d4…): it has commits origin/main lacks
fix baseCurrent: Move those commits to a branch, then run: git checkout main && git reset --hard origin/main
```

`renderJson(report)` is the same for machines:

```json
{
  "phase": "preflight",
  "ok": false,
  "exitCode": 3,
  "checks": [
    { "name": "baseCurrent", "status": "block", "detail": "…", "fix": "…" }
  ]
}
```

`status` is `pass`, `warn`, `block` or `crash`.

## Your own checks

A check is a name, a severity and a function, and `runChecks` runs any list of them:

```typescript
import { runChecks } from "@ai-hero/sandcastle/checks";
import type { Check } from "@ai-hero/sandcastle/checks";

const lockfileCommitted: Check = {
  name: "lockfileCommitted",
  severity: "block",
  run: (ctx) => {
    const { stdout } = ctx.run("git", ["ls-files", "package-lock.json"], {
      cwd: ctx.repoPath,
    });
    return Promise.resolve(
      stdout.trim() === ""
        ? { ok: false, detail: "package-lock.json is not committed" }
        : { ok: true, detail: "package-lock.json is committed" },
    );
  },
};

const report = await runChecks("preflight", [lockfileCommitted], ctx);
```

## Related terms

- [Hooks](./hooks.md): commands that run while a [sandbox](./glossary.md#sandbox) starts, not checks around a run
- [Branch strategies](./branch-strategies.md): how a run's commits relate to `branch`
- [Glossary](./glossary.md)
