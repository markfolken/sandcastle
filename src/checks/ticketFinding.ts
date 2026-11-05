import { redactCredentials } from "./credentials.js";

/** The kinds of problem ticket lint finds. `lint-incomplete` is a check that could not run. */
export type TicketFindingKind =
  | "nonexistent-path"
  | "wrong-install-name"
  | "unverifiable-criterion"
  | "scope-creep"
  | "lint-incomplete";

/** One problem in a ticket. */
export interface TicketFinding {
  /** What kind of problem this is. */
  kind: TicketFindingKind;
  /** `block` when the repo or a registry confirmed it, `warn` otherwise. */
  severity: "block" | "warn";
  /** The offending line, quoted. */
  line: string;
  /** What's wrong with it. */
  message: string;
  /** How to rewrite it, when there is a concrete way. */
  suggestion?: string;
}

/** One line of a ticket, and whether it sits in a fenced code block. */
export interface TicketLine {
  readonly text: string;
  readonly fenced: boolean;
}

/** A finding on `line`, its text trimmed and free of credentials. */
export const findingOn = (
  line: TicketLine,
  fields: Omit<TicketFinding, "line">,
): TicketFinding => ({
  ...fields,
  line: redactCredentials(line.text.trim()),
});

/** The contents of each inline code span on a line. */
export const inlineCode = (text: string): string[] =>
  [...text.matchAll(/`(?<code>[^`\n]+)`/gu)].map(
    (match) => match.groups?.["code"] ?? "",
  );
