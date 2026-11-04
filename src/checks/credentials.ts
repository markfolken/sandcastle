/**
 * Recognises credentials in git remotes and config, and keeps them out of
 * everything the checks print: a report often ends up in a CI log or a PR.
 */

const CREDENTIAL_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  { label: "a credential in an http(s) URL", pattern: /https?:\/\/[^/\s]*@/iu },
  { label: "a GitHub token", pattern: /(?<![A-Za-z0-9])gh[pousr]_/u },
  { label: "a GitHub token", pattern: /github_pat_/u },
  { label: "an x-access-token", pattern: /x-access-token/iu },
  { label: "an Authorization header", pattern: /authorization:/iu },
];

/** What kind of credential `text` contains, or undefined when it has none. */
export const findCredential = (text: string): string | undefined =>
  CREDENTIAL_PATTERNS.find(({ pattern }) => pattern.test(text))?.label;

/** `text` with every credential it contains replaced by `<redacted>`. */
export const redactCredentials = (text: string): string =>
  text
    .replaceAll(/(?<scheme>https?:\/\/)[^/\s'"]*@/giu, "$<scheme><redacted>@")
    .replaceAll(
      /(?<![A-Za-z0-9])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]*/gu,
      "<redacted>",
    )
    .replaceAll(/x-access-token:[^@\s/]*/giu, "x-access-token:<redacted>")
    .replaceAll(/authorization:[^\n]*/giu, "Authorization: <redacted>");
