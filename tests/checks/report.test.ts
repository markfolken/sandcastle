import {
  EXIT_BLOCKED_BY_GATE,
  EXIT_CRASH,
  EXIT_OK,
  EXIT_PREFLIGHT_REFUSED,
  EXIT_REFUSED,
  exitCodeFor,
  renderJson,
  renderText,
  runChecks,
} from "@ai-hero/sandcastle/checks";
import type {
  Check,
  CheckContext,
  CheckPhase,
  CheckReport,
  CheckResult,
  Severity,
} from "@ai-hero/sandcastle/checks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeRunner } from "../helpers/fakeRunner.js";

const ctx: CheckContext = {
  repoPath: "/repo",
  baseBranch: "main",
  branch: "b",
  slug: "o/r",
  env: {},
  run: fakeRunner({}),
};

const check = (
  name: string,
  severity: Severity,
  result: CheckResult,
): Check => ({ name, severity, run: async () => result });
const passing = check("good", "block", { ok: true, detail: "fine" });
const blocking = check("bad", "block", {
  ok: false,
  detail: "broken",
  fix: "mend it",
});
const warning = check("meh", "warn", { ok: false, detail: "hmm" });
const crashing: Check = {
  name: "boom",
  severity: "block",
  run: async () => {
    throw new Error("kaput");
  },
};

const report = async (
  phase: CheckPhase,
  ...checks: Check[]
): Promise<CheckReport> => runChecks(phase, checks, ctx);

describe("exit codes", () => {
  it("are the conventional values", () => {
    expect({
      EXIT_OK,
      EXIT_CRASH,
      EXIT_BLOCKED_BY_GATE,
      EXIT_PREFLIGHT_REFUSED,
      EXIT_REFUSED,
    }).toStrictEqual({
      EXIT_OK: 0,
      EXIT_CRASH: 1,
      EXIT_BLOCKED_BY_GATE: 2,
      EXIT_PREFLIGHT_REFUSED: 3,
      EXIT_REFUSED: 4,
    });
  });

  it.each([
    ["preflight", EXIT_PREFLIGHT_REFUSED],
    ["postflight", EXIT_BLOCKED_BY_GATE],
    ["ticket", EXIT_REFUSED],
  ] as const)("a block in %s exits %i", async (phase, code) => {
    expect(exitCodeFor(await report(phase, passing, blocking))).toBe(code);
  });

  it("passes and warnings exit 0", async () => {
    expect(exitCodeFor(await report("preflight", passing, warning))).toBe(
      EXIT_OK,
    );
  });

  it("a blocking check that crashes exits 1: no verdict is not a verdict", async () => {
    const crashed = await report("preflight", passing, crashing);
    expect(crashed.outcomes[1]?.status).toBe("crash");
    expect(crashed.outcomes[1]?.detail).toContain("kaput");
    expect(exitCodeFor(crashed)).toBe(EXIT_CRASH);
  });

  it("a real block outranks a crash", async () => {
    expect(exitCodeFor(await report("preflight", crashing, blocking))).toBe(
      EXIT_PREFLIGHT_REFUSED,
    );
  });

  it("a warn check that crashes stays a warning", async () => {
    const crashedWarn: Check = { ...crashing, severity: "warn" };
    const result = await report("preflight", crashedWarn);
    expect(result.outcomes[0]?.status).toBe("warn");
    expect(exitCodeFor(result)).toBe(EXIT_OK);
  });

  it("a result's severity overrides its check's", async () => {
    const downgraded = check("ci", "block", {
      ok: false,
      severity: "warn",
      detail: "timed out",
    });
    const result = await report("postflight", downgraded);
    expect(result.outcomes[0]?.status).toBe("warn");
  });

  it("a check that throws synchronously is reported as a crash too", async () => {
    const throwing: Check = {
      name: "sync",
      severity: "block",
      run: () => {
        throw new Error("sync kaput");
      },
    };
    const result = await report("preflight", throwing);
    expect(result.outcomes[0]?.status).toBe("crash");
  });
});

describe("renderText", () => {
  it("prints one line per check, then the fix for each failure", async () => {
    expect(
      renderText(await report("preflight", passing, blocking, warning)),
    ).toBe(`preflight: exit 3
PASS  good: fine
BLOCK bad: broken
WARN  meh: hmm
fix bad: mend it`);
  });
});

describe("renderJson", () => {
  it("has a stable shape for machines", async () => {
    const parsed = z
      .object({
        phase: z.string(),
        ok: z.boolean(),
        exitCode: z.number(),
        checks: z.array(
          z.strictObject({
            name: z.string(),
            status: z.enum(["pass", "warn", "block", "crash"]),
            detail: z.string(),
            fix: z.string().optional(),
          }),
        ),
      })
      .parse(
        JSON.parse(renderJson(await report("postflight", passing, blocking))),
      );
    expect(parsed).toStrictEqual({
      phase: "postflight",
      ok: false,
      exitCode: 2,
      checks: [
        { name: "good", status: "pass", detail: "fine" },
        { name: "bad", status: "block", detail: "broken", fix: "mend it" },
      ],
    });
  });
});

describe("credentials never reach a report", () => {
  const TOKEN = `ghp_${"z".repeat(36)}`;

  it.each([
    ["a token", `failed with ${TOKEN}`],
    ["a URL", `fatal: https://me:hunter2@github.com/o/r not found`],
    ["a header", "sent Authorization: Bearer hunter2"],
    ["an x-access-token", "x-access-token:hunter2 rejected"],
  ])("redacts %s from a check's detail and fix", async (_kind, text) => {
    const leaky = check("leaky", "block", {
      ok: false,
      detail: text,
      fix: text,
    });
    const rendered = renderJson(await report("preflight", leaky));
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).toContain("<redacted>");
  });
});
