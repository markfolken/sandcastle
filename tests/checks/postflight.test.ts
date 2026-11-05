import {
  ciTerminal,
  exitCodeFor,
  EXIT_BLOCKED_BY_GATE,
  EXIT_OK,
  prBodyShape,
  prExists,
  runExited,
  runPostflight,
} from "@ai-hero/sandcastle/checks";
import type { CheckContext, Runner } from "@ai-hero/sandcastle/checks";
import { describe, expect, it } from "vitest";
import { fakeRunner } from "../helpers/fakeRunner.js";

const SCOPE = "--repo owner/repo --head agent/issue-42 --state open --json";
const PR_LIST = `gh pr list ${SCOPE} number,url`;
const PR_BODY = `gh pr list ${SCOPE} number,url,body`;
const ROLLUP = `gh pr list ${SCOPE} number,statusCheckRollup`;
const PR = { number: 9, url: "https://github.com/owner/repo/pull/9" };
const GOOD_BODY =
  "## Summary\nx\n## Evidence\nx\n## Review\nx\n## Merge Danger\nx";

const context = (run: Runner): CheckContext => ({
  repoPath: "/repo",
  baseBranch: "main",
  branch: "agent/issue-42",
  slug: "owner/repo",
  env: {},
  run,
});

const rollup = (...items: readonly object[]) =>
  JSON.stringify([{ number: 9, statusCheckRollup: items }]);
const checkRun = (name: string, status: string, conclusion: string) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});

/** A clock that only moves when the check sleeps, so no test waits. */
const fakeTime = (timeoutMs: number, pollIntervalMs: number) => {
  let time = 0;
  return {
    timeoutMs,
    pollIntervalMs,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
};

/** A CI run that finishes on the third look, counting looks in `looks`. */
const finishesOnThirdLook = () => {
  const state = { looks: 0 };
  const run: Runner = () => {
    state.looks += 1;
    return {
      status: 0,
      stderr: "",
      stdout: rollup(
        state.looks < 3
          ? checkRun("ci", "IN_PROGRESS", "")
          : checkRun("ci", "COMPLETED", "SUCCESS"),
      ),
    };
  };
  return { state, run };
};

describe("runPostflight", () => {
  it("crashed publisher looked successful: exit 0 but no PR blocks", async () => {
    const report = await runPostflight(
      context(
        fakeRunner({
          [PR_LIST]: "[]",
          [PR_BODY]: "[]",
          [ROLLUP]: "[]",
        }),
      ),
      { exitCode: 0, ci: fakeTime(10, 5) },
    );
    expect(
      report.outcomes.find((outcome) => outcome.name === "runExited")?.status,
    ).toBe("pass");
    expect(
      report.outcomes.find((outcome) => outcome.name === "prExists")?.status,
    ).toBe("block");
    expect(exitCodeFor(report)).toBe(EXIT_BLOCKED_BY_GATE);
  });

  it("confirms a real success, end to end", async () => {
    const report = await runPostflight(
      context(
        fakeRunner({
          [PR_LIST]: JSON.stringify([PR]),
          [PR_BODY]: JSON.stringify([{ ...PR, body: GOOD_BODY }]),
          [ROLLUP]: rollup(checkRun("ci", "COMPLETED", "SUCCESS")),
        }),
      ),
      { exitCode: 0, ci: fakeTime(10, 5) },
    );
    expect(report.outcomes.map((outcome) => outcome.status)).toStrictEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(exitCodeFor(report)).toBe(EXIT_OK);
  });

  it("CI pending at timeout: warns without blocking, so the exit code stays 0", async () => {
    const report = await runPostflight(
      context(
        fakeRunner({
          [PR_LIST]: JSON.stringify([PR]),
          [PR_BODY]: JSON.stringify([{ ...PR, body: GOOD_BODY }]),
          [ROLLUP]: rollup(checkRun("ci", "IN_PROGRESS", "")),
        }),
      ),
      { exitCode: 0, ci: fakeTime(10, 5) },
    );
    const ci = report.outcomes.find((outcome) => outcome.name === "ciTerminal");
    expect(ci?.status).toBe("warn");
    expect(exitCodeFor(report)).toBe(EXIT_OK);
  });
});

describe("runExited", () => {
  it("blocks a non-zero exit, naming the code", async () => {
    const result = await runExited(7).run(context(fakeRunner({})));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("7");
  });
});

describe("prExists", () => {
  it("gh down is not 'no PR': it says the PR could not be confirmed", async () => {
    const result = await prExists.run(
      context(
        fakeRunner({ [PR_LIST]: { status: 1, stderr: "gh auth login" } }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not confirm");
    expect(result.detail).toContain("gh auth login");
  });

  it("output that isn't JSON blocks rather than reading as a PR or as none", async () => {
    const result = await prExists.run(
      context(fakeRunner({ [PR_LIST]: "<html>502</html>" })),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not confirm");
  });
});

describe("prBodyShape", () => {
  const withBody = (body: string) =>
    context(fakeRunner({ [PR_BODY]: JSON.stringify([{ ...PR, body }]) }));

  it("missing headings block, and each is named", async () => {
    const result = await prBodyShape().run(withBody("## Summary\nhello"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("## Evidence, ## Review, ## Merge Danger");
  });

  it("a heading only mentioned mid-line doesn't count", async () => {
    const result = await prBodyShape({ headings: ["## Summary"] }).run(
      withBody("See ## Summary below"),
    );
    expect(result.ok).toBe(false);
  });

  it("takes configurable headings", async () => {
    const result = await prBodyShape({ headings: ["# Why"] }).run(
      withBody("# Why\r\nbecause"),
    );
    expect(result.ok).toBe(true);
  });

  it("no PR to read blocks", async () => {
    const result = await prBodyShape().run(
      context(fakeRunner({ [PR_BODY]: "[]" })),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no open PR");
  });
});

describe("ciTerminal", () => {
  const withRollup = (...items: readonly object[]) =>
    context(fakeRunner({ [ROLLUP]: rollup(...items) }));
  const quick = () => ciTerminal(fakeTime(10, 5));

  it("a failing run blocks and names itself, without waiting for the rest", async () => {
    const result = await quick().run(
      withRollup(
        checkRun("lint", "COMPLETED", "FAILURE"),
        checkRun("slow", "IN_PROGRESS", ""),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.severity).toBeUndefined();
    expect(result.detail).toContain("lint");
    expect(result.detail).not.toContain("slow");
  });

  it("reads a legacy status context, by its context name", async () => {
    const result = await quick().run(
      withRollup({
        __typename: "StatusContext",
        context: "ci/old",
        state: "ERROR",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ci/old");
  });

  it("skipped and neutral runs are terminal and fine", async () => {
    const result = await quick().run(
      withRollup(
        checkRun("a", "COMPLETED", "SKIPPED"),
        checkRun("b", "COMPLETED", "NEUTRAL"),
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("a timeout says so explicitly, and names what's still pending", async () => {
    const result = await quick().run(withRollup(checkRun("e2e", "QUEUED", "")));
    expect(result.ok).toBe(false);
    expect(result.severity).toBe("warn");
    expect(result.detail).toContain("TIMED OUT");
    expect(result.detail).toContain("NOT confirmed");
    expect(result.detail).toContain("e2e");
  });

  it("a conclusion it doesn't know is not a pass", async () => {
    const result = await quick().run(
      withRollup(checkRun("new", "COMPLETED", "SOMETHING_NEW")),
    );
    expect(result.ok).toBe(false);
    expect(result.severity).toBe("warn");
  });

  it("no runs at all times out as a warning, not a pass", async () => {
    const result = await quick().run(withRollup());
    expect(result.ok).toBe(false);
    expect(result.severity).toBe("warn");
    expect(result.detail).toContain("no check runs appeared");
  });

  it("polls until the runs finish", async () => {
    const { state, run } = finishesOnThirdLook();
    const result = await ciTerminal(fakeTime(100, 5)).run(context(run));
    expect(result.ok).toBe(true);
    expect(state.looks).toBe(3);
  });

  it("fork PR: finds the runs through the query that found the PR, and gh pr list can see forks", async () => {
    const run = fakeRunner({
      [ROLLUP]: rollup(checkRun("ci", "COMPLETED", "SUCCESS")),
    });
    const result = await ciTerminal(fakeTime(10, 5)).run(context(run));
    expect(result.ok).toBe(true);
    expect(run.calls).toStrictEqual([ROLLUP]);
  });

  it("no PR blocks at once, without waiting out the timeout", async () => {
    const run = fakeRunner({ [ROLLUP]: "[]" });
    const result = await ciTerminal(fakeTime(1000, 5)).run(context(run));
    expect(result.ok).toBe(false);
    expect(result.severity).toBeUndefined();
    expect(run.calls).toHaveLength(1);
  });

  it("gh that never answers blocks: unread CI is not a slow CI", async () => {
    const result = await quick().run(
      context(fakeRunner({ [ROLLUP]: { status: 1, stderr: "HTTP 401" } })),
    );
    expect(result.ok).toBe(false);
    expect(result.severity).toBeUndefined();
    expect(result.detail).toContain("HTTP 401");
  });
});
