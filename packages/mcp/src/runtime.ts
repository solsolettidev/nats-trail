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
}

/** Page size used when a tool scans a stream window incrementally. */
const SCAN_PAGE_SIZE = 500;

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
      const page = await data.queryStreamMessages({
        stream: filter.stream,
        subject: filter.subject,
        limit,
        startSeq: parseCursor(input.cursor),
        fromTs: filter.fromTs,
        toTs: filter.toTs,
        maxScan: numberInput(input.maxScan),
      });
      const results = page.messages.filter((message) => matchFilter(filter, message)).map((message) => toAgentMessage(message, filter.stream));
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, filter: filter.id }, results, limit, nextCursor: page.nextCursor, warnings: page.warnings });
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
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream, seq }, results: msg ? [toAgentMessage(msg, stream)] : [], limit });
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
    try {
      const page = await data.queryStreamMessages({
        stream,
        subject: stringInput(input.subject),
        limit,
        startSeq: parseCursor(input.cursor),
        fromTs: numberInput(input.fromTs),
        toTs: numberInput(input.toTs),
        maxScan: numberInput(input.maxScan),
      });
      const results = page.messages
        .filter((msg) => matchesString(msg.data, input.text))
        .map((msg) => toAgentMessage(msg, stream))
        .filter((msg) => matchesString(msg.requestId, input.requestId))
        .filter((msg) => matchesString(msg.correlationId, input.correlationId));
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream, subject: input.subject, requestId: input.requestId, correlationId: input.correlationId, text: input.text }, results, limit, nextCursor: page.nextCursor, warnings: page.warnings });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.trace_by_request_id" || name === "natstrail.trace_by_correlation_id") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.queryStreamMessages || !data.listStreams) return notImplemented(name, limit);
    const key = name.endsWith("request_id") ? "requestId" : "correlationId";
    const value = stringInput(input[key]);
    if (!value) return inputError(name, limit, `${key} is required`);
    try {
      const streams = await data.listStreams();
      const found: AgentMessage[] = [];
      const warnings: QueryWarning[] = [];
      const budget = normalizeScan(input.maxScan);
      for (const stream of streams) {
        if (found.length >= limit) break;
        // Page through the stream window so the whole budget is scanned for
        // matches, not just the first page of messages.
        let startSeq: number | undefined;
        let scanned = 0;
        while (scanned < budget && found.length < limit) {
          const page = await data.queryStreamMessages({
            stream: stream.name,
            limit: SCAN_PAGE_SIZE,
            startSeq,
            fromTs: numberInput(input.fromTs),
            toTs: numberInput(input.toTs),
            maxScan: budget - scanned,
          });
          scanned += page.scanned;
          warnings.push(...page.warnings.map((warning) => ({ ...warning, message: `${stream.name}: ${warning.message}` })));
          const shaped = page.messages.map((msg) => toAgentMessage(msg, stream.name));
          found.push(...shaped.filter((msg) => key === "requestId" ? msg.requestId === value : msg.correlationId === value));
          if (!page.nextCursor) break;
          startSeq = parseCursor(page.nextCursor);
        }
      }
      found.sort((a, b) => a.timestamp - b.timestamp);
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, [key]: value }, results: found, limit, warnings });
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
              message: toAgentMessage(message, stream.name),
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
