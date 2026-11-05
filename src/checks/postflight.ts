/**
 * The checks a factory runs after agent work: never report a success that has
 * not been confirmed. A tool that can't answer is never read as a good answer.
 */

import { setTimeout as sleepMs } from "node:timers/promises";
import { failureReason, isRecord, lookUpOpenPrs, parseJson } from "./github.js";
import type { Check, CheckContext, CheckResult } from "./types.js";

/** The section headings `prBodyShape` requires by default. */
export const DEFAULT_PR_HEADINGS: readonly string[] = [
  "## Summary",
  "## Evidence",
  "## Review",
  "## Merge Danger",
];

const DEFAULT_CI_TIMEOUT_MS = 600_000;
const DEFAULT_CI_POLL_MS = 15_000;

/** The loop's exit code is 0. */
export const runExited = (exitCode: number): Check => ({
  name: "runExited",
  severity: "block",
  run: () =>
    Promise.resolve(
      exitCode === 0
        ? { ok: true, detail: "the loop exited 0" }
        : {
            ok: false,
            detail: `the loop exited ${String(exitCode)}`,
            fix: "Read the run log; this is a failed run, whatever it printed.",
          },
    ),
});

/**
 * The branch has an open PR. This exists because a publisher crashed after
 * printing a passing review, and the run looked successful with no PR.
 */
export const prExists: Check = {
  name: "prExists",
  severity: "block",
  run: (ctx) =>
    Promise.resolve().then((): CheckResult => {
      const lookup = lookUpOpenPrs(ctx, "number,url");
      if (!lookup.ok) {
        return {
          ok: false,
          detail: `could not confirm a PR exists: ${lookup.reason}`,
          fix: "Fix gh access, then rerun; no PR has been confirmed.",
        };
      }
      const [pr] = lookup.prs;
      return pr === undefined
        ? {
            ok: false,
            detail: `no open PR for ${ctx.branch} in ${ctx.slug}`,
            fix: "The publisher did not finish, whatever it printed. Publish again.",
          }
        : { ok: true, detail: `PR #${String(pr.number)}: ${pr.url}` };
    }),
};

/** The PR body has every required section heading, each on its own line. */
export const prBodyShape = (
  options: { readonly headings?: readonly string[] } = {},
): Check => ({
  name: "prBodyShape",
  severity: "block",
  run: (ctx) =>
    Promise.resolve().then((): CheckResult => {
      const lookup = lookUpOpenPrs(ctx, "number,url,body");
      const pr = lookup.ok ? lookup.prs[0] : undefined;
      if (pr === undefined) {
        const why = lookup.ok ? "there is no open PR" : lookup.reason;
        return { ok: false, detail: `could not read a PR body: ${why}` };
      }
      const lines = new Set(pr.body.split(/\r?\n/u).map((line) => line.trim()));
      const headings = options.headings ?? DEFAULT_PR_HEADINGS;
      const missing = headings.filter((heading) => !lines.has(heading));
      return missing.length === 0
        ? { ok: true, detail: `PR #${String(pr.number)} has every heading` }
        : {
            ok: false,
            detail: `PR #${String(pr.number)} is missing: ${missing.join(", ")}`,
            fix: "Add the missing sections to the PR body.",
          };
    }),
});

/** Configures `ciTerminal`. */
export interface CiTerminalOptions {
  /** How long to wait for a terminal state. Default ten minutes. */
  readonly timeoutMs?: number;
  /** How long to wait between looks. Default fifteen seconds. */
  readonly pollIntervalMs?: number;
  /** The current time in ms. Default `Date.now`. */
  readonly now?: () => number;
  /** Waits. Default a real timer. */
  readonly sleep?: (ms: number) => Promise<unknown>;
}

type CiState = "pass" | "fail" | "pending";

interface CiRun {
  readonly name: string;
  readonly state: CiState;
}

type CiLook =
  | { readonly kind: "runs"; readonly runs: readonly CiRun[] }
  | { readonly kind: "none-yet" }
  | { readonly kind: "no-pr"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/** An outcome neither list knows stays pending: it is not a confirmed pass. */
const toCiState = (outcome: unknown): CiState => {
  const word = typeof outcome === "string" ? outcome : "";
  if (FAILED.has(word)) {
    return "fail";
  }
  return PASSED.has(word) ? "pass" : "pending";
};

/** One rollup item: a `CheckRun` (name, conclusion) or a `StatusContext` (context, state). */
const toCiRun = (value: unknown): CiRun[] => {
  if (!isRecord(value)) {
    return [];
  }
  const name = value["name"] ?? value["context"];
  const { conclusion } = value;
  return [
    {
      name: typeof name === "string" ? name : "(unnamed)",
      state: toCiState(
        typeof conclusion === "string" && conclusion !== ""
          ? conclusion
          : value["state"],
      ),
    },
  ];
};

/**
 * One look at the check runs, through the query `prExists` uses. Not
 * `gh pr view <branch>`, which can't see a PR from a fork, and not
 * `gh pr checks --json`, which gh versions still in distros don't have.
 */
const lookAtCi = (ctx: CheckContext): CiLook => {
  const result = ctx.run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      ctx.slug,
      "--head",
      ctx.branch,
      "--state",
      "open",
      "--json",
      "number,statusCheckRollup",
    ],
    { cwd: ctx.repoPath },
  );
  const parsed = parseJson(result.stdout);
  if (result.status !== 0 || !Array.isArray(parsed)) {
    return { kind: "unreadable", reason: failureReason(result) };
  }
  const prs: readonly unknown[] = parsed;
  const [pr] = prs;
  if (pr === undefined) {
    return { kind: "no-pr", reason: `no open PR for ${ctx.branch}` };
  }
  const rollup = isRecord(pr) ? pr["statusCheckRollup"] : undefined;
  if (!Array.isArray(rollup)) {
    return { kind: "unreadable", reason: "gh printed no statusCheckRollup" };
  }
  return rollup.length === 0
    ? { kind: "none-yet" }
    : { kind: "runs", runs: rollup.flatMap((item) => toCiRun(item)) };
};

/** The result this look settles on, or undefined while runs are still going. */
const settled = (look: CiLook): CheckResult | undefined => {
  if (look.kind === "no-pr") {
    return { ok: false, detail: `no check runs to read: ${look.reason}` };
  }
  if (look.kind !== "runs") {
    return undefined;
  }
  const failing = look.runs.filter((run) => run.state === "fail");
  if (failing.length > 0) {
    return {
      ok: false,
      detail: `failing: ${failing.map((run) => run.name).join(", ")}`,
      fix: "Read the logs of the failing check runs.",
    };
  }
  return look.runs.some((run) => run.state === "pending")
    ? undefined
    : {
        ok: true,
        detail: `all ${String(look.runs.length)} check runs finished without a failure`,
      };
};

/** What running out of time means, depending on what the last look saw. */
const atTimeout = (look: CiLook, timeoutMs: number): CheckResult => {
  if (look.kind === "unreadable") {
    return {
      ok: false,
      detail: `could not read check runs for ${String(timeoutMs)}ms: ${look.reason}`,
      fix: "Fix gh access, then rerun; CI has not been confirmed.",
    };
  }
  const pending =
    look.kind === "runs"
      ? `still pending: ${look.runs
          .filter((run) => run.state === "pending")
          .map((run) => run.name)
          .join(", ")}`
      : "no check runs appeared";
  return {
    ok: false,
    severity: "warn",
    detail: `TIMED OUT after ${String(timeoutMs)}ms, so CI is NOT confirmed: ${pending}`,
    fix: "Look at the PR's checks yourself before merging.",
  };
};

/**
 * Check runs reach a terminal state within the timeout. A failing run blocks
 * and names itself; a timeout warns and says so rather than pretending.
 */
export const ciTerminal = (options: CiTerminalOptions = {}): Check => ({
  name: "ciTerminal",
  severity: "block",
  run: (ctx) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CI_TIMEOUT_MS;
    const pollMs = options.pollIntervalMs ?? DEFAULT_CI_POLL_MS;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));
    const deadline = now() + timeoutMs;
    const poll = (): Promise<CheckResult> => {
      const look = lookAtCi(ctx);
      const result = settled(look);
      if (result !== undefined) {
        return Promise.resolve(result);
      }
      return now() >= deadline
        ? Promise.resolve(atTimeout(look, timeoutMs))
        : sleep(pollMs).then(poll);
    };
    return Promise.resolve().then(poll);
  },
});

/** Configures `postflightChecks`. */
export interface PostflightOptions {
  /** The exit code of the loop being checked. */
  readonly exitCode: number;
  /** Passed to `prBodyShape`. */
  readonly prBody?: { readonly headings?: readonly string[] };
  /** Passed to `ciTerminal`. */
  readonly ci?: CiTerminalOptions;
}

/** Every postflight check, in the order a report lists them. */
export const postflightChecks = (options: PostflightOptions): Check[] => [
  runExited(options.exitCode),
  prExists,
  prBodyShape(options.prBody),
  ciTerminal(options.ci),
];
