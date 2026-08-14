import type { Context, Environment, NormalizedError } from "./types.js";

const ENVIRONMENTS: Environment[] = ["local", "dev", "staging", "prod", "custom"];

/** Default HTTP monitoring port when a context does not configure one. */
const DEFAULT_MONITOR_PORT = 8222;

/**
 * Resolve the HTTP monitoring endpoint for a context: the explicit
 * `monitorUrl` when set, otherwise the connection host on the conventional
 * monitoring port. Returns null when the URL cannot be parsed.
 */
export function monitoringUrl(ctx: Pick<Context, "url" | "monitorUrl">): string | null {
  if (ctx.monitorUrl?.trim()) return ctx.monitorUrl.trim().replace(/\/+$/, "");
  // Parsed by hand rather than with `URL`: core deliberately compiles without
  // DOM or Node lib types, and only the scheme and host are needed here.
  const match = /^(nats|tls|ws|wss):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/.exec(ctx.url.trim());
  if (!match) return null;
  const secure = match[1] === "tls" || match[1] === "wss";
  return `${secure ? "https" : "http"}://${match[2]}:${DEFAULT_MONITOR_PORT}`;
}

/** Validate a context before it is saved or used to connect. Returns errors, empty if valid. */
export function validateContext(ctx: Partial<Context>): NormalizedError[] {
  const errors: NormalizedError[] = [];
  const fail = (code: string, message: string) =>
    errors.push({ code, message, retriable: false });

  if (!ctx.name || !ctx.name.trim()) fail("context.name", "Name is required");
  if (!ctx.url || !ctx.url.trim()) {
    fail("context.url", "Connection URL is required");
  } else if (!/^(nats|tls|ws|wss):\/\//.test(ctx.url.trim())) {
    fail("context.url", "URL must start with nats://, tls://, ws:// or wss://");
  }
  if (ctx.auth?.type === "nkey" && !ctx.auth.nkeySeed?.trim()) {
    fail("context.auth", "An nkey seed is required for nkey auth");
  }
  if (ctx.auth?.type === "nkey" && ctx.auth.nkeySeed && !/^S[A-Z0-9]{20,}$/.test(ctx.auth.nkeySeed.trim())) {
    fail("context.auth", "An nkey seed looks like SUAxxxx… — this does not");
  }
  if (ctx.environment && !ENVIRONMENTS.includes(ctx.environment)) {
    fail("context.environment", `Environment must be one of ${ENVIRONMENTS.join(", ")}`);
  }

  const auth = ctx.auth;
  if (auth) {
    if (auth.type === "userpass" && (!auth.username || !auth.password)) {
      fail("context.auth", "userpass auth requires username and password");
    }
    if (auth.type === "token" && !auth.token) {
      fail("context.auth", "token auth requires a token");
    }
    if (auth.type === "creds" && !auth.credsPath) {
      fail("context.auth", "creds auth requires a creds file path");
    }
  }
  return errors;
}

/** Strip secrets from a context so it can be sent to clients safely. */
export function sanitizeContext(ctx: Context): Context {
  return {
    ...ctx,
    auth: {
      type: ctx.auth.type,
      username: ctx.auth.username,
      // An allowlist, not a denylist: password, token, credsPath and nkeySeed
      // are omitted, and any secret added later is excluded by default.
    },
    tls: { ...ctx.tls },
  };
}
