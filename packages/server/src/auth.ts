import { timingSafeEqual } from "node:crypto";
import { loadTokens, type ApiToken, type TokenScope } from "./storage.js";

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
    .map((pair): ApiToken => {
      // `name:token` or `name:token:scope[|scope]`; scopes default to read.
      const parts = pair.split(":");
      if (parts.length < 2) return { name: "token", token: pair, scopes: ["read" as TokenScope] };
      const [name, token, rawScopes] = parts;
      return { name, token, scopes: parseScopes(rawScopes) };
    })
    .filter((item) => item.token.length > 0);
  return fromEnv.concat(loadTokens());
}

export function authEnabled(): boolean {
  return configuredTokens().length > 0;
}

/** True when the resolved token may perform mutations. */
export function canWrite(token: ApiToken | null): boolean {
  return (token?.scopes ?? ["read"]).includes("write");
}

function parseScopes(raw: string | undefined): TokenScope[] {
  if (!raw) return ["read"];
  const scopes = raw
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is TokenScope => s === "read" || s === "write");
  // A write token can always read; read is never implied away.
  return scopes.length ? [...new Set<TokenScope>(["read", ...scopes])] : ["read"];
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
