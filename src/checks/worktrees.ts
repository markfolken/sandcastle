/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  /** The checked out branch; undefined for a detached HEAD. */
  readonly branch: string | undefined;
  /** Whether git itself calls this registration stale. */
  readonly prunable: boolean;
}

const BRANCH_PREFIX = "branch refs/heads/";

/** Parses `git worktree list --porcelain`. */
export const parseWorktrees = (porcelain: string): WorktreeEntry[] =>
  porcelain
    .split(/\r?\n\r?\n/u)
    .map((block) => block.split(/\r?\n/u))
    .flatMap((lines) => {
      const path = lines.find((line) => line.startsWith("worktree "));
      if (path === undefined) {
        return [];
      }
      const branch = lines.find((line) => line.startsWith(BRANCH_PREFIX));
      return [
        {
          path: path.slice("worktree ".length),
          branch: branch?.slice(BRANCH_PREFIX.length),
          prunable: lines.some(
            (line) => line === "prunable" || line.startsWith("prunable "),
          ),
        },
      ];
    });
