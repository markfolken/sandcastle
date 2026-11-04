import type { CheckContext, CommandResult } from "./types.js";

/** An open pull request, as `gh pr list` describes it. */
export interface OpenPr {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

/** The open PRs of a branch, or why they could not be read. */
export type PrLookup =
  | { readonly ok: true; readonly prs: readonly OpenPr[] }
  | { readonly ok: false; readonly reason: string };

/** The reason a command failed: its stderr, or else its exit code. */
export const failureReason = (result: CommandResult): string => {
  const stderr = result.stderr.trim();
  return stderr === "" ? `exit code ${String(result.status)}` : stderr;
};

/** Parses JSON, or gives undefined when the text isn't JSON. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Whether a parsed JSON value is an object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toOpenPr = (value: unknown): OpenPr[] => {
  if (
    !isRecord(value) ||
    typeof value["number"] !== "number" ||
    typeof value["url"] !== "string"
  ) {
    return [];
  }
  const body = typeof value["body"] === "string" ? value["body"] : "";
  return [{ number: value["number"], url: value["url"], body }];
};

/** Asks gh for the open PRs of `ctx.branch`. A gh failure is not "no PRs". */
export const lookUpOpenPrs = (ctx: CheckContext, fields: string): PrLookup => {
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
      fields,
    ],
    { cwd: ctx.repoPath },
  );
  if (result.status !== 0) {
    return { ok: false, reason: failureReason(result) };
  }
  const parsed = parseJson(result.stdout);
  return Array.isArray(parsed)
    ? { ok: true, prs: parsed.flatMap((item) => toOpenPr(item)) }
    : { ok: false, reason: "gh pr list did not print a JSON array" };
};
