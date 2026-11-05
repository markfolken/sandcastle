import { failureReason, isRecord, parseJson } from "./github.js";
import type { Check, CheckContext, CheckResult } from "./types.js";

/** Configures `agentTokenValid`. */
export interface AgentTokenOptions {
  /** Env vars that may hold the token, tried in order. */
  readonly envKeys?: readonly string[];
  /** The env var that may name a token file. Default `AGENT_TOKEN_FILE`. */
  readonly tokenFileEnvKey?: string;
  /** The current time in ms. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "AGENT_TOKEN",
] as const;
const EXPIRY_FIELDS = ["expiresAt", "expires_at", "expiry", "exp"] as const;
/** A timestamp below this (the year 2001, in ms) is in seconds. */
const SECONDS_CUTOFF = 1_000_000_000_000;
const MS_PER_MINUTE = 60_000;

const toEpochMs = (value: unknown): number | undefined => {
  const text = typeof value === "string" ? value.trim() : undefined;
  const numeric = text === undefined ? value : Number(text);
  if (typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0) {
    return numeric < SECONDS_CUTOFF ? numeric * 1000 : numeric;
  }
  const parsed = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** The expiry in a JSON object, at its top level or one level down. */
const expiryOfJson = (json: unknown): number | undefined => {
  if (!isRecord(json)) {
    return undefined;
  }
  const direct = EXPIRY_FIELDS.map((field) => toEpochMs(json[field])).find(
    (expiry) => expiry !== undefined,
  );
  return (
    direct ??
    Object.values(json)
      .map((value) => (isRecord(value) ? expiryOfJson(value) : undefined))
      .find((expiry) => expiry !== undefined)
  );
};

const expiryOfJwt = (token: string): number | undefined => {
  const parts = token.trim().split(".");
  const [, payload] = parts;
  return parts.length === 3 && payload !== undefined
    ? expiryOfJson(parseJson(Buffer.from(payload, "base64url").toString()))
    : undefined;
};

const expiryOf = (token: string): number | undefined =>
  expiryOfJson(parseJson(token)) ?? expiryOfJwt(token);

/** The token and where it came from, or why it could not be read. */
const resolveToken = (
  ctx: CheckContext,
  envKeys: readonly string[],
  fileKey: string,
): { source: string; token: string } | { problem: string } => {
  const key = envKeys.find((name) => (ctx.env[name] ?? "").trim() !== "");
  if (key !== undefined) {
    return { source: `env ${key}`, token: ctx.env[key] ?? "" };
  }
  const file = ctx.env[fileKey];
  if (file === undefined || file.trim() === "") {
    return {
      problem: `no agent token: none of ${[...envKeys, fileKey].join(", ")} is set`,
    };
  }
  const read = ctx.run("cat", [file], { cwd: ctx.repoPath });
  if (read.status !== 0) {
    return {
      problem: `could not read the token file ${file}: ${failureReason(read)}`,
    };
  }
  return read.stdout.trim() === ""
    ? { problem: `the token file ${file} is empty` }
    : { source: `file ${file}`, token: read.stdout };
};

/**
 * Warns when no agent token resolves from the environment or a token file, or
 * when the token carries an expiry that has passed. Warns, never blocks: the
 * caller may refresh. The token itself is never printed.
 */
export const agentTokenValid = (options: AgentTokenOptions = {}): Check => ({
  name: "agentTokenValid",
  severity: "warn",
  run: (ctx): Promise<CheckResult> =>
    Promise.resolve().then(() => {
      const now = options.now ?? Date.now;
      const resolved = resolveToken(
        ctx,
        options.envKeys ?? DEFAULT_ENV_KEYS,
        options.tokenFileEnvKey ?? "AGENT_TOKEN_FILE",
      );
      if ("problem" in resolved) {
        return {
          ok: false,
          detail: resolved.problem,
          fix: "Provide a token before the agent starts, or refresh it in the caller.",
        };
      }
      const expiry = expiryOf(resolved.token);
      if (expiry === undefined) {
        return {
          ok: true,
          detail: `token from ${resolved.source} (it carries no expiry)`,
        };
      }
      const left = expiry - now();
      const minutes = String(Math.round(Math.abs(left) / MS_PER_MINUTE));
      return left > 0
        ? {
            ok: true,
            detail: `token from ${resolved.source} expires in ${minutes} min`,
          }
        : {
            ok: false,
            detail: `token from ${resolved.source} expired ${minutes} min ago`,
            fix: "Refresh the token before the agent starts.",
          };
    }),
});
