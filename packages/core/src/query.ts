import type { AgentMessage, Message, NormalizedError, QueryEnvelope, QueryWarning } from "./types.js";

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
export const DEFAULT_PAYLOAD_LIMIT = 4096;
export const DEFAULT_MAX_SCAN = 10_000;
export const MAX_SCAN = 100_000;

export function normalizeLimit(value: unknown, fallback = DEFAULT_QUERY_LIMIT): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_QUERY_LIMIT);
}

export function normalizeScan(value: unknown, fallback = DEFAULT_MAX_SCAN): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_SCAN);
}

/** Parse a nextCursor value back into a stream sequence. */
export function parseCursor(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function truncateText(value: string, maxBytes = DEFAULT_PAYLOAD_LIMIT): { value: string; truncated: boolean } {
  const bytes = utf8ByteLength(value);
  if (bytes <= maxBytes) return { value, truncated: false };
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = utf8ByteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return { value: out, truncated: true };
}

export function createQueryEnvelope<T>(input: {
  query: Record<string, unknown>;
  results: T[];
  limit?: number;
  nextCursor?: string | null;
  warnings?: QueryWarning[];
  errors?: NormalizedError[];
}): QueryEnvelope<T> {
  const limit = normalizeLimit(input.limit);
  const results = input.results.slice(0, limit);
  return {
    query: { ...input.query, limit },
    summary: {
      returned: results.length,
      limit,
      truncated: input.results.length > limit,
    },
    results,
    nextCursor: input.nextCursor ?? null,
    warnings: input.warnings ?? [],
    errors: input.errors ?? [],
  };
}

export function toAgentMessage(message: Message, stream?: string, maxPayloadBytes = DEFAULT_PAYLOAD_LIMIT): AgentMessage {
  const payload = truncateText(message.data, maxPayloadBytes);
  return {
    id: message.id,
    subject: message.subject,
    timestamp: message.timestamp,
    stream,
    seq: message.seq,
    size: message.size,
    isJson: message.isJson,
    payload: payload.value,
    payloadTruncated: payload.truncated,
    json: payload.truncated ? null : message.json,
    requestId: extractString(message.json, ["request_id", "requestId", "req_id"]),
    correlationId: extractString(message.json, ["correlation_id", "correlationId", "corr_id"]),
  };
}

function extractString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found) return found;
  }
  return null;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
