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
  /** How many of the sampled subjects carry this path. */
  subjects: number;
  /** Fraction of sampled messages carrying it. */
  presence: number;
  example: string | null;
  /** Why this was proposed, in one line, so a human can judge it. */
  reason: string;
}

interface SampledField {
  path: string;
  subject: string;
  values: string[];
}

/**
 * Propose correlation keys from observed traffic.
 *
 * The signal is a string field that is nearly unique per message *and* appears
 * on more than one subject: unique-per-message means it identifies something,
 * and crossing subjects means it links them. A field that is unique but lives
 * on one subject is an entity id, not a correlation key, and is ranked below.
 */
export function suggestCorrelationKeys(fields: SampledField[], minSamples = 4): CorrelationCandidate[] {
  const byPath = new Map<string, { subjects: Set<string>; values: string[] }>();

  for (const field of fields) {
    const entry = byPath.get(field.path) ?? { subjects: new Set<string>(), values: [] };
    entry.subjects.add(field.subject);
    entry.values.push(...field.values);
    byPath.set(field.path, entry);
  }

  const candidates: CorrelationCandidate[] = [];
  for (const [path, entry] of byPath) {
    const values = entry.values.filter((value) => typeof value === "string" && value.length > 0);
    if (values.length < minSamples) continue;

    const distinct = new Set(values).size;
    const cardinality = distinct / values.length;
    const subjects = entry.subjects.size;

    // A field with few distinct values is a category (status, type), not an id.
    if (cardinality < 0.5) continue;

    candidates.push({
      path,
      cardinality: Math.round(cardinality * 100) / 100,
      subjects,
      presence: 1,
      example: values[0] ?? null,
      reason:
        subjects > 1
          ? `near-unique per message and present on ${subjects} subjects`
          : "near-unique per message, but only seen on one subject — likely an entity id",
    });
  }

  // Crossing subjects is the stronger signal, then uniqueness.
  return candidates.sort(
    (a, b) => b.subjects - a.subjects || b.cardinality - a.cardinality || a.path.localeCompare(b.path),
  );
}
