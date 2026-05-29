import type { Filter, Message } from "./types.js";

/** True when a NATS subject token pattern (`*`, `>`) matches a concrete subject. */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (pattern === subject) return true;
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    const token = p[i];
    if (token === ">") return true;
    if (i >= s.length) return false;
    if (token === "*") continue;
    if (token !== s[i]) return false;
  }
  return p.length === s.length;
}

/** Read a dotted path (`a.b.c`) out of a parsed JSON value. */
export function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** Evaluate a filter against a single message (used by UI now, CLI later). */
export function matchFilter(filter: Filter, message: Message): boolean {
  if (filter.subject && !subjectMatches(filter.subject, message.subject)) return false;
  if (filter.fromTs != null && message.timestamp < filter.fromTs) return false;
  if (filter.toTs != null && message.timestamp > filter.toTs) return false;
  if (filter.text && !message.data.toLowerCase().includes(filter.text.toLowerCase())) {
    return false;
  }
  if (filter.eventType) {
    const [path, expected] = filter.eventType.includes("=")
      ? filter.eventType.split("=")
      : ["type", filter.eventType];
    const actual = message.isJson ? getPath(message.json, path) : undefined;
    if (String(actual) !== expected) return false;
  }
  return true;
}
