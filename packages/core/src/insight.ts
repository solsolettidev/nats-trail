import { isDlqSubject } from "./dlq.js";
import type {
  AgentMessage,
  Consumer,
  DLQEvent,
  Flow,
  FlowStep,
  HealthFinding,
  Message,
  NormalizedError,
  StreamBlueprint,
  StreamSpec,
  ServerHealth,
  Stream,
  SubjectField,
} from "./types.js";

/** Example values are cut to keep an inferred shape small enough to read. */
const EXAMPLE_LIMIT = 48;

/** Paths per subject, so one pathological payload cannot flood the output. */
const MAX_FIELDS = 60;

/** JSON type name for shape inference; arrays and null are distinct from object. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function example(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > EXAMPLE_LIMIT ? `${text.slice(0, EXAMPLE_LIMIT)}…` : text;
}

/**
 * Walk a JSON value into dotted paths. Arrays collapse to a single `[]` segment
 * so a hundred-element list does not become a hundred fields.
 */
function walk(value: unknown, prefix: string, out: Map<string, { types: Set<string>; count: number; example: string | null }>): void {
  if (out.size >= MAX_FIELDS) return;
  const type = typeOf(value);

  if (prefix) {
    const entry = out.get(prefix) ?? { types: new Set<string>(), count: 0, example: null };
    entry.types.add(type);
    entry.count += 1;
    if (entry.example === null && value !== null && type !== "object" && type !== "array") {
      entry.example = example(value);
    }
    out.set(prefix, entry);
  }

  if (type === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (type === "array" && (value as unknown[]).length > 0) {
    walk((value as unknown[])[0], `${prefix}[]`, out);
  }
}

/**
 * Infer the payload shape of a set of messages: which fields appear, their JSON
 * types, how consistently they are present, and an example value.
 */
export function inferFields(messages: Pick<Message, "json" | "isJson">[]): SubjectField[] {
  const paths = new Map<string, { types: Set<string>; count: number; example: string | null }>();
  let jsonCount = 0;

  for (const message of messages) {
    if (!message.isJson || message.json === null) continue;
    jsonCount += 1;
    walk(message.json, "", paths);
  }
  if (jsonCount === 0) return [];

  return [...paths.entries()]
    .map(([path, info]) => ({
      path,
      types: [...info.types].sort(),
      presence: Math.round((info.count / jsonCount) * 100) / 100,
      example: info.example,
    }))
    // Stable, useful order: always-present fields first, then alphabetical.
    .sort((a, b) => b.presence - a.presence || a.path.localeCompare(b.path));
}

/** Subjects a stream declares, expanded with the concrete subjects seen in it. */
export function subjectsOfStream(stream: Stream, seen: Record<string, number>): { subject: string; messages: number }[] {
  const entries = Object.entries(seen);
  if (entries.length > 0) {
    return entries.map(([subject, messages]) => ({ subject, messages })).sort((a, b) => b.messages - a.messages);
  }
  return stream.subjects.map((subject) => ({ subject, messages: 0 }));
}

/** Turn a live stream and its consumers into a portable blueprint. */
export function toBlueprint(stream: Stream, consumers: Consumer[], exportedFrom?: { contextId: string; at: number }): StreamBlueprint {
  return {
    version: 1,
    stream: {
      name: stream.name,
      subjects: stream.subjects,
      retention: stream.retention as StreamSpec["retention"],
      storage: stream.storage as StreamSpec["storage"],
      replicas: stream.replicas,
      // Zero means unlimited in JetStream; omit it so import keeps the default.
      maxAge: stream.maxAge || undefined,
      maxMessages: stream.maxMessages > 0 ? stream.maxMessages : undefined,
      maxBytes: stream.maxBytes > 0 ? stream.maxBytes : undefined,
      discard: stream.discard as StreamSpec["discard"],
    },
    consumers: consumers
      // Only durables can be recreated; an ephemeral consumer has no identity
      // to restore, so exporting one would produce an import that silently
      // creates something different.
      .filter((consumer) => consumer.durableName)
      .map((consumer) => ({
        name: consumer.durableName!,
        filterSubjects: consumer.filterSubjects,
      })),
    exportedFrom,
  };
}

/**
 * Validate a blueprint read from disk. Returns errors rather than throwing, so
 * a caller can report all of them at once.
 */
export function validateBlueprint(value: unknown): NormalizedError[] {
  const errors: NormalizedError[] = [];
  const fail = (code: string, message: string) => errors.push({ code, message, retriable: false });
  const doc = value as Partial<StreamBlueprint> | null;

  if (!doc || typeof doc !== "object") {
    fail("blueprint.shape", "Blueprint must be a JSON object");
    return errors;
  }
  if (doc.version !== 1) fail("blueprint.version", `Unsupported blueprint version: ${String(doc.version)}`);
  if (!doc.stream?.name?.trim()) fail("blueprint.stream", "Blueprint is missing stream.name");
  if (!Array.isArray(doc.stream?.subjects) || doc.stream.subjects.length === 0) {
    fail("blueprint.subjects", "Blueprint needs at least one subject");
  }
  if (doc.consumers != null && !Array.isArray(doc.consumers)) {
    fail("blueprint.consumers", "consumers must be an array when present");
  }
  for (const consumer of doc.consumers ?? []) {
    if (!consumer?.name?.trim()) fail("blueprint.consumer", "Every consumer needs a name");
  }
  return errors;
}

/** Read an error-ish string out of a payload, for flow step status. */
function errorDetail(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  for (const key of ["error", "reason", "message", "err", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function stepStatus(subject: string, json: unknown): "ok" | "failed" | "dlq" {
  if (isDlqSubject(subject)) return "dlq";
  if (/\.(failed|error|failure|rejected|dead)(\.|$)/i.test(subject)) return "failed";
  if (errorDetail(json)) return "failed";
  return "ok";
}

/**
 * Turn an ordered set of correlated messages into a causal chain: elapsed time
 * between steps, which step failed, and which streams took part.
 *
 * The messages must already be filtered to one correlation value; this only
 * shapes them. Answering "why did this fail" is reading the first failed step.
 */
export function reconstructFlow(
  key: "request_id" | "correlation_id",
  value: string,
  messages: AgentMessage[],
): Flow {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0));

  const steps: FlowStep[] = ordered.map((message, index) => {
    const json = message.json;
    return {
      subject: message.subject,
      stream: message.stream ?? "",
      timestamp: message.timestamp,
      deltaMs: index === 0 ? null : message.timestamp - ordered[index - 1].timestamp,
      status: stepStatus(message.subject, json),
      detail: errorDetail(json),
      seq: message.seq,
    };
  });

  const failedAt = steps.find((step) => step.status !== "ok") ?? null;
  return {
    key,
    value,
    steps,
    durationMs: steps.length > 1 ? steps[steps.length - 1].timestamp - steps[0].timestamp : 0,
    failed: failedAt !== null,
    failedAt,
    streams: [...new Set(steps.map((step) => step.stream).filter(Boolean))],
  };
}

/**
 * One sentence describing an incident, for a notification body or annotation.
 *
 * Leads with the failure because that is what the reader needs first; falls back
 * to describing a healthy flow so a caller never has to special-case an empty
 * summary.
 */
export function summarizeIncident(input: {
  value: string;
  flow: Flow | null;
  dlq: DLQEvent[];
  findings: HealthFinding[];
}): string {
  const parts: string[] = [];

  if (input.flow && input.flow.steps.length > 0) {
    const { flow } = input;
    if (flow.failedAt) {
      parts.push(
        `${input.value} failed at ${flow.failedAt.subject}${flow.failedAt.detail ? `: ${flow.failedAt.detail}` : ""}`,
      );
      parts.push(`after ${flow.steps.length} steps across ${flow.streams.length} stream(s) in ${formatMs(flow.durationMs)}`);
    } else {
      parts.push(`${input.value} completed ${flow.steps.length} steps across ${flow.streams.length} stream(s) in ${formatMs(flow.durationMs)}`);
    }
  } else {
    parts.push(`No messages found for ${input.value} in the scanned window`);
  }

  if (input.dlq.length > 0) parts.push(`${input.dlq.length} related dead-letter message(s)`);
  const critical = input.findings.filter((f) => f.severity === "critical").length;
  if (critical > 0) parts.push(`${critical} critical health finding(s) on this context`);

  return `${parts.join("; ")}.`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Thresholds above which a measurement is worth reporting. */
const PENDING_WARNING = 1_000;
const PENDING_CRITICAL = 10_000;
const REDELIVERED_WARNING = 1;

/**
 * Summarize what looks wrong right now, ordered worst first.
 *
 * Deliberately opinionated: an agent asking "what is broken?" needs a ranked
 * answer, not raw counters it has to threshold itself.
 */
export function summarizeHealth(input: {
  streams: Stream[];
  consumers: Consumer[];
  dlqCounts?: Record<string, number>;
  server?: ServerHealth | null;
}): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const consumer of input.consumers) {
    if (consumer.pending >= PENDING_CRITICAL) {
      findings.push({
        code: "consumer.pending_critical",
        severity: "critical",
        message: `Consumer ${consumer.name} on ${consumer.stream} has ${consumer.pending} pending messages`,
        target: `${consumer.stream}/${consumer.name}`,
        value: consumer.pending,
      });
    } else if (consumer.pending >= PENDING_WARNING) {
      findings.push({
        code: "consumer.pending_high",
        severity: "warning",
        message: `Consumer ${consumer.name} on ${consumer.stream} has ${consumer.pending} pending messages`,
        target: `${consumer.stream}/${consumer.name}`,
        value: consumer.pending,
      });
    }
    if (consumer.redelivered >= REDELIVERED_WARNING) {
      findings.push({
        code: "consumer.redelivered",
        severity: consumer.redelivered > 100 ? "critical" : "warning",
        message: `Consumer ${consumer.name} on ${consumer.stream} redelivered ${consumer.redelivered} messages, which points at repeated processing failures`,
        target: `${consumer.stream}/${consumer.name}`,
        value: consumer.redelivered,
      });
    }
  }

  for (const [subject, count] of Object.entries(input.dlqCounts ?? {})) {
    if (count > 0) {
      findings.push({
        code: "dlq.messages",
        severity: count > 50 ? "critical" : "warning",
        message: `${count} dead-letter messages on ${subject}`,
        target: subject,
        value: count,
      });
    }
  }

  if (input.server) {
    if (input.server.slowConsumers > 0) {
      findings.push({
        code: "server.slow_consumers",
        severity: "critical",
        message: `Server reports ${input.server.slowConsumers} slow consumers, so messages are being dropped`,
        target: input.server.serverName || input.server.serverId,
        value: input.server.slowConsumers,
      });
    }
  }

  const rank = { critical: 0, warning: 1 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.value - a.value);
}
