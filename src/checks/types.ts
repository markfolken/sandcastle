/**
 * The contract of the checks subsystem: a factory runs checks before and after
 * agent work, so an infrastructure failure can't pass for a code failure or a
 * success. Every check gets its shell access from a `Runner`, which is what
 * makes the suite testable with no git, no gh and no network.
 */

/** `block` stops the factory; `warn` is reported and the factory carries on. */
export type Severity = "block" | "warn";

/** What a finished command left behind. */
export interface CommandResult {
  /** The exit code. Non-zero when the command could not be started. */
  status: number;
  /** Everything it wrote to stdout. */
  stdout: string;
  /** Everything it wrote to stderr. */
  stderr: string;
}

/** Runs one command to completion. All shell access goes through this. */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => CommandResult;

/** What a check may know about the run it is checking. */
export interface CheckContext {
  /** The repository on the host. */
  repoPath: string;
  /** The branch work starts from and merges into, e.g. `main`. */
  baseBranch: string;
  /** The branch the agent works on, e.g. `agent/issue-42`. */
  branch: string;
  /** The GitHub repository, as `owner/repo`. */
  slug: string;
  /** The issue being worked on, when there is one. */
  issue?: { number: number; title: string; body: string };
  /** The environment the factory runs in. */
  env: Record<string, string | undefined>;
  /** All shell access goes through this. */
  run: Runner;
}

/** What one check found. */
export interface CheckResult {
  /** Whether the check passed. */
  ok: boolean;
  /** One line saying what was found. */
  detail: string;
  /** What to do about a failure. */
  fix?: string;
  /**
   * Overrides `Check.severity` for this result, for a check whose failures
   * differ: `ciTerminal` blocks on a failing run and warns on a timeout.
   */
  severity?: Severity;
}

/** One named check. */
export interface Check {
  /** The name reports show. */
  name: string;
  /** How a failure counts, unless its `CheckResult` says otherwise. */
  severity: Severity;
  /** Runs the check. A rejection is reported as a crash of the check. */
  run: (ctx: CheckContext) => Promise<CheckResult>;
}
