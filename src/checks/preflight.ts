/**
 * The checks a factory runs before starting agent work: refuse to start on a
 * broken foundation. None of them changes the working tree or the branches;
 * `baseCurrent` fetches, which only moves the remote-tracking ref.
 */

import { findCredential, redactCredentials } from "./credentials.js";
import { agentTokenValid } from "./agentToken.js";
import type { AgentTokenOptions } from "./agentToken.js";
import { failureReason, lookUpOpenPrs } from "./github.js";
import type { Check, CheckContext, CheckResult, Severity } from "./types.js";
import { parseWorktrees } from "./worktrees.js";

/** Hits or paths found, and what could not be read while looking. */
interface CredentialScan {
  readonly found: readonly string[];
  readonly unread: readonly string[];
}

const check = (
  name: string,
  severity: Severity,
  run: (ctx: CheckContext) => CheckResult,
): Check => ({
  name,
  severity,
  run: (ctx) => Promise.resolve().then(() => run(ctx)),
});

const git = (ctx: CheckContext, args: string[], cwd = ctx.repoPath) =>
  ctx.run("git", args, { cwd });

/** Compares two different SHAs: can the local one fast-forward to the remote? */
const compareBase = (
  ctx: CheckContext,
  localSha: string,
  remoteSha: string,
): CheckResult => {
  const base = ctx.baseBranch;
  const ancestor = git(ctx, [
    "merge-base",
    "--is-ancestor",
    localSha,
    remoteSha,
  ]);
  if (ancestor.status === 0) {
    return {
      ok: true,
      detail: `${base} (${localSha}) is behind origin/${base} (${remoteSha}) and can be fast-forwarded`,
    };
  }
  return ancestor.status === 1
    ? {
        ok: false,
        detail: `${base} (${localSha}) has diverged from origin/${base} (${remoteSha}): it has commits origin/${base} lacks`,
        fix: `Move those commits to a branch, then run: git checkout ${base} && git reset --hard origin/${base}`,
      }
    : {
        ok: false,
        detail: `could not compare ${base} with origin/${base}: ${failureReason(ancestor)}`,
        fix: `Run: git fetch origin ${base}`,
      };
};

/**
 * The local base branch equals `origin/<base>`, or can be fast-forwarded to
 * it. Fetches first: a stale remote-tracking ref would otherwise agree with a
 * stale local branch. A fetch that fails refuses, since nothing is confirmed.
 */
export const baseCurrent: Check = check("baseCurrent", "block", (ctx) => {
  const base = ctx.baseBranch;
  const fetched = git(ctx, ["fetch", "--quiet", "origin", base]);
  if (fetched.status !== 0) {
    return {
      ok: false,
      detail: `could not fetch origin/${base}: ${failureReason(fetched)}`,
      fix: "Restore access to origin, then rerun. Nothing can be confirmed about the base until then.",
    };
  }
  const resolve = (ref: string) =>
    git(ctx, ["rev-parse", "--verify", "--quiet", ref]);
  const local = resolve(`refs/heads/${base}`);
  const remote = resolve(`refs/remotes/origin/${base}`);
  if (local.status !== 0 || remote.status !== 0) {
    return {
      ok: false,
      detail: `${local.status === 0 ? `origin/${base}` : base} does not resolve to a commit`,
      fix: `Run: git fetch origin ${base}:${base}`,
    };
  }
  const localSha = local.stdout.trim();
  const remoteSha = remote.stdout.trim();
  return localSha === remoteSha
    ? { ok: true, detail: `${base} is at origin/${base} (${localSha})` }
    : compareBase(ctx, localSha, remoteSha);
});

/** What one directory's view of the remotes and config holds. */
const credentialsIn = (ctx: CheckContext, cwd: string): CredentialScan => {
  const remotes = git(ctx, ["remote", "-v"], cwd);
  const config = git(ctx, ["config", "--list", "--null"], cwd);
  if (remotes.status !== 0 || config.status !== 0) {
    const failed = remotes.status === 0 ? config : remotes;
    return {
      found: [],
      unread: [`could not read git config in ${cwd}: ${failureReason(failed)}`],
    };
  }
  const remoteHits = remotes.stdout.split("\n").flatMap((line) => {
    const label = findCredential(line);
    return label === undefined
      ? []
      : [`remote ${line.split(/\s/u)[0] ?? ""} contains ${label}`];
  });
  const configHits = config.stdout.split("\0").flatMap((entry) => {
    const label = findCredential(entry);
    return label === undefined
      ? []
      : [
          `config ${redactCredentials(entry.split("\n")[0] ?? "")} contains ${label}`,
        ];
  });
  return { found: [...remoteHits, ...configHits], unread: [] };
};

/** The live directories of the branch's worktrees, or why they can't be listed. */
const branchWorktreeDirs = (ctx: CheckContext): CredentialScan => {
  const listed = git(ctx, ["worktree", "list", "--porcelain"]);
  return listed.status === 0
    ? {
        found: parseWorktrees(listed.stdout)
          .filter((tree) => tree.branch === ctx.branch && !tree.prunable)
          .map((tree) => tree.path),
        unread: [],
      }
    : {
        found: [],
        unread: [`could not list worktrees: ${failureReason(listed)}`],
      };
};

/**
 * No remote URL and no git config value reachable from the repo or the
 * branch's worktree contains a credential. This exists because a sandboxed
 * agent read a token out of `git config` and pushed with it. Reports the key
 * that holds a credential, never the credential. What it can't read refuses.
 */
export const noCredentials: Check = check("noCredentials", "block", (ctx) => {
  const dirs = branchWorktreeDirs(ctx);
  const scans = [...new Set([ctx.repoPath, ...dirs.found])].map((dir) =>
    credentialsIn(ctx, dir),
  );
  const found = [...new Set(scans.flatMap((scan) => scan.found))];
  const unread = [...dirs.unread, ...scans.flatMap((scan) => scan.unread)];
  if (found.length === 0 && unread.length === 0) {
    return {
      ok: true,
      detail: "no credential in any remote URL or git config value",
    };
  }
  return {
    ok: false,
    detail: [...found, ...unread].join("; "),
    fix:
      found.length > 0
        ? "Remove it (find it with: git config --list --show-origin; then git remote set-url or git config --unset) and keep credentials in a helper outside anything a sandbox can read."
        : "Run this against a readable git repository, then rerun.",
  };
});

/**
 * No stale worktree registration for the branch, which would fail the next run
 * with a `WorktreeError`.
 */
export const worktreeClean: Check = check("worktreeClean", "block", (ctx) => {
  const listed = git(ctx, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) {
    return {
      ok: false,
      detail: `could not list worktrees: ${failureReason(listed)}`,
      fix: "Run this against a git repository, then rerun.",
    };
  }
  const entry = parseWorktrees(listed.stdout).find(
    (tree) => tree.branch === ctx.branch,
  );
  if (entry === undefined) {
    return { ok: true, detail: `no worktree registered for ${ctx.branch}` };
  }
  const stale =
    entry.prunable ||
    git(ctx, ["-C", entry.path, "rev-parse", "--is-inside-work-tree"])
      .status !== 0;
  return stale
    ? {
        ok: false,
        detail: `stale worktree registration for ${ctx.branch} at ${entry.path}`,
        fix: `Run: git worktree prune (or: git worktree remove --force ${entry.path})`,
      }
    : {
        ok: true,
        detail: `${ctx.branch} has a live worktree at ${entry.path}`,
      };
});

/** The program a shell command line would start, past any `NAME=value`. */
const interpreterOf = (command: string): string | undefined =>
  command
    .trim()
    .split(/\s+/u)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word))
    ?.replaceAll(/["']/gu, "");

/** The env var `FACTORY_TEST_CMD`, or `envKey`, is set and its interpreter exists. */
export const testCommandRunnable = (
  options: { readonly envKey?: string } = {},
): Check =>
  check("testCommandRunnable", "block", (ctx) => {
    const key = options.envKey ?? "FACTORY_TEST_CMD";
    const command = ctx.env[key] ?? "";
    const interpreter = interpreterOf(command);
    if (interpreter === undefined || interpreter === "") {
      return {
        ok: false,
        detail: `${key} is not set`,
        fix: `Set ${key} to the command that runs this repo's tests.`,
      };
    }
    const found = ctx.run("sh", ["-c", 'command -v "$1"', "sh", interpreter], {
      cwd: ctx.repoPath,
    });
    return found.status === 0
      ? { ok: true, detail: `${key} starts ${interpreter}, which exists` }
      : {
          ok: false,
          detail: `${key} starts ${interpreter}, which is not on PATH`,
          fix: `Install ${interpreter}, or point ${key} at a command that exists.`,
        };
  });

/**
 * Names the open PR when the branch already has one. Publishing is idempotent,
 * so this is information, not a blocker.
 */
export const branchHasOpenPR: Check = check(
  "branchHasOpenPR",
  "warn",
  (ctx) => {
    const lookup = lookUpOpenPrs(ctx, "number,url");
    if (!lookup.ok) {
      return { ok: false, detail: `could not look up PRs: ${lookup.reason}` };
    }
    const [pr] = lookup.prs;
    return pr === undefined
      ? { ok: true, detail: `no open PR for ${ctx.branch}` }
      : {
          ok: false,
          detail: `${ctx.branch} already has open PR #${String(pr.number)}: ${pr.url}`,
        };
  },
);

/** Configures `preflightChecks`. */
export interface PreflightOptions {
  /** Passed to `testCommandRunnable`. */
  readonly testCommand?: { readonly envKey?: string };
  /** Passed to `agentTokenValid`. */
  readonly agentToken?: AgentTokenOptions;
}

/** Every preflight check, in the order a report lists them. */
export const preflightChecks = (options: PreflightOptions = {}): Check[] => [
  baseCurrent,
  noCredentials,
  worktreeClean,
  testCommandRunnable(options.testCommand),
  agentTokenValid(options.agentToken),
  branchHasOpenPR,
];
