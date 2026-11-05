/**
 * Asks a package registry whether a name exists, and reads install commands
 * out of a ticket's lines. Only a 404 counts as "missing": anything else
 * (no network, no curl, a 500) means the question could not be answered.
 */

import type { Runner } from "./types.js";

/** What a registry said about a name. */
export type RegistryAnswer = "exists" | "missing" | "unknown";

/** The JSON metadata URL of a PyPI distribution. */
export const pypiUrl = (name: string): string =>
  `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;

/** The metadata URL of an npm package. */
export const npmUrl = (name: string): string =>
  `https://registry.npmjs.org/${name.replace("/", "%2F")}`;

/** Asks one registry URL. A Runner that throws counts as no answer. */
export const askRegistry = (run: Runner, url: string): RegistryAnswer => {
  try {
    const result = run("curl", [
      "--silent",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--max-time",
      "10",
      url,
    ]);
    if (result.status !== 0) {
      return "unknown";
    }
    const code = result.stdout.trim();
    if (code === "404") {
      return "missing";
    }
    return code.startsWith("2") ? "exists" : "unknown";
  } catch {
    return "unknown";
  }
};

const INSTALL = /\b(?:pipx|pip3?|uv\s+tool)\s+install\s+(?<rest>[^`\n;&|]*)/giu;
/** Flags that take no value, so the words after them are still package names. */
const PLAIN_FLAGS = new Set([
  "-U",
  "--upgrade",
  "--user",
  "-q",
  "--quiet",
  "--force",
  "--pre",
  "--no-cache-dir",
  "--break-system-packages",
]);
/** Flags that name another index, where PyPI's answer says nothing. */
const OTHER_INDEX =
  /(?:^|\s)(?:-i|--index-url|--extra-index-url|--index)(?:\s|=)/u;
/** Words prose puts after "pip install" that aren't package names. */
const PROSE_WORDS = new Set(
  "a an and any all as dependencies deps from in into it its of or our package packages requirements the them then this to using via with your".split(
    " ",
  ),
);
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/** The distribution name in one word of an install command, if it has one. */
const nameOfWord = (word: string): string | undefined => {
  const [name] = word
    .replaceAll(/^["']|["'.,;:)]+$/gu, "")
    .split(/\[|==|>=|<=|~=|!=|>|<|@/u);
  return name !== undefined &&
    NAME.test(name) &&
    !PROSE_WORDS.has(name.toLowerCase())
    ? name
    : undefined;
};

/** The names to look up on PyPI from one word list. Stops at a flag it can't read. */
const namesOfWords = (words: readonly string[]): string[] => {
  const names: string[] = [];
  for (const word of words) {
    if (word.startsWith("-") && !PLAIN_FLAGS.has(word)) {
      return names;
    }
    const name = word.startsWith("-") ? undefined : nameOfWord(word);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
};

/**
 * The PyPI names one line installs. Paths, URLs, placeholders and anything
 * from another index are left out: PyPI's answer would say nothing about them.
 * Outside code, only the first word is read, since the rest may well be prose.
 */
export const installedNames = (line: string): string[] =>
  [...line.matchAll(INSTALL)].flatMap((match) => {
    const rest = match.groups?.["rest"] ?? "";
    if (OTHER_INDEX.test(rest)) {
      return [];
    }
    const start = match.index;
    const inCode =
      /^\s*\$\s/u.test(line) ||
      (line.slice(0, start).match(/`/gu) ?? []).length % 2 === 1;
    const words = rest
      .trim()
      .split(/\s+/u)
      .filter((word) => word !== "");
    return namesOfWords(inCode ? words : words.slice(0, 1));
  });
