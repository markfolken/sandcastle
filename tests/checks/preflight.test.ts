import {
  agentTokenValid,
  baseCurrent,
  branchHasOpenPR,
  exitCodeFor,
  EXIT_OK,
  EXIT_PREFLIGHT_REFUSED,
  noCredentials,
  renderText,
  runPreflight,
  testCommandRunnable,
  worktreeClean,
} from "@ai-hero/sandcastle/checks";
import type { CheckContext, Runner } from "@ai-hero/sandcastle/checks";
import { describe, expect, it } from "vitest";
import { fakeRunner } from "../helpers/fakeRunner.js";
import type { FakeAnswer } from "../helpers/fakeRunner.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPO = "/repo";
const FETCH = "git fetch --quiet origin main";
const LOCAL = "git rev-parse --verify --quiet refs/heads/main";
const REMOTE = "git rev-parse --verify --quiet refs/remotes/origin/main";
const ANCESTOR = `git merge-base --is-ancestor ${SHA_A} ${SHA_B}`;
const ANCESTOR_REVERSED = `git merge-base --is-ancestor ${SHA_B} ${SHA_A}`;
const REMOTES = "git remote -v";
const CONFIG = "git config --list --null";
const WORKTREES = "git worktree list --porcelain";
const GH_PRS =
  "gh pr list --repo owner/repo --head agent/issue-42 --state open --json number,url";
const INTERPRETER = 'sh -c command -v "$1" sh pytest';
const MAIN_WORKTREE = `worktree ${REPO}\nHEAD ${SHA_A}\nbranch refs/heads/main\n\n`;
const CLEAN_REMOTE =
  "origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com/owner/repo.git (push)\n";

const context = (run: Runner, env: CheckContext["env"] = {}): CheckContext => ({
  repoPath: REPO,
  baseBranch: "main",
  branch: "agent/issue-42",
  slug: "owner/repo",
  env,
  run,
});

/** A repo where every preflight check passes. */
const CLEAN: Readonly<Record<string, FakeAnswer>> = {
  [FETCH]: "",
  [LOCAL]: `${SHA_A}\n`,
  [REMOTE]: `${SHA_A}\n`,
  [REMOTES]: CLEAN_REMOTE,
  [CONFIG]: "user.name\nA Person\0user.email\nperson@example.com\0",
  [WORKTREES]: MAIN_WORKTREE,
  [GH_PRS]: "[]",
  [INTERPRETER]: "/usr/bin/pytest\n",
};
const CLEAN_ENV = { FACTORY_TEST_CMD: "pytest -q", AGENT_TOKEN: "token" };

const inCredentialedRepo = async (
  answers: Readonly<Record<string, FakeAnswer>>,
) => noCredentials.run(context(fakeRunner({ ...CLEAN, ...answers })));

/** A repo whose branch worktree at /wt, and only there, has a token in config. */
const worktreeWithLeakedConfig = (token: string) => {
  const dirs: (string | undefined)[] = [];
  const run: Runner = (_cmd, args, opts) => {
    dirs.push(opts?.cwd);
    if (args[0] === "worktree") {
      return {
        status: 0,
        stdout: `${MAIN_WORKTREE}worktree /wt\nHEAD ${SHA_A}\nbranch refs/heads/agent/issue-42\n`,
        stderr: "",
      };
    }
    const leaked = opts?.cwd === "/wt" && args[0] === "config";
    return {
      status: 0,
      stdout: leaked ? `credential.x\n${token}\0` : "",
      stderr: "",
    };
  };
  return { dirs, run };
};

describe("runPreflight", () => {
  it("passes a clean fixture", async () => {
    const report = await runPreflight(context(fakeRunner(CLEAN), CLEAN_ENV));
    expect(report.outcomes.map((outcome) => outcome.status)).toStrictEqual(
      Array.from({ length: 6 }, () => "pass"),
    );
    expect(exitCodeFor(report)).toBe(EXIT_OK);
  });

  it("refuses with the preflight exit code, and still reports every check", async () => {
    const report = await runPreflight(
      context(
        fakeRunner({
          ...CLEAN,
          [LOCAL]: `${SHA_A}\n`,
          [REMOTE]: `${SHA_B}\n`,
          [ANCESTOR]: "",
        }),
        CLEAN_ENV,
      ),
    );
    expect(exitCodeFor(report)).toBe(EXIT_PREFLIGHT_REFUSED);
    expect(report.outcomes).toHaveLength(6);
    expect(renderText(report)).toContain("BLOCK baseCurrent");
  });
});

describe("baseCurrent", () => {
  it("base current: passes only when local and origin are the same commit", async () => {
    const result = await baseCurrent.run(context(fakeRunner(CLEAN)));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(SHA_A);
  });

  it("stale base re-added a deleted file: a base merely behind origin blocks, naming both SHAs and the fast-forward", async () => {
    const result = await baseCurrent.run(
      context(fakeRunner({ ...CLEAN, [REMOTE]: `${SHA_B}\n`, [ANCESTOR]: "" })),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("behind");
    expect(result.detail).toContain(SHA_A);
    expect(result.detail).toContain(SHA_B);
    expect(result.fix).toContain("git fetch origin");
    expect(result.fix).toContain("git merge --ff-only origin/main");
  });

  it("diverged base: blocks without suggesting a fast-forward that can't work", async () => {
    const result = await baseCurrent.run(
      context(
        fakeRunner({
          ...CLEAN,
          [REMOTE]: `${SHA_B}\n`,
          [ANCESTOR]: { status: 1 },
          [ANCESTOR_REVERSED]: { status: 1 },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("diverged");
    expect(result.detail).toContain(SHA_A);
    expect(result.detail).toContain(SHA_B);
    expect(result.fix).not.toContain("--ff-only");
    expect(result.fix).toContain("Do not fast-forward");
  });

  it("base ahead of origin: blocks, since unmerged local commits would leak into the branch", async () => {
    const result = await baseCurrent.run(
      context(
        fakeRunner({
          ...CLEAN,
          [REMOTE]: `${SHA_B}\n`,
          [ANCESTOR]: { status: 1 },
          [ANCESTOR_REVERSED]: "",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ahead");
    expect(result.detail).not.toContain("diverged");
    expect(result.fix).not.toContain("--ff-only");
  });

  it("tells behind from diverged without a second fetch", async () => {
    const run = fakeRunner({
      ...CLEAN,
      [REMOTE]: `${SHA_B}\n`,
      [ANCESTOR]: { status: 1 },
      [ANCESTOR_REVERSED]: { status: 1 },
    });
    await baseCurrent.run(context(run));
    expect(run.calls.filter((call) => call.includes("fetch"))).toStrictEqual([
      FETCH,
    ]);
  });

  it("stale tracking ref: fetches before comparing", async () => {
    const run = fakeRunner(CLEAN);
    await baseCurrent.run(context(run));
    expect(run.calls[0]).toBe(FETCH);
  });

  it("offline: a fetch that fails refuses instead of trusting the last known ref", async () => {
    const result = await baseCurrent.run(
      context(
        fakeRunner({
          ...CLEAN,
          [FETCH]: { status: 128, stderr: "could not resolve host" },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not resolve host");
    expect(result.fix).toContain("Nothing can be confirmed about the base");
  });

  it("a comparison git can't make refuses rather than reading as diverged or current", async () => {
    const result = await baseCurrent.run(
      context(
        fakeRunner({
          ...CLEAN,
          [REMOTE]: `${SHA_B}\n`,
          [ANCESTOR]: { status: 128, stderr: "bad object" },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("bad object");
  });

  it("a second comparison git can't make refuses too", async () => {
    const result = await baseCurrent.run(
      context(
        fakeRunner({
          ...CLEAN,
          [REMOTE]: `${SHA_B}\n`,
          [ANCESTOR]: { status: 1 },
          [ANCESTOR_REVERSED]: { status: 128, stderr: "bad object" },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not compare");
  });
});

describe("noCredentials", () => {
  const TOKEN = `ghp_${"x".repeat(36)}`;

  it("token in git config: refuses a credentialed remote URL, without printing it", async () => {
    const result = await inCredentialedRepo({
      [REMOTES]: `origin\thttps://me:${TOKEN}@github.com/owner/repo.git (fetch)\n`,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("remote origin");
    expect(result.detail).not.toContain(TOKEN);
  });

  it.each([
    ["ghp_", `ghp_${"a".repeat(36)}`],
    ["gho_", `gho_${"a".repeat(36)}`],
    ["github_pat_", `github_pat_${"a".repeat(30)}`],
    ["x-access-token", "https://x-access-token:abc@github.com/o/r"],
    ["Authorization:", "AUTHORIZATION: basic abc"],
    ["@ in an https URL", "https://someone@github.com/o/r"],
  ])("refuses %s in a config value", async (_name, value) => {
    const result = await inCredentialedRepo({
      [CONFIG]: `http.https://github.com/.extraheader\n${value}\0`,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("extraheader");
    expect(result.detail).not.toContain(value);
  });

  it("insteadOf: a token in a config key is found, and redacted from the report", async () => {
    const result = await inCredentialedRepo({
      [CONFIG]: `url.https://x-access-token:${TOKEN}@github.com/.insteadof\nhttps://github.com/\0`,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(TOKEN);
  });

  it("does not mistake an ssh remote, an email or an @ in a URL path for a credential", async () => {
    const result = await inCredentialedRepo({
      [REMOTES]: "origin\tgit@github.com:owner/repo.git (fetch)\n",
      [CONFIG]:
        "user.email\nperson@example.com\0a.b\nhttps://npmjs.com/package/@scope/x\0c.d\nlaughs_loudly\0",
    });
    expect(result).toStrictEqual({
      ok: true,
      detail: "no credential in any remote URL or git config value",
    });
  });

  it("also reads the config the branch's worktree sees", async () => {
    const { dirs, run } = worktreeWithLeakedConfig(TOKEN);
    const result = await noCredentials.run(context(run));
    expect(dirs).toContain("/wt");
    expect(result.ok).toBe(false);
  });

  it("config it can't read refuses rather than reading as clean", async () => {
    const result = await inCredentialedRepo({
      [CONFIG]: { status: 128, stderr: "not a git repository" },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not a git repository");
    expect(result.fix).not.toContain("Remove it");
  });

  it("worktrees it can't list refuse: the branch's config went unread", async () => {
    const result = await inCredentialedRepo({
      [WORKTREES]: { status: 128, stderr: "worktree list broke" },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("worktree list broke");
  });
});

describe("worktreeClean", () => {
  const entry = (extra: string) =>
    `${MAIN_WORKTREE}worktree /gone\nHEAD ${SHA_A}\nbranch refs/heads/agent/issue-42\n${extra}\n`;
  const PROBE = "git -C /gone rev-parse --is-inside-work-tree";

  it("WorktreeError on the next run: refuses a stale registration git calls prunable", async () => {
    const result = await worktreeClean.run(
      context(
        fakeRunner({
          [WORKTREES]: entry(
            "prunable gitdir file points to non-existent location",
          ),
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.fix).toContain("git worktree prune");
    expect(result.fix).toContain("git worktree remove");
  });

  it("refuses a registration whose directory no longer works", async () => {
    const result = await worktreeClean.run(
      context(fakeRunner({ [WORKTREES]: entry(""), [PROBE]: { status: 128 } })),
    );
    expect(result.ok).toBe(false);
  });

  it("passes a live worktree, which a run reuses", async () => {
    const result = await worktreeClean.run(
      context(fakeRunner({ [WORKTREES]: entry(""), [PROBE]: "true\n" })),
    );
    expect(result.ok).toBe(true);
  });
});

describe("testCommandRunnable", () => {
  it("refuses when the variable is unset", async () => {
    const result = await testCommandRunnable().run(context(fakeRunner({})));
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("FACTORY_TEST_CMD is not set");
  });

  it("refuses when the interpreter does not exist", async () => {
    const result = await testCommandRunnable().run(
      context(fakeRunner({}), { FACTORY_TEST_CMD: "pytest -q" }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("pytest");
  });

  it("takes a configurable key, and looks past env assignments", async () => {
    const result = await testCommandRunnable({ envKey: "MY_TESTS" }).run(
      context(fakeRunner(CLEAN), { MY_TESTS: "CI=1 pytest -q" }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("agentTokenValid", () => {
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const check = agentTokenValid({ now: () => NOW });
  const jwt = (exp: number) =>
    `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

  it("warns, never blocks, when no token resolves", async () => {
    const result = await check.run(context(fakeRunner({})));
    expect(check.severity).toBe("warn");
    expect(result.ok).toBe(false);
  });

  it("passes an env token with no expiry, and never prints it", async () => {
    const result = await check.run(
      context(fakeRunner({}), { AGENT_TOKEN: "s3cret" }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).not.toContain("s3cret");
  });

  it("warns on an expired JWT, and passes one still valid", async () => {
    const past = await check.run(
      context(fakeRunner({}), { AGENT_TOKEN: jwt(NOW / 1000 - 60) }),
    );
    const future = await check.run(
      context(fakeRunner({}), { AGENT_TOKEN: jwt(NOW / 1000 + 60) }),
    );
    expect(past.ok).toBe(false);
    expect(past.detail).toContain("expired");
    expect(future.ok).toBe(true);
  });

  it("reads an expiry in ms from a nested token file", async () => {
    const result = await check.run(
      context(
        fakeRunner({
          "cat /token.json": JSON.stringify({
            claudeAiOauth: { accessToken: "x", expiresAt: NOW - 1 },
          }),
        }),
        { AGENT_TOKEN_FILE: "/token.json" },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/token.json");
  });

  it("warns when the token file can't be read", async () => {
    const result = await check.run(
      context(fakeRunner({}), { AGENT_TOKEN_FILE: "/missing" }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/missing");
  });
});

describe("branchHasOpenPR", () => {
  it("names an open PR as a warning, not a blocker", async () => {
    const result = await branchHasOpenPR.run(
      context(
        fakeRunner({
          [GH_PRS]:
            '[{"number":7,"url":"https://github.com/owner/repo/pull/7"}]',
        }),
      ),
    );
    expect(branchHasOpenPR.severity).toBe("warn");
    expect(result.detail).toContain("#7");
    expect(result.detail).toContain("/pull/7");
  });
});
