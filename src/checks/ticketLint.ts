/**
 * Lints an issue before a run is spent on it. Blocks only on what the repo or a
 * registry confirmed; what it could not confirm is a warning that says so.
 */

import { failureReason } from "./github.js";
import { lintProse } from "./ticketCriteria.js";
import { findingOn, inlineCode } from "./ticketFinding.js";
import type { TicketFinding, TicketLine } from "./ticketFinding.js";
import { closestPath, isPathLike, lookupPath } from "./ticketPaths.js";
import { askRegistry, installedNames, pypiUrl } from "./ticketRegistry.js";
import type { Check, Runner } from "./types.js";

const toLines = (title: string, body: string): TicketLine[] => {
  const lines: TicketLine[] = [{ text: title, fenced: false }];
  let fenced = false;
  for (const text of body.split(/\r?\n/u)) {
    if (text.trimStart().startsWith("```")) {
      fenced = !fenced;
    } else if (text.trim() !== "") {
      lines.push({ text, fenced });
    }
  }
  return lines;
};

/** A line that may mean to create the file it names, so absence proves nothing. */
const MAY_CREATE =
  /\b(?:add|adds|adding|create|creates|creating|new|introduce|generate|scaffold|write)\b/iu;

const pathFindings = (
  line: TicketLine,
  files: readonly string[],
): TicketFinding[] =>
  inlineCode(line.text).flatMap((code) => {
    const path = isPathLike(code, files);
    if (path === undefined || lookupPath(path, files)) {
      return [];
    }
    const closest = closestPath(path, files);
    const hint = closest === undefined ? "" : ` Closest match: \`${closest}\`.`;
    const mayCreate = MAY_CREATE.test(line.text);
    return [
      findingOn(line, {
        kind: "nonexistent-path",
        severity: mayCreate ? "warn" : "block",
        message: `\`${path}\` is not in git ls-files${mayCreate ? ", and this line may mean to create it" : ""}.${hint}`,
      }),
    ];
  });

const lintPaths = (
  lines: readonly TicketLine[],
  run: Runner,
): TicketFinding[] => {
  const listed = run("git", ["ls-files", "-z"]);
  if (listed.status !== 0) {
    return [
      findingOn(lines[0] ?? { text: "", fenced: false }, {
        kind: "lint-incomplete",
        severity: "warn",
        message: `could not check paths, git ls-files failed: ${failureReason(listed)}`,
      }),
    ];
  }
  const files = listed.stdout.split("\0").filter((file) => file !== "");
  return lines.flatMap((line) =>
    line.fenced ? [] : pathFindings(line, files),
  );
};

/** Names worth trying when `name` is not on PyPI. */
const nameVariants = (name: string): string[] => {
  const bare = name
    .replace(/^(?:python-|py-)/iu, "")
    .replace(/-(?:cli|py|python)$/iu, "");
  return [bare, `${bare}-cli`, `python-${bare}`, `py${bare}`].filter(
    (variant) => variant.toLowerCase() !== name.toLowerCase(),
  );
};

const lintInstalls = (
  lines: readonly TicketLine[],
  run: Runner,
): TicketFinding[] => {
  const answers = new Map<string, ReturnType<typeof askRegistry>>();
  const ask = (name: string) => {
    const answer = answers.get(name) ?? askRegistry(run, pypiUrl(name));
    answers.set(name, answer);
    return answer;
  };
  return lines.flatMap((line) =>
    installedNames(line.text).flatMap((name): TicketFinding[] => {
      const answer = ask(name);
      if (answer === "exists") {
        return [];
      }
      if (answer === "unknown") {
        return [
          findingOn(line, {
            kind: "lint-incomplete",
            severity: "warn",
            message: `could not check \`${name}\` on PyPI (network unavailable?), so this check did not run.`,
          }),
        ];
      }
      const real = nameVariants(name).find(
        (variant) => ask(variant) === "exists",
      );
      return [
        findingOn(line, {
          kind: "wrong-install-name",
          severity: "block",
          message: `\`${name}\` is not on PyPI (404).`,
          ...(real === undefined
            ? {}
            : {
                suggestion: `PyPI has \`${real}\`; check it's the one you mean.`,
              }),
        }),
      ];
    }),
  );
};

/**
 * Lints `{ title, body }`. Repo and registry lookups go through `run`, which
 * should already point at the repository. A lookup that can't answer becomes a
 * warning saying the check did not run, never a block.
 */
export const ticketLint = (
  ticket: { readonly title: string; readonly body: string },
  run: Runner,
): TicketFinding[] => {
  const lines = toLines(ticket.title, ticket.body);
  return [
    ...lintPaths(lines, run),
    ...lintInstalls(lines, run),
    ...lines.flatMap((line) => lintProse(line, run)),
  ];
};

/** `ticketLint` of `ctx.issue` as a `Check`: blocks only on a blocking finding. */
export const ticketLintCheck: Check = {
  name: "ticketLint",
  severity: "block",
  run: (ctx) =>
    Promise.resolve().then(() => {
      if (ctx.issue === undefined) {
        return { ok: true, detail: "no issue to lint" };
      }
      const findings = ticketLint(ctx.issue, (cmd, args) =>
        ctx.run(cmd, args, { cwd: ctx.repoPath }),
      );
      if (findings.length === 0) {
        return { ok: true, detail: "no findings" };
      }
      return {
        ok: false,
        severity: findings.some((item) => item.severity === "block")
          ? "block"
          : "warn",
        detail: findings
          .map(({ severity, message, line, suggestion }) =>
            [`${severity}: ${message} (line: "${line}")`, suggestion]
              .filter((part) => part !== undefined)
              .join(" "),
          )
          .join("; "),
      };
    }),
};
