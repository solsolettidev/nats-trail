import type { Context, Environment, NormalizedError } from "./types.js";

const ENVIRONMENTS: Environment[] = ["local", "dev", "staging", "prod", "custom"];

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
      // password / token / credsPath intentionally omitted
    },
    tls: { ...ctx.tls },
  };
}
