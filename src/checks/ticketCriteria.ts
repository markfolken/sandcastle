/** The ticket lints that only ever warn: unverifiable criteria and scope creep. */

import { findingOn, inlineCode } from "./ticketFinding.js";
import type { TicketFinding, TicketLine } from "./ticketFinding.js";
import { askRegistry, npmUrl, pypiUrl } from "./ticketRegistry.js";
import type { Runner } from "./types.js";

const ENV_NAME = "[A-Z][A-Z0-9]*_[A-Z0-9_]+";
const NAMES_A_TEST = /\b(?:tests?|pytest|vitest|suite)\b/iu;
const GATES_ON_ENV = new RegExp(
  String.raw`\b${ENV_NAME}=|\b(?:requires?|needs?|when|if|unless|with|behind|by|on)\s+.?${ENV_NAME}\b`,
  "u",
);
const PUBLISHED =
  /\b(?:published|released|available|installable)\b.*\b(?<registry>PyPI|npm)\b/iu;
const VERIFIED_BY_RUNNING = /\b(?:verif|confirm)\w*\s+by\s+running\b/iu;
const SCOPE_CREEP =
  /\bwhile you(?:['’]| a)re (?:there|here|at it|in there)\b|\bwhile we(?:['’]| a)re (?:there|here|at it)\b|\balso update the docs\b|\bmake everything consistent\b|\bclean up anything\b|\band anything else\b|\bany other (?:issues?|problems?|bugs?) you (?:find|see|notice)\b|\bdrive-by\b/iu;

const unverifiable = (
  line: TicketLine,
  message: string,
  suggestion: string,
): TicketFinding =>
  findingOn(line, {
    kind: "unverifiable-criterion",
    severity: "warn",
    message,
    suggestion,
  });

const lintPublishedClaim = (line: TicketLine, run: Runner): TicketFinding[] => {
  const registry = PUBLISHED.exec(line.text)?.groups?.["registry"];
  if (registry === undefined) {
    return [];
  }
  const name = inlineCode(line.text).find((code) => !/\s/u.test(code));
  if (name === undefined) {
    return [
      unverifiable(
        line,
        `this claims something is on ${registry} without naming it.`,
        `Name the exact package in backticks: "\`my-package\` is on ${registry}".`,
      ),
    ];
  }
  const isNpm = registry.toLowerCase() === "npm";
  const answer = askRegistry(run, isNpm ? npmUrl(name) : pypiUrl(name));
  if (answer === "exists") {
    return [];
  }
  return answer === "missing"
    ? [
        unverifiable(
          line,
          `this claims \`${name}\` is published on ${registry}, and it doesn't exist there (404).`,
          `Publish it first, or rewrite it as something a run can show: "the built package installs from a local path".`,
        ),
      ]
    : [
        findingOn(line, {
          kind: "lint-incomplete",
          severity: "warn",
          message: `could not check \`${name}\` on ${registry} (network unavailable?), so this check did not run.`,
        }),
      ];
};

const lintEnvGated = (line: TicketLine): TicketFinding[] =>
  NAMES_A_TEST.test(line.text) && GATES_ON_ENV.test(line.text)
    ? [
        unverifiable(
          line,
          "this criterion rests on an env-var-gated test, which skips silently where the variable is unset.",
          "Name a command that runs without the variable, or say who runs the gated test and where its output goes.",
        ),
      ]
    : [];

const lintVerifiedByRunning = (line: TicketLine): TicketFinding[] =>
  VERIFIED_BY_RUNNING.test(line.text) && inlineCode(line.text).length === 0
    ? [
        unverifiable(
          line,
          `"verified by running" names no command.`,
          'Name the command and what it shows: "`npm test` passes".',
        ),
      ]
    : [];

const lintScopeCreep = (line: TicketLine): TicketFinding[] =>
  SCOPE_CREEP.test(line.text)
    ? [
        findingOn(line, {
          kind: "scope-creep",
          severity: "warn",
          message: "this invites changes outside the ticket's stated files.",
          suggestion: "Move it to a separate ticket.",
        }),
      ]
    : [];

/** Every warning-only finding on one line outside a code fence. */
export const lintProse = (line: TicketLine, run: Runner): TicketFinding[] =>
  line.fenced
    ? []
    : [
        ...lintEnvGated(line),
        ...lintPublishedClaim(line, run),
        ...lintVerifiedByRunning(line),
        ...lintScopeCreep(line),
      ];
