import type { NormalizedError } from "./types.js";

const RETRIABLE = /timeout|ECONNREFUSED|disconnect|no servers|stale|reconnect/i;

/** Normalize any thrown value into the stable error shape every interface returns. */
export function normalizeError(err: unknown): NormalizedError {
  if (err && typeof err === "object") {
    const anyErr = err as { code?: unknown; message?: unknown; name?: unknown };
    const message =
      typeof anyErr.message === "string" ? anyErr.message : String(err);
    const code =
      typeof anyErr.code === "string"
        ? anyErr.code
        : typeof anyErr.name === "string"
          ? anyErr.name
          : "error";
    return { code, message, retriable: RETRIABLE.test(message) };
  }
  const message = String(err);
  return { code: "error", message, retriable: RETRIABLE.test(message) };
}

/** Cap a result set and report how many were dropped. Used to enforce limits. */
export function limitResults<T>(items: T[], limit: number): { items: T[]; truncated: number } {
  if (limit <= 0 || items.length <= limit) return { items, truncated: 0 };
  return { items: items.slice(0, limit), truncated: items.length - limit };
}
