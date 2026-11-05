/**
 * Runs checks and renders what they found, as text and as JSON.
 *
 * The exit codes a factory should end with:
 *
 * | Code | Constant                 | Meaning                                       |
 * | ---- | ------------------------ | --------------------------------------------- |
 * | 0    | `EXIT_OK`                | Nothing blocked. Warnings don't change this.  |
 * | 1    | `EXIT_CRASH`             | A blocking check itself crashed: no verdict.  |
 * | 2    | `EXIT_BLOCKED_BY_GATE`   | A postflight check, or the caller's gate.     |
 * | 3    | `EXIT_PREFLIGHT_REFUSED` | A preflight check refused to start the work.  |
 * | 4    | `EXIT_REFUSED`           | Any other refusal, such as ticket lint.       |
 *
 * A real block outranks a crash: rerunning won't clear it.
 */

import { redactCredentials } from "./credentials.js";
import type { Check, CheckContext, CheckResult, Severity } from "./types.js";

/** Nothing blocked. */
export const EXIT_OK = 0;
/** A blocking check itself crashed, so there is no verdict. */
export const EXIT_CRASH = 1;
/** Blocked by a gate: a postflight check, or a gate of the caller's own. */
export const EXIT_BLOCKED_BY_GATE = 2;
/** A preflight check refused to start the work. */
export const EXIT_PREFLIGHT_REFUSED = 3;
/** Any other refusal, such as a ticket that fails lint. */
export const EXIT_REFUSED = 4;

/** Which set of checks a report is about. */
export type CheckPhase = "preflight" | "postflight" | "ticket";

/** How one check ended up: `crash` is a blocking check that threw. */
export type CheckStatus = "pass" | "warn" | "block" | "crash";

/** One check's result, as a report shows it. Free of credentials. */
export interface CheckOutcome {
  /** The check's name. */
  name: string;
  /** How it ended up. */
  status: CheckStatus;
  /** One line saying what was found. */
  detail: string;
  /** What to do about a failure. */
  fix?: string;
}

/** What one set of checks found. */
export interface CheckReport {
  /** Which set of checks ran. */
  phase: CheckPhase;
  /** One outcome per check, in the order the checks were given. */
  outcomes: CheckOutcome[];
}

const statusOf = (result: CheckResult, severity: Severity): CheckStatus =>
  result.ok ? "pass" : (result.severity ?? severity);

const toOutcome = (name: string, status: CheckStatus, result: CheckResult) => ({
  name,
  status,
  detail: redactCredentials(result.detail.replaceAll(/\s*\n\s*/gu, " ")),
  ...(result.fix === undefined ? {} : { fix: redactCredentials(result.fix) }),
});

const runOne = (check: Check, ctx: CheckContext): Promise<CheckOutcome> =>
  Promise.resolve()
    .then(() => check.run(ctx))
    .then(
      (result) =>
        toOutcome(check.name, statusOf(result, check.severity), result),
      (error: unknown) =>
        toOutcome(check.name, check.severity === "block" ? "crash" : "warn", {
          ok: false,
          detail: `the check crashed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    );

/** Runs every check, whatever the others find, so a report shows them all. */
export const runChecks = (
  phase: CheckPhase,
  checks: readonly Check[],
  ctx: CheckContext,
): Promise<CheckReport> =>
  Promise.all(checks.map((check) => runOne(check, ctx))).then((outcomes) => ({
    phase,
    outcomes,
  }));

const BLOCK_EXIT_CODES: Readonly<Record<CheckPhase, number>> = {
  preflight: EXIT_PREFLIGHT_REFUSED,
  postflight: EXIT_BLOCKED_BY_GATE,
  ticket: EXIT_REFUSED,
};

/** The exit code a factory should end with after this report. */
export const exitCodeFor = (report: CheckReport): number => {
  const statuses = new Set(report.outcomes.map((outcome) => outcome.status));
  if (statuses.has("block")) {
    return BLOCK_EXIT_CODES[report.phase];
  }
  return statuses.has("crash") ? EXIT_CRASH : EXIT_OK;
};

/** One line per check (status, name, detail), then the fix for each failure. */
export const renderText = (report: CheckReport): string => {
  const lines = report.outcomes.map(
    ({ status, name, detail }) =>
      `${status.toUpperCase().padEnd(5)} ${name}: ${detail}`,
  );
  const fixes = report.outcomes.flatMap(({ name, status, fix }) =>
    status === "pass" || fix === undefined ? [] : [`fix ${name}: ${fix}`],
  );
  return [
    `${report.phase}: exit ${String(exitCodeFor(report))}`,
    ...lines,
    ...fixes,
  ].join("\n");
};

/** The report for machines: its verdict, and every outcome. */
export const renderJson = (report: CheckReport): string =>
  JSON.stringify(
    {
      phase: report.phase,
      ok: exitCodeFor(report) === EXIT_OK,
      exitCode: exitCodeFor(report),
      checks: report.outcomes,
    },
    null,
    2,
  );
