import { getPath } from "./filters.js";
import type { Message } from "./types.js";

/**
 * How to pull one correlation value out of a message.
 *
 * Nothing here is domain-specific: a deployment declares its own keys, and the
 * defaults below only cover conventions that exist as actual specifications.
 */
export interface CorrelationKey {
  /** Name this value is known by, e.g. `trace_id`. Used in queries and the index. */
  name: string;
  /**
   * NATS header names to try, in order. Matched case-insensitively, because
   * header casing is not guaranteed to survive a round trip.
   */
  headers?: string[];
  /** Dotted paths into the JSON payload, tried in order after headers. */
  paths?: string[];
  /** How to read the raw value once found. */
  format?: "raw" | "w3c-traceparent";
}

/**
 * Defaults, deliberately limited to conventions with a specification behind
 * them:
 *
 * - `traceparent` is W3C Trace Context, which is what OpenTelemetry emits.
 * - `correlation_id` is the Correlation Identifier pattern, and is a native
 *   property in AMQP (`correlation-id`) and JMS (`JMSCorrelationID`).
 * - `request_id` is the `X-Request-Id` convention. Not a spec, but universal.
 *
 * Business identifiers — order ids, tenant ids, whatever a given system
 * actually correlates on — are not guessed at. They are configured, and
 * `suggestCorrelationKeys` proposes them from real traffic.
 */
export const DEFAULT_CORRELATION_KEYS: CorrelationKey[] = [
  { name: "trace_id", headers: ["traceparent"], format: "w3c-traceparent" },
  {
    name: "request_id",
    headers: ["X-Request-Id", "X-Request-ID", "Request-Id"],
    paths: ["request_id", "requestId", "req_id"],
  },
  {
    name: "correlation_id",
    headers: ["X-Correlation-Id", "X-Correlation-ID", "Correlation-Id"],
    paths: ["correlation_id", "correlationId", "corr_id"],
  },
];

/**
 * Which keys apply: a context's own, else the deployment-wide set, else the
 * specification-backed defaults. Empty arrays are treated as "not configured"
 * rather than "correlate nothing", which is never what someone means.
 */
export function resolveCorrelationKeys(
  contextKeys?: CorrelationKey[],
  globalKeys?: CorrelationKey[],
): CorrelationKey[] {
  if (contextKeys && contextKeys.length > 0) return contextKeys;
  if (globalKeys && globalKeys.length > 0) return globalKeys;
  return DEFAULT_CORRELATION_KEYS;
}

/** Validate configured keys before they are saved. Returns errors, empty if valid. */
export function validateCorrelationKeys(value: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value)) return ["correlationKeys must be an array"];

  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const key = raw as Partial<CorrelationKey> | null;
    const where = `correlationKeys[${index}]`;
    if (!key || typeof key !== "object") {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (!key.name?.trim()) errors.push(`${where}.name is required`);
    else if (seen.has(key.name)) errors.push(`duplicate key name: ${key.name}`);
    else seen.add(key.name);

    const headers = key.headers ?? [];
    const paths = key.paths ?? [];
    if (!Array.isArray(headers) || !Array.isArray(paths)) {
      errors.push(`${where}.headers and .paths must be arrays`);
    } else if (headers.length === 0 && paths.length === 0) {
      // A key that looks nowhere silently never matches; refuse it at save time.
      errors.push(`${where} needs at least one header or path`);
    }
    if (key.format && key.format !== "raw" && key.format !== "w3c-traceparent") {
      errors.push(`${where}.format must be "raw" or "w3c-traceparent"`);
    }
  }
  return errors;
}

/** Case-insensitive header lookup; NATS preserves casing but senders vary. */
function readHeader(headers: Record<string, string[]> | undefined, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = values.find((item) => typeof item === "string" && item.length > 0);
      if (value) return value;
    }
  }
  return null;
}

/**
 * `traceparent` is `version-traceid-parentid-flags`. The useful part is the
 * 32-hex trace id in the middle, not the whole string — two spans of the same
 * trace have different parent ids and would otherwise never correlate.
 */
function parseTraceparent(value: string): string | null {
  const parts = value.trim().split("-");
  if (parts.length < 4) return null;
  const traceId = parts[1];
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return null;
  // An all-zero trace id is the spec's "invalid" sentinel.
  if (/^0+$/.test(traceId)) return null;
  return traceId.toLowerCase();
}

function applyFormat(raw: string, format: CorrelationKey["format"]): string | null {
  if (format === "w3c-traceparent") return parseTraceparent(raw);
  return raw;
}

/** Extract one key's value, headers first because they are protocol-level. */
export function extractCorrelation(
  message: Pick<Message, "json" | "isJson" | "headers">,
  key: CorrelationKey,
): string | null {
  for (const name of key.headers ?? []) {
    const raw = readHeader(message.headers, name);
    if (raw) {
      const value = applyFormat(raw, key.format);
      if (value) return value;
    }
  }
  if (message.isJson && message.json !== null) {
    for (const path of key.paths ?? []) {
      const found = getPath(message.json, path);
      if (typeof found === "string" && found) {
        const value = applyFormat(found, key.format);
        if (value) return value;
      }
      // Numeric ids are common enough to be worth accepting.
      if (typeof found === "number" && Number.isFinite(found)) return String(found);
    }
  }
  return null;
}

/** Extract every configured key. Absent keys are omitted, not set to null. */
export function extractCorrelations(
  message: Pick<Message, "json" | "isJson" | "headers">,
  keys: CorrelationKey[] = DEFAULT_CORRELATION_KEYS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = extractCorrelation(message, key);
    if (value) out[key.name] = value;
  }
  return out;
}

/** A field that looks like it correlates messages, with the evidence for it. */
export interface CorrelationCandidate {
  /** Dotted path, ready to drop into a `CorrelationKey`. */
  path: string;
  /** Distinct values seen, relative to messages sampled. 1 means always unique. */
  cardinality: number;
  /** Subjects this path appears on. */
  subjects: number;
  /**
   * Values that were seen under this path on more than one subject. This is the
   * real signal: a correlation key links messages, so its values must recur
   * across subjects.
   */
  linkingValues: number;
  example: string | null;
  /** Why this was proposed, in one line, so a human can judge it. */
  reason: string;
}

interface SampledField {
  path: string;
  subject: string;
  values: string[];
}

/** ISO-8601-ish, epoch seconds or millis: unique per message but never linking. */
function looksLikeTimestamp(path: string, values: string[]): boolean {
  if (/(^|[._])(at|time|timestamp|date|ts)$/i.test(path)) return true;
  const sample = values.slice(0, 8);
  if (sample.length === 0) return false;
  return sample.every(
    (value) => /^\d{4}-\d{2}-\d{2}[T ]/.test(value) || /^1[5-9]\d{8}(\d{3})?$/.test(value),
  );
}

/**
 * Propose correlation keys from observed traffic.
 *
 * The signal is **value recurrence across subjects**: a correlation key exists
 * to link messages, so the same value must show up under the same path on more
 * than one subject. A field that is unique per message but whose values never
 * recur — a timestamp, a duration, a row count — identifies the message, not a
 * flow, and is exactly the false positive this has to avoid.
 *
 * Single-subject ids are still reported, ranked below, because a reader may
 * recognise one that would link if more subjects were sampled.
 */
export function suggestCorrelationKeys(fields: SampledField[], minSamples = 4): CorrelationCandidate[] {
  const byPath = new Map<string, Map<string, Set<string>>>();

  for (const field of fields) {
    const perSubject = byPath.get(field.path) ?? new Map<string, Set<string>>();
    const values = perSubject.get(field.subject) ?? new Set<string>();
    for (const value of field.values) {
      if (typeof value === "string" && value.length > 0) values.add(value);
    }
    perSubject.set(field.subject, values);
    byPath.set(field.path, perSubject);
  }

  const candidates: CorrelationCandidate[] = [];

  for (const [path, perSubject] of byPath) {
    const all: string[] = [];
    for (const values of perSubject.values()) all.push(...values);
    if (all.length < minSamples) continue;

    const distinct = new Set(all);
    const cardinality = distinct.size / all.length;
    // Few distinct values means a category (status, type), not an identifier.
    if (cardinality < 0.5) continue;
    if (looksLikeTimestamp(path, [...distinct])) continue;

    // How many values appear under this path on two or more subjects.
    let linkingValues = 0;
    for (const value of distinct) {
      let seenIn = 0;
      for (const values of perSubject.values()) {
        if (values.has(value)) seenIn += 1;
        if (seenIn > 1) break;
      }
      if (seenIn > 1) linkingValues += 1;
    }

    const subjects = perSubject.size;
    candidates.push({
      path,
      cardinality: Math.round(cardinality * 100) / 100,
      subjects,
      linkingValues,
      example: all[0] ?? null,
      reason:
        linkingValues > 0
          ? `${linkingValues} value(s) recur across ${subjects} subjects — this links messages`
          : subjects > 1
            ? "present on several subjects but no value recurs, so it identifies a message rather than a flow"
            : "near-unique per message, but only seen on one subject — likely an entity id",
    });
  }

  // Linking beats everything: that is what a correlation key is for.
  return candidates.sort(
    (a, b) =>
      b.linkingValues - a.linkingValues ||
      b.subjects - a.subjects ||
      b.cardinality - a.cardinality ||
      a.path.localeCompare(b.path),
  );
}
