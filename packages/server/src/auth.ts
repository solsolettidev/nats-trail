import { timingSafeEqual } from "node:crypto";
import { loadTokens, type ApiToken } from "./storage.js";

/**
 * Bearer-token auth for the Integration API and the WebSocket endpoint.
 *
 * Tokens come from `NATS_TRAIL_TOKENS` (comma-separated `name:token` pairs) and
 * `data/tokens.json` (`[{ "name": "...", "token": "..." }]`). When no token is
 * configured, auth is disabled so local development keeps working; configuring
 * at least one token enforces it on every protected request.
 */
export function configuredTokens(): ApiToken[] {
  const fromEnv = (process.env.NATS_TRAIL_TOKENS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      return idx > 0 ? { name: pair.slice(0, idx), token: pair.slice(idx + 1) } : { name: "token", token: pair };
    })
    .filter((item) => item.token.length > 0);
  return fromEnv.concat(loadTokens());
}

export function authEnabled(): boolean {
  return configuredTokens().length > 0;
}

/** Resolve a raw `Authorization` header or bare token value to a configured token. */
export function authenticate(raw: string | undefined | null): ApiToken | null {
  if (!raw) return null;
  const value = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, "").trim() : raw.trim();
  if (!value) return null;
  return configuredTokens().find((item) => safeEqual(item.token, value)) ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
