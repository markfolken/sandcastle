/**
 * The checks subsystem: what a factory runs before and after agent work, so
 * that infrastructure failures can't masquerade as code failures or successes.
 * See docs/guide/checks.md.
 */

import { postflightChecks } from "./checks/postflight.js";
import type { PostflightOptions } from "./checks/postflight.js";
import { preflightChecks } from "./checks/preflight.js";
import type { PreflightOptions } from "./checks/preflight.js";
import { runChecks } from "./checks/report.js";
import type { CheckReport } from "./checks/report.js";
import { ticketLintCheck } from "./checks/ticketLint.js";
import type { CheckContext } from "./checks/types.js";

export type {
  Check,
  CheckContext,
  CheckResult,
  CommandResult,
  Runner,
  Severity,
} from "./checks/types.js";
export { agentTokenValid } from "./checks/agentToken.js";
export type { AgentTokenOptions } from "./checks/agentToken.js";
export {
  baseCurrent,
  branchHasOpenPR,
  noCredentials,
  preflightChecks,
  testCommandRunnable,
  worktreeClean,
} from "./checks/preflight.js";
export type { PreflightOptions } from "./checks/preflight.js";
export {
  ciTerminal,
  DEFAULT_PR_HEADINGS,
  postflightChecks,
  prBodyShape,
  prExists,
  runExited,
} from "./checks/postflight.js";
export type {
  CiTerminalOptions,
  PostflightOptions,
} from "./checks/postflight.js";
export {
  EXIT_BLOCKED_BY_GATE,
  EXIT_CRASH,
  EXIT_OK,
  EXIT_PREFLIGHT_REFUSED,
  EXIT_REFUSED,
  exitCodeFor,
  renderJson,
  renderText,
  runChecks,
} from "./checks/report.js";
export type {
  CheckOutcome,
  CheckPhase,
  CheckReport,
  CheckStatus,
} from "./checks/report.js";
export { ticketLint, ticketLintCheck } from "./checks/ticketLint.js";
export type {
  TicketFinding,
  TicketFindingKind,
} from "./checks/ticketFinding.js";

/** Runs every preflight check. End the factory with `exitCodeFor(report)`. */
export const runPreflight = (
  ctx: CheckContext,
  options: PreflightOptions = {},
): Promise<CheckReport> =>
  runChecks("preflight", preflightChecks(options), ctx);

/** Runs every postflight check. End the factory with `exitCodeFor(report)`. */
export const runPostflight = (
  ctx: CheckContext,
  options: PostflightOptions,
): Promise<CheckReport> =>
  runChecks("postflight", postflightChecks(options), ctx);

/** Lints `ctx.issue` as a report. End the factory with `exitCodeFor(report)`. */
export const runTicketLint = (ctx: CheckContext): Promise<CheckReport> =>
  runChecks("ticket", [ticketLintCheck], ctx);
