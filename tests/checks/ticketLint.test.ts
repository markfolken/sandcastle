import {
  exitCodeFor,
  EXIT_OK,
  EXIT_REFUSED,
  runTicketLint,
  ticketLint,
} from "@ai-hero/sandcastle/checks";
import type { Runner, TicketFinding } from "@ai-hero/sandcastle/checks";
import { describe, expect, it } from "vitest";
import { fakeRunner } from "../helpers/fakeRunner.js";
import type { FakeAnswer } from "../helpers/fakeRunner.js";

const FILES = [
  "packages/foo/baz.py",
  "src/index.ts",
  "README.md",
  "docs/guide/run.md",
];
const LS_FILES = "git ls-files -z";
const curl = (url: string) =>
  `curl --silent --output /dev/null --write-out %{http_code} --max-time 10 ${url}`;
const pypi = (name: string) => curl(`https://pypi.org/pypi/${name}/json`);

const runner = (answers: Readonly<Record<string, FakeAnswer>> = {}) =>
  fakeRunner({ [LS_FILES]: FILES.join("\0"), ...answers });

const lint = (body: string, run: Runner = runner()): TicketFinding[] =>
  ticketLint({ title: "A ticket", body }, run);

const curlMissing: Runner = (cmd) => {
  if (cmd === "curl") {
    throw new Error("spawn curl ENOENT");
  }
  return { status: 0, stdout: "", stderr: "" };
};

describe("nonexistent paths", () => {
  it("deleted path: blocks, quoting the line and naming the closest match", () => {
    const line = "Fix the parser in `packages/foo/bar.py`.";
    const [found] = lint(`Intro\n\n${line}`);
    expect(found?.kind).toBe("nonexistent-path");
    expect(found?.severity).toBe("block");
    expect(found?.line).toBe(line);
    expect(found?.message).toContain("packages/foo/baz.py");
  });

  it("moved file: names the file with the same name elsewhere", () => {
    const [found] = lint("See `lib/index.ts`");
    expect(found?.message).toContain("src/index.ts");
  });

  it("offers no closest match when nothing is close", () => {
    const [found] = lint("See `totally/unrelated/thing.rs`");
    expect(found?.severity).toBe("block");
    expect(found?.message).not.toContain("Closest match");
  });

  it("a file the line may create is a warning, not a block", () => {
    const [found] = lint("Create `src/brandNew.ts` for this.");
    expect(found?.severity).toBe("warn");
  });

  it.each([
    "`src/index.ts`",
    "`./src/index.ts`",
    "`src/index.ts:12`",
    "`docs/guide/`",
    "`README.md`",
    "`origin/main`",
    "`owner/repo`",
    "`application/json`",
    "`@ai-hero/sandcastle`",
    "`process.env`",
    "`/etc/hosts`",
    "`https://example.com/a.py`",
    "`docs/guide/<slug>.md`",
    "`npm run build`",
    "```\nnot/real/path.py\n```",
  ])("does not false-block %s", (code) => {
    expect(lint(code)).toStrictEqual([]);
  });

  it("a repo it can't list warns that the check did not run", () => {
    const [found] = lint(
      "See `src/index.ts`",
      fakeRunner({
        [LS_FILES]: { status: 128, stderr: "not a git repository" },
      }),
    );
    expect(found?.kind).toBe("lint-incomplete");
    expect(found?.severity).toBe("warn");
  });
});

describe("wrong install name", () => {
  it.each(["pipx install", "pip install", "uv tool install"])(
    "wrong package name: %s of a name PyPI 404s blocks",
    (command) => {
      const line = `Run \`${command} not-a-real-dist\` first.`;
      const [found] = lint(line, runner({ [pypi("not-a-real-dist")]: "404" }));
      expect(found?.kind).toBe("wrong-install-name");
      expect(found?.severity).toBe("block");
      expect(found?.line).toBe(line);
    },
  );

  it("names the real distribution when a likely variant exists", () => {
    const [found] = lint(
      "`pipx install widget`",
      runner({ [pypi("widget")]: "404", [pypi("widget-cli")]: "200" }),
    );
    expect(found?.suggestion).toContain("widget-cli");
  });

  it("network unavailable: warns the check could not run, never a false block", () => {
    const [found] = lint(
      "`pip install requests`",
      runner({ [pypi("requests")]: { status: 6, stdout: "000" } }),
    );
    expect(found?.kind).toBe("lint-incomplete");
    expect(found?.severity).toBe("warn");
    expect(found?.message).toContain("did not run");
  });

  it("a Runner that throws because curl is missing warns too", () => {
    expect(lint("`pip install requests`", curlMissing)[0]?.severity).toBe(
      "warn",
    );
  });

  it("a registry error is not a 404", () => {
    const [found] = lint(
      "`pip install requests`",
      runner({ [pypi("requests")]: "503" }),
    );
    expect(found?.severity).toBe("warn");
  });

  it("passes a distribution PyPI has, stripping extras and versions", () => {
    const run = runner({ [pypi("requests")]: "200", [pypi("flask")]: "200" });
    expect(
      lint("`pip install -U requests[socks]==2.0 flask`", run),
    ).toStrictEqual([]);
  });

  it.each([
    "`pip install -e .`",
    "`pip install -r requirements.txt`",
    "`pip install ./local/pkg`",
    "`pip install git+https://github.com/o/r`",
    "`pip install --index-url https://corp/simple internal-thing`",
    "`pip install <package>`",
    "Then pip install the dependencies.",
    "Remember to pip install it.",
  ])("never asks PyPI about %s", (line) => {
    const run = runner();
    lint(line, run);
    expect(run.calls.filter((call) => call.startsWith("curl"))).toStrictEqual(
      [],
    );
  });

  it("reads install commands in a code fence", () => {
    const [found] = lint(
      "```bash\npip install not-a-real-dist\n```",
      runner({ [pypi("not-a-real-dist")]: "404" }),
    );
    expect(found?.severity).toBe("block");
  });
});

describe("unverifiable criteria", () => {
  it.each([
    "- [ ] the integration test passes when RUN_LIVE_TESTS is set",
    "- [ ] requires TEST_API_KEY for the test suite",
    "- [ ] RUN_E2E=1 pytest passes",
  ])("env-gated test warns with a rewrite: %s", (line) => {
    const [found] = lint(line);
    expect(found?.kind).toBe("unverifiable-criterion");
    expect(found?.severity).toBe("warn");
    expect(found?.line).toBe(line);
    expect(found?.suggestion).toContain("command");
  });

  it("published artifact that does not exist warns", () => {
    const [found] = lint(
      "`ghost-dist` is published on PyPI",
      runner({ [pypi("ghost-dist")]: "404" }),
    );
    expect(found?.kind).toBe("unverifiable-criterion");
    expect(found?.message).toContain("doesn't exist");
    expect(found?.suggestion).toBeDefined();
  });

  it("checks an npm claim against npm, with a scoped name", () => {
    const [found] = lint(
      "`@scope/ghost` is available on npm",
      runner({ [curl("https://registry.npmjs.org/@scope%2Fghost")]: "404" }),
    );
    expect(found?.kind).toBe("unverifiable-criterion");
  });

  it("a published artifact that exists is fine", () => {
    expect(
      lint(
        "`real-dist` is released on PyPI",
        runner({ [pypi("real-dist")]: "200" }),
      ),
    ).toStrictEqual([]);
  });

  it("a published claim it can't check says the check did not run", () => {
    const [found] = lint("`some-dist` is published on PyPI");
    expect(found?.kind).toBe("lint-incomplete");
  });

  it("a published claim that names nothing warns", () => {
    const [found] = lint("The package is published to PyPI");
    expect(found?.kind).toBe("unverifiable-criterion");
  });

  it('"verified by running" with no command warns; with one it passes', () => {
    expect(lint("Verified by running the tool.")[0]?.suggestion).toContain(
      "npm test",
    );
    expect(lint("Verified by running `npm test`.")).toStrictEqual([]);
  });
});

describe("scope creep", () => {
  it.each([
    "While you're there, tidy the parser.",
    "while you’re there fix the rest",
    "while you are at it, rename things",
    "Also update the docs.",
    "Make everything consistent.",
  ])("warns and advises a separate ticket: %s", (line) => {
    const [found] = lint(line);
    expect(found?.kind).toBe("scope-creep");
    expect(found?.severity).toBe("warn");
    expect(found?.line).toBe(line);
    expect(found?.suggestion).toContain("separate ticket");
  });

  it("leaves an ordinary ticket alone", () => {
    expect(
      lint("Fix the crash in `src/index.ts`.\n\n- [ ] `npm test` passes"),
    ).toStrictEqual([]);
  });

  it("scans the title too", () => {
    const found = ticketLint(
      { title: "Fix it and make everything consistent", body: "" },
      runner(),
    );
    expect(found[0]?.kind).toBe("scope-creep");
  });
});

describe("runTicketLint", () => {
  const context = (body: string, run: Runner) => ({
    repoPath: "/repo",
    baseBranch: "main",
    branch: "b",
    slug: "o/r",
    env: {},
    run,
    issue: { number: 1, title: "t", body },
  });

  it("a blocking finding refuses with the ticket exit code", async () => {
    const report = await runTicketLint(context("See `gone/file.py`", runner()));
    expect(report.outcomes[0]?.status).toBe("block");
    expect(exitCodeFor(report)).toBe(EXIT_REFUSED);
  });

  it("warnings alone don't refuse", async () => {
    const report = await runTicketLint(
      context("Also update the docs.", runner()),
    );
    expect(report.outcomes[0]?.status).toBe("warn");
    expect(exitCodeFor(report)).toBe(EXIT_OK);
  });
});
