/** Tells paths from other inline code in a ticket, and looks them up in the repo. */

/** Extensions that make a bare word (no `/`) a file name, not `process.env` or `v1.2`. */
const FILE_EXTENSIONS = new Set(
  "c cc cfg cjs conf cpp cs css go h html java js json jsx kt lock md mjs py rb rs sh sql svelte toml ts tsx txt vue xml yaml yml".split(
    " ",
  ),
);
const PATH_CHARS = /^[\w@.+~/-]+$/u;
/** The largest share of a path's length an edit may change and still be "close". */
const MAX_EDIT_SHARE = 0.4;

const extensionOf = (name: string): string | undefined => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : undefined;
};

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/**
 * The repo path this inline code names, or undefined when it isn't one. Leaves
 * out what merely looks like a path: `origin/main`, `owner/repo`,
 * `application/json`, an absolute path, a URL, a placeholder. A slashed name
 * with no extension counts only when its first segment is in the repo.
 */
export const isPathLike = (
  code: string,
  files: readonly string[],
): string | undefined => {
  const path = code.replace(/(?::\d+)+$|#.*$/u, "").replace(/^\.\//u, "");
  if (!PATH_CHARS.test(path) || path.startsWith("/") || path.startsWith("~")) {
    return undefined;
  }
  if (!path.includes("/")) {
    return FILE_EXTENSIONS.has(extensionOf(path)?.toLowerCase() ?? "")
      ? path
      : undefined;
  }
  const hasExtension = extensionOf(baseName(path)) !== undefined;
  const first = `${path.split("/")[0] ?? ""}/`;
  return hasExtension || files.some((file) => file.startsWith(first))
    ? path
    : undefined;
};

/** Whether `path` is a tracked file, a directory of one, or a bare name of one. */
export const lookupPath = (path: string, files: readonly string[]): boolean => {
  const trimmed = path.replace(/\/$/u, "");
  return files.some(
    (file) =>
      file === trimmed ||
      file.startsWith(`${trimmed}/`) ||
      (!trimmed.includes("/") && baseName(file) === trimmed),
  );
};

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(
        Math.min(
          (row[j - 1] ?? 0) + 1,
          (previous[j] ?? 0) + 1,
          (previous[j - 1] ?? 0) + cost,
        ),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
};

/**
 * The tracked file `path` most likely means: one with the same file name (it
 * moved), or else the nearest by edit distance when it's near enough.
 */
export const closestPath = (
  path: string,
  files: readonly string[],
): string | undefined => {
  const limit = Math.floor(path.length * MAX_EDIT_SHARE);
  const rank = (candidates: readonly string[], max: number) => {
    let best: { file: string; distance: number } | undefined;
    for (const file of candidates) {
      const distance = editDistance(path, file);
      if (distance <= max && (best === undefined || distance < best.distance)) {
        best = { file, distance };
      }
    }
    return best?.file;
  };
  const sameName = files.filter((file) => baseName(file) === baseName(path));
  return (
    rank(sameName, Number.POSITIVE_INFINITY) ??
    rank(
      files.filter((file) => Math.abs(file.length - path.length) <= limit),
      limit,
    )
  );
};
