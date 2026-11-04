import type { CommandResult, Runner } from "@ai-hero/sandcastle/checks";

/** A canned answer: just stdout, or any part of a `CommandResult`. */
export type FakeAnswer = string | Partial<CommandResult>;

/**
 * A `Runner` answering from a table keyed by the command line. A command the
 * table doesn't name fails with status 127, as a missing program would, so a
 * test never passes by accident and nothing ever reaches a real git or gh.
 */
export const fakeRunner = (
  table: Readonly<Record<string, FakeAnswer>>,
): Runner & { calls: string[] } => {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const answer = table[line];
    if (answer === undefined) {
      return { status: 127, stdout: "", stderr: `${cmd}: not faked: ${line}` };
    }
    return typeof answer === "string"
      ? { status: 0, stdout: answer, stderr: "" }
      : { status: 0, stdout: "", stderr: "", ...answer };
  };
  return Object.assign(run, { calls });
};
