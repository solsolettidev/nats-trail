import {
  createQueryEnvelope,
  isDlqSubject,
  matchFilter,
  normalizeError,
  normalizeLimit,
  normalizeScan,
  parseCursor,
  parseDlqEvent,
  sanitizeContext,
  subjectMatches,
  toAgentMessage,
  type AgentMessage,
  type ConnectionState,
  type Context,
  type Consumer,
  type Filter,
  type Message,
  type QueryEnvelope,
  type QueryWarning,
  type Stream,
  type StreamQuery,
  type StreamQueryPage,
  type KvBucket,
  type KvEntry,
  type ObjectBucket,
  type ObjectEntry,
  type ServerConnection,
  type ServerHealth,
  type DLQEvent,
  type Flow,
  type HealthFinding,
  type IncidentContext,
  type CorrelationKey,
  type SubjectShape,
  DEFAULT_CORRELATION_KEYS,
  extractCorrelations,
  inferFields,
  suggestCorrelationKeys,
  reconstructFlow,
  subjectsOfStream,
  summarizeHealth,
  summarizeIncident,
} from "@nats-trail/core";
import { mcpTools, validateToolInput } from "./tools.js";

export interface McpRuntimeData {
  contexts: Context[];
  filters?: Filter[];
  auditEntries?: unknown[];
  connectionState?: ConnectionState;
  /** Every pooled connection state, when the bridge runs a connection pool. */
  connectionStates?: ConnectionState[];
  activeContextId?: string | null;
  listStreams?: () => Promise<Stream[]>;
  listConsumers?: (stream: string) => Promise<Consumer[]>;
  getStreamMessage?: (stream: string, seq: number) => Promise<Message | null>;
  queryStreamMessages?: (query: StreamQuery) => Promise<StreamQueryPage>;
  listKvBuckets?: () => Promise<KvBucket[]>;
  listKvEntries?: (bucket: string, limit: number) => Promise<KvEntry[]>;
  kvHistory?: (bucket: string, key: string, limit: number) => Promise<KvEntry[]>;
  listObjectBuckets?: () => Promise<ObjectBucket[]>;
  listObjects?: (bucket: string, limit: number) => Promise<ObjectEntry[]>;
  serverHealth?: () => Promise<ServerHealth>;
  serverConnections?: (limit: number) => Promise<ServerConnection[]>;
  streamSubjects?: (stream: string) => Promise<Record<string, number>>;
  /** Correlation keys in force for this context; defaults apply when absent. */
  correlationKeys?: CorrelationKey[];
  /** Index lookup, when a correlation index has been built for this context. */
  lookupCorrelation?: (key: string, value: string, limit: number) => IndexedLocation[];
  /** What the index covers, so a miss can be told apart from a gap. */
  indexCoverage?: () => IndexCoverage[];
}

/** Where an indexed correlation value was seen. */
export interface IndexedLocation {
  stream: string;
  seq: number;
  subject: string;
  timestamp: number;
}

/** The sequence range of a stream that has actually been indexed. */
export interface IndexCoverage {
  stream: string;
  fromSeq: number;
  toSeq: number;
  entries: number;
  keys: string[];
  updatedAt: number;
}

/** Every string leaf of a JSON value, as [dotted path, value] pairs. */
function flattenStrings(value: unknown, prefix = "", out: [string, string][] = [], depth = 0): [string, string][] {
  if (depth > 6 || out.length > 200) return out;
  if (typeof value === "string") {
    if (prefix && value) out.push([prefix, value]);
    return out;
  }
  if (typeof value === "number" && prefix) {
    out.push([prefix, String(value)]);
    return out;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenStrings(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
    }
  }
  return out;
}

/** Correlation keys in force, falling back to the specification-backed defaults. */
function keysOf(data: McpRuntimeData): CorrelationKey[] {
  return data.correlationKeys?.length ? data.correlationKeys : DEFAULT_CORRELATION_KEYS;
}

/** Page size used when a tool scans a stream window incrementally. */
const SCAN_PAGE_SIZE = 500;

interface CollectResult {
  messages: Message[];
  scanned: number;
  nextCursor: string | null;
  warnings: QueryWarning[];
}

/**
 * Page through one stream's scan window, keeping messages a predicate accepts,
 * until `limit` matches are found or the scan budget runs out.
 *
 * Filters the server can apply (subject, time window) belong in `window`.
 * Anything needing the payload — free text, correlation ids, a saved filter's
 * event type — is a post-filter, and applying a post-filter to a single page of
 * `limit` messages reports "no matches" whenever the matches sit deeper in the
 * stream. That false negative is what this exists to prevent.
 */
async function collectMatching(
  queryStreamMessages: NonNullable<McpRuntimeData["queryStreamMessages"]>,
  window: { stream: string; subject?: string; fromTs?: number; toTs?: number },
  limit: number,
  budget: number,
  cursor: number | undefined,
  keep: (message: Message) => boolean,
): Promise<CollectResult> {
  const messages: Message[] = [];
  const warnings: QueryWarning[] = [];
  let startSeq = cursor;
  let scanned = 0;
  let nextCursor: string | null = null;

  while (scanned < budget && messages.length < limit) {
    const page = await queryStreamMessages({
      ...window,
      limit: Math.min(SCAN_PAGE_SIZE, budget - scanned),
      startSeq,
      maxScan: budget - scanned,
    });
    scanned += page.scanned;
    warnings.push(...page.warnings);
    for (const message of page.messages) {
      if (messages.length >= limit) break;
      if (keep(message)) messages.push(message);
    }
    nextCursor = page.nextCursor;
    if (!page.nextCursor) break;
    startSeq = parseCursor(page.nextCursor);
  }

  // Stopping short of `limit` with stream left over is not "no more matches";
  // say so, or the caller reads an incomplete answer as a complete one.
  if (messages.length < limit && nextCursor) {
    warnings.push({
      code: "scan.budget_exhausted",
      message: `Scanned ${scanned} messages without filling the limit. Pass a larger maxScan, a narrower subject, or resume from nextCursor.`,
    });
  }

  return { messages, scanned, nextCursor, warnings };
}

interface AgentDlqEvent {
  message: AgentMessage;
  originalSubject: string | null;
  reason: string | null;
}

export async function executeMcpTool(name: string, input: Record<string, unknown>, data: McpRuntimeData): Promise<QueryEnvelope<unknown>> {
  const timeoutMs = mcpTools.find((tool) => tool.name === name)?.timeoutMs ?? 5000;
  const validationErrors = validateToolInput(name, input);
  if (validationErrors.length) {
    const limit = normalizeLimit(input.limit);
    return createQueryEnvelope({
      query: { tool: name, limit },
      results: [],
      limit,
      errors: validationErrors.map((error) => ({ ...error, retriable: false })),
    });
  }
  return withTimeout(executeMcpToolInner(name, input, data), name, normalizeLimit(input.limit), timeoutMs);
}

async function executeMcpToolInner(name: string, input: Record<string, unknown>, data: McpRuntimeData): Promise<QueryEnvelope<unknown>> {
  const limit = normalizeLimit(input.limit);
  if (input.limit == null) {
    return createQueryEnvelope({
      query: { tool: name, limit },
      results: [],
      limit,
      errors: [{ code: "mcp.limit_required", message: "limit is required", retriable: false }],
    });
  }

  if (name === "natstrail.list_contexts") {
    return createQueryEnvelope({
      query: { tool: name },
      results: data.contexts.map(sanitizeContext),
      limit,
    });
  }

  if (name === "natstrail.get_connection_status") {
    const states = data.connectionStates?.length ? data.connectionStates : [data.connectionState ?? disconnectedState()];
    return createQueryEnvelope({
      query: { tool: name },
      results: states,
      limit,
    });
  }

  if (name === "natstrail.list_audit") {
    return createQueryEnvelope({
      query: { tool: name },
      results: data.auditEntries ?? [],
      limit,
    });
  }

  if (name === "natstrail.list_filters") {
    return createQueryEnvelope({
      query: { tool: name },
      results: data.filters ?? [],
      limit,
    });
  }

  if (name === "natstrail.run_filter") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.queryStreamMessages) return notImplemented(name, limit);
    const filterName = stringInput(input.filter);
    if (!filterName) return inputError(name, limit, "filter is required");
    const filter = (data.filters ?? []).find((item) => item.id === filterName || item.name === filterName);
    if (!filter) return inputError(name, limit, `filter not found: ${filterName}`);
    if (!filter.stream) return inputError(name, limit, `filter requires a stream: ${filter.id}`);
    try {
      // A saved filter's text and eventType are post-filters, so this pages the
      // budget for the same reason search_messages does.
      const collected = await collectMatching(
        data.queryStreamMessages,
        { stream: filter.stream, subject: filter.subject, fromTs: filter.fromTs, toTs: filter.toTs },
        limit,
        normalizeScan(input.maxScan),
        parseCursor(input.cursor),
        (message) => matchFilter(filter, message),
      );
      return createQueryEnvelope({
        query: { tool: name, contextId: input.contextId, filter: filter.id },
        results: collected.messages.map((message) => toAgentMessage(message, filter.stream, undefined, keysOf(data))),
        limit,
        nextCursor: collected.nextCursor,
        warnings: collected.warnings,
      });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_streams") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listStreams) return notImplemented(name, limit);
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId }, results: await data.listStreams(), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.get_stream_info") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listStreams) return notImplemented(name, limit);
    const stream = String(input.stream ?? "");
    if (!stream) return inputError(name, limit, "stream is required");
    try {
      const result = (await data.listStreams()).find((item) => item.name === stream);
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream }, results: result ? [result] : [], limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_consumers") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listConsumers) return notImplemented(name, limit);
    const stream = String(input.stream ?? "");
    if (!stream) return inputError(name, limit, "stream is required");
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream }, results: await data.listConsumers(stream), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.get_message_detail") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.getStreamMessage) return notImplemented(name, limit);
    const stream = String(input.stream ?? "");
    const seq = Number(input.seq);
    if (!stream) return inputError(name, limit, "stream is required");
    if (!Number.isFinite(seq) || seq <= 0) return inputError(name, limit, "seq must be a positive number");
    try {
      const msg = await data.getStreamMessage(stream, Math.floor(seq));
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream, seq }, results: msg ? [toAgentMessage(msg, stream, undefined, keysOf(data))] : [], limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.search_messages") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.queryStreamMessages) return notImplemented(name, limit);
    const stream = String(input.stream ?? "");
    if (!stream) return inputError(name, limit, "stream is required");
    // `subject`, `fromTs` and `toTs` are applied by the server. The rest can only
    // be evaluated after a payload is read, so they are post-filters — and a
    // post-filter applied to a single page of `limit` messages silently reports
    // "no matches" whenever the matches sit deeper in the stream. When one is
    // present, page through the scan budget instead of reading one page.
    const postFiltered =
      stringInput(input.text) !== undefined ||
      stringInput(input.requestId) !== undefined ||
      stringInput(input.correlationId) !== undefined;

    const keep = (message: Message): boolean => {
      if (!matchesString(message.data, input.text)) return false;
      const shaped = toAgentMessage(message, stream, undefined, keysOf(data));
      return (
        matchesString(shaped.requestId, input.requestId) &&
        matchesString(shaped.correlationId, input.correlationId)
      );
    };

    const query = {
      tool: name,
      contextId: input.contextId,
      stream,
      subject: input.subject,
      requestId: input.requestId,
      correlationId: input.correlationId,
      text: input.text,
    };

    try {
      if (!postFiltered) {
        const page = await data.queryStreamMessages({
          stream,
          subject: stringInput(input.subject),
          limit,
          startSeq: parseCursor(input.cursor),
          fromTs: numberInput(input.fromTs),
          toTs: numberInput(input.toTs),
          maxScan: numberInput(input.maxScan),
        });
        const results = page.messages.map((msg) => toAgentMessage(msg, stream, undefined, keysOf(data)));
        return createQueryEnvelope({ query, results, limit, nextCursor: page.nextCursor, warnings: page.warnings });
      }

      const collected = await collectMatching(
        data.queryStreamMessages,
        {
          stream,
          subject: stringInput(input.subject),
          fromTs: numberInput(input.fromTs),
          toTs: numberInput(input.toTs),
        },
        limit,
        normalizeScan(input.maxScan),
        parseCursor(input.cursor),
        keep,
      );
      return createQueryEnvelope({
        query,
        results: collected.messages.map((msg) => toAgentMessage(msg, stream, undefined, keysOf(data))),
        limit,
        nextCursor: collected.nextCursor,
        warnings: collected.warnings,
      });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (
    name === "natstrail.trace_by_key" ||
    name === "natstrail.trace_by_request_id" ||
    name === "natstrail.trace_by_correlation_id"
  ) {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.queryStreamMessages || !data.listStreams) return notImplemented(name, limit);

    // The two named tools are shortcuts for the generic one, kept so existing
    // callers and agent prompts do not break.
    const key =
      name === "natstrail.trace_by_request_id"
        ? "request_id"
        : name === "natstrail.trace_by_correlation_id"
          ? "correlation_id"
          : stringInput(input.key);
    const value =
      name === "natstrail.trace_by_request_id"
        ? stringInput(input.requestId)
        : name === "natstrail.trace_by_correlation_id"
          ? stringInput(input.correlationId)
          : stringInput(input.value);

    if (!key) return inputError(name, limit, "key is required");
    if (!value) return inputError(name, limit, `a value for ${key} is required`);

    const configured = keysOf(data);
    if (!configured.some((item) => item.name === key)) {
      return inputError(
        name,
        limit,
        `unknown correlation key: ${key}. Configured keys are ${configured.map((item) => item.name).join(", ")}`,
      );
    }

    try {
      const streams = await data.listStreams();
      const found: AgentMessage[] = [];
      const warnings: QueryWarning[] = [];
      const budget = normalizeScan(input.maxScan);

      // Indexed streams are answered by lookup instead of a sweep. Everything
      // else still scans, so an index is an optimisation rather than a
      // precondition.
      const coverage = data.indexCoverage?.() ?? [];
      const indexed = new Map(coverage.map((entry) => [entry.stream, entry]));

      if (indexed.size > 0 && data.lookupCorrelation && data.getStreamMessage) {
        for (const location of data.lookupCorrelation(key, value, limit)) {
          if (found.length >= limit) break;
          if (!indexed.has(location.stream)) continue;
          const message = await data.getStreamMessage(location.stream, location.seq).catch(() => null);
          if (message) found.push(toAgentMessage(message, location.stream, undefined, configured));
        }
        for (const entry of indexed.values()) {
          warnings.push({
            code: "index.used",
            message: `${entry.stream}: answered from the index, which covers sequences ${entry.fromSeq}-${entry.toSeq}. Anything outside that range was not consulted.`,
          });
        }
      }

      for (const stream of streams) {
        if (found.length >= limit) break;
        // KV and Object Store backing streams carry no application correlation.
        if (/^(KV|OBJ)_/.test(stream.name)) continue;
        // Already answered above, and far more cheaply.
        if (indexed.has(stream.name)) continue;
        const collected = await collectMatching(
          data.queryStreamMessages,
          { stream: stream.name, fromTs: numberInput(input.fromTs), toTs: numberInput(input.toTs) },
          limit - found.length,
          budget,
          undefined,
          (message) => extractCorrelations(message, configured)[key] === value,
        );
        warnings.push(
          ...collected.warnings.map((warning) => ({ ...warning, message: `${stream.name}: ${warning.message}` })),
        );
        found.push(...collected.messages.map((message) => toAgentMessage(message, stream.name, undefined, configured)));
      }

      found.sort((a, b) => a.timestamp - b.timestamp);
      return createQueryEnvelope({
        query: { tool: name, contextId: input.contextId, key, value },
        results: found,
        limit,
        warnings,
      });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.search_dlq") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.queryStreamMessages || !data.listStreams) return notImplemented(name, limit);
    try {
      const streams = await data.listStreams();
      const found: AgentDlqEvent[] = [];
      const warnings: QueryWarning[] = [];
      const subject = stringInput(input.subject);
      for (const stream of streams) {
        if (found.length >= limit) break;
        const dlqSubjects = (subject ? [subject] : stream.subjects.filter(isDlqSubject))
          .filter((dlqSubject) => stream.subjects.some((s) => subjectMatches(s, dlqSubject) || subjectMatches(dlqSubject, s)));
        for (const dlqSubject of dlqSubjects) {
          if (found.length >= limit) break;
          const page = await data.queryStreamMessages({
            stream: stream.name,
            subject: dlqSubject,
            limit: limit - found.length,
            fromTs: numberInput(input.fromTs),
            toTs: numberInput(input.toTs),
            maxScan: numberInput(input.maxScan),
          });
          warnings.push(...page.warnings.map((warning) => ({ ...warning, message: `${stream.name}: ${warning.message}` })));
          for (const message of page.messages) {
            const event = parseDlqEvent(message);
            found.push({
              message: toAgentMessage(message, stream.name, undefined, keysOf(data)),
              originalSubject: event.originalSubject,
              reason: event.reason,
            });
          }
        }
      }
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, subject }, results: found, limit, warnings });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_kv_buckets") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listKvBuckets) return notImplemented(name, limit);
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId }, results: await data.listKvBuckets(), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_kv_keys") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listKvEntries) return notImplemented(name, limit);
    const bucket = stringInput(input.bucket);
    if (!bucket) return inputError(name, limit, "bucket is required");
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, bucket }, results: await data.listKvEntries(bucket, limit), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.get_kv_history") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.kvHistory) return notImplemented(name, limit);
    const bucket = stringInput(input.bucket);
    const key = stringInput(input.key);
    if (!bucket) return inputError(name, limit, "bucket is required");
    if (!key) return inputError(name, limit, "key is required");
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, bucket, key }, results: await data.kvHistory(bucket, key, limit), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_object_buckets") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listObjectBuckets) return notImplemented(name, limit);
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId }, results: await data.listObjectBuckets(), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_objects") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listObjects) return notImplemented(name, limit);
    const bucket = stringInput(input.bucket);
    if (!bucket) return inputError(name, limit, "bucket is required");
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, bucket }, results: await data.listObjects(bucket, limit), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.get_server_health") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.serverHealth) return notImplemented(name, limit);
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId }, results: [await data.serverHealth()], limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_server_connections") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.serverConnections) return notImplemented(name, limit);
    try {
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId }, results: await data.serverConnections(limit), limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.list_correlation_keys") {
    const keys = keysOf(data);
    return createQueryEnvelope({
      query: { tool: name, contextId: input.contextId },
      results: keys.map((key) => ({
        ...key,
        // Say where a key came from, so "why did this not match" is answerable.
        source: data.correlationKeys?.length ? "configured" : "default",
      })),
      limit,
    });
  }

  if (name === "natstrail.suggest_correlation_keys") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listStreams || !data.streamSubjects || !data.queryStreamMessages) return notImplemented(name, limit);
    const sample = Math.min(Math.max(numberInput(input.sample) ?? 20, 1), 100);
    const onlyStream = stringInput(input.stream);

    try {
      const streams = (await data.listStreams()).filter((s) => !onlyStream || s.name === onlyStream);
      const fields: { path: string; subject: string; values: string[] }[] = [];
      const warnings: QueryWarning[] = [];

      for (const stream of streams) {
        if (/^(KV|OBJ)_/.test(stream.name)) continue;
        const seen = await data.streamSubjects(stream.name).catch(() => ({}));
        for (const { subject } of subjectsOfStream(stream, seen)) {
          const page = await data.queryStreamMessages({
            stream: stream.name,
            subject,
            limit: sample,
            maxScan: numberInput(input.maxScan),
          });
          warnings.push(...page.warnings.map((w) => ({ ...w, message: `${stream.name}/${subject}: ${w.message}` })));
          // Collect every string leaf, so the suggester sees real values rather
          // than the summarised shape.
          const byPath = new Map<string, string[]>();
          for (const message of page.messages) {
            if (!message.isJson || message.json === null) continue;
            for (const [path, value] of flattenStrings(message.json)) {
              const list = byPath.get(path) ?? [];
              list.push(value);
              byPath.set(path, list);
            }
          }
          for (const [path, values] of byPath) fields.push({ path, subject, values });
        }
      }

      const configured = new Set(keysOf(data).flatMap((key) => key.paths ?? []));
      const results = suggestCorrelationKeys(fields)
        // Do not propose what is already configured.
        .filter((candidate) => !configured.has(candidate.path));

      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, sample }, results, limit, warnings });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.discover_subjects") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listStreams || !data.streamSubjects || !data.queryStreamMessages) return notImplemented(name, limit);
    const sample = Math.min(Math.max(numberInput(input.sample) ?? 10, 1), 100);
    const onlyStream = stringInput(input.stream);
    const onlySubject = stringInput(input.subject);
    try {
      const streams = (await data.listStreams()).filter((s) => !onlyStream || s.name === onlyStream);
      const results: SubjectShape[] = [];
      const warnings: QueryWarning[] = [];

      for (const stream of streams) {
        if (results.length >= limit) break;
        // Skip the KV and Object Store backing streams: their subjects are an
        // implementation detail, not part of the application's topology.
        if (/^(KV|OBJ)_/.test(stream.name)) continue;
        const seen = await data.streamSubjects(stream.name).catch(() => ({}));
        for (const { subject, messages } of subjectsOfStream(stream, seen)) {
          if (results.length >= limit) break;
          if (onlySubject && !subjectMatches(onlySubject, subject)) continue;
          const page = await data.queryStreamMessages({
            stream: stream.name,
            subject,
            limit: sample,
            maxScan: numberInput(input.maxScan),
          });
          warnings.push(...page.warnings.map((w) => ({ ...w, message: `${stream.name}/${subject}: ${w.message}` })));
          const encodings = new Set(page.messages.map((m) => m.encoding ?? "text"));
          results.push({
            subject,
            stream: stream.name,
            messages,
            fields: inferFields(page.messages),
            sampled: page.messages.length,
            encoding: encodings.size === 1 ? [...encodings][0] : encodings.size === 0 ? "text" : "mixed",
            lastTs: page.messages.length ? page.messages[page.messages.length - 1].timestamp : null,
          });
        }
      }
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream: onlyStream, subject: onlySubject, sample }, results, limit, warnings });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.reconstruct_flow") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    const requestId = stringInput(input.requestId);
    const correlationId = stringInput(input.correlationId);
    if (!requestId && !correlationId) return inputError(name, limit, "requestId or correlationId is required");
    // Reuse the trace tool rather than re-implementing the cross-stream sweep.
    const key = requestId ? "request_id" : "correlation_id";
    const traceTool = requestId ? "natstrail.trace_by_request_id" : "natstrail.trace_by_correlation_id";
    const trace = await executeMcpToolInner(traceTool, input, data);
    if (trace.errors.length) return trace;
    const flow = reconstructFlow(key, (requestId ?? correlationId)!, trace.results as AgentMessage[]);
    return createQueryEnvelope({
      query: { tool: name, contextId: input.contextId, [key]: requestId ?? correlationId },
      results: [flow],
      limit,
      warnings: trace.warnings,
    });
  }

  if (name === "natstrail.get_health_summary") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.listStreams || !data.listConsumers) return notImplemented(name, limit);
    try {
      const streams = await data.listStreams();
      const consumers: Consumer[] = [];
      for (const stream of streams) {
        consumers.push(...(await data.listConsumers(stream.name).catch(() => [])));
      }
      // Dead letters are counted from stream state, not by scanning payloads.
      const dlqCounts: Record<string, number> = {};
      if (data.streamSubjects) {
        for (const stream of streams) {
          const seen = await data.streamSubjects(stream.name).catch(() => ({}));
          for (const [subject, count] of Object.entries(seen)) {
            if (isDlqSubject(subject)) dlqCounts[subject] = count;
          }
        }
      }
      const server = data.serverHealth ? await data.serverHealth().catch(() => null) : null;
      const results = summarizeHealth({ streams, consumers, dlqCounts, server });
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId }, results, limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.enrich_incident") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    const requestId = stringInput(input.requestId);
    const correlationId = stringInput(input.correlationId);
    if (!requestId && !correlationId) return inputError(name, limit, "requestId or correlationId is required");

    const key: "request_id" | "correlation_id" = requestId ? "request_id" : "correlation_id";
    const value = (requestId ?? correlationId)!;

    // Composed from the read tools rather than re-querying: one definition of
    // what a flow, a dead letter and a finding are.
    const flowEnvelope = await executeMcpToolInner("natstrail.reconstruct_flow", input, data);
    const dlqEnvelope = await executeMcpToolInner("natstrail.search_dlq", input, data);
    const healthEnvelope = await executeMcpToolInner("natstrail.get_health_summary", input, data);

    const flow = (flowEnvelope.results[0] as Flow | undefined) ?? null;
    // Only dead letters that belong to this incident.
    const dlq = (dlqEnvelope.results as AgentDlqEvent[]).filter(
      (event) => event.message.requestId === value || event.message.correlationId === value,
    );
    const findings = healthEnvelope.results as HealthFinding[];
    const uiBase = stringInput(input.uiBaseUrl)?.replace(/\/+$/, "");

    const context: IncidentContext = {
      key,
      value,
      summary: summarizeIncident({ value, flow, dlq: dlq as unknown as DLQEvent[], findings }),
      flow,
      dlq: dlq as unknown as DLQEvent[],
      findings,
      traceUrl: uiBase ? `${uiBase}/?tab=trace&${key === "request_id" ? "requestId" : "correlationId"}=${encodeURIComponent(value)}` : null,
    };

    return createQueryEnvelope({
      query: { tool: name, contextId: input.contextId, [key]: value },
      results: [context],
      limit,
      warnings: [...flowEnvelope.warnings, ...dlqEnvelope.warnings],
      errors: [...flowEnvelope.errors, ...dlqEnvelope.errors],
    });
  }

  if (name === "natstrail.enrich_sentry") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    const traces = [];
    if (stringInput(input.requestId)) {
      traces.push(await executeMcpToolInner("natstrail.trace_by_request_id", input, data));
    }
    if (stringInput(input.correlationId)) {
      traces.push(await executeMcpToolInner("natstrail.trace_by_correlation_id", input, data));
    }
    const dlq = await executeMcpToolInner("natstrail.search_dlq", input, data);
    return createQueryEnvelope({
      query: { tool: name, contextId: input.contextId, requestId: input.requestId, correlationId: input.correlationId },
      results: [{ traces, dlq }],
      limit: 1,
    });
  }

  return notImplemented(name, limit);
}

async function withTimeout(work: Promise<QueryEnvelope<unknown>>, name: string, limit: number, timeoutMs: number): Promise<QueryEnvelope<unknown>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<QueryEnvelope<unknown>>((resolve) => {
    timer = setTimeout(() => {
      resolve(createQueryEnvelope({
        query: { tool: name },
        results: [],
        limit,
        errors: [{ code: "mcp.timeout", message: `Tool timed out after ${timeoutMs}ms`, retriable: true }],
      }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateConnectedContext(name: string, input: Record<string, unknown>, data: McpRuntimeData): QueryEnvelope<unknown> | null {
  const contextId = String(input.contextId ?? "");
  const limit = normalizeLimit(input.limit);
  if (!contextId) return inputError(name, limit, "contextId is required");
  if (data.activeContextId !== contextId) {
    return createQueryEnvelope({
      query: { tool: name, contextId, limit },
      results: [],
      limit,
      errors: [{ code: "mcp.context_not_connected", message: `Context is not connected: ${contextId}`, retriable: true }],
    });
  }
  return null;
}

function inputError(name: string, limit: number, message: string): QueryEnvelope<unknown> {
  return createQueryEnvelope({
    query: { tool: name },
    results: [],
    limit,
    errors: [{ code: "mcp.input", message, retriable: false }],
  });
}

function notImplemented(name: string, limit: number): QueryEnvelope<unknown> {
  return toolError(name, limit, `Tool not implemented yet: ${name}`);
}

function toolError(name: string, limit: number, err: unknown): QueryEnvelope<unknown> {
  return createQueryEnvelope({ query: { tool: name }, results: [], limit, errors: [normalizeError(err)] });
}

function disconnectedState(): ConnectionState {
  return { status: "disconnected", contextId: null, url: null, error: null, reconnects: 0 };
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberInput(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function matchesString(actual: string | null | undefined, expected: unknown): boolean {
  if (typeof expected !== "string" || !expected) return true;
  return (actual ?? "").toLowerCase().includes(expected.toLowerCase());
}
