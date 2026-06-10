import {
  createQueryEnvelope,
  isDlqSubject,
  matchFilter,
  normalizeError,
  normalizeLimit,
  parseDlqEvent,
  sanitizeContext,
  toAgentMessage,
  type AgentMessage,
  type Context,
  type Consumer,
  type Filter,
  type Message,
  type QueryEnvelope,
  type Stream,
} from "@nats-trail/core";
import { mcpTools } from "./tools.js";

export interface McpRuntimeData {
  contexts: Context[];
  filters?: Filter[];
  activeContextId?: string | null;
  listStreams?: () => Promise<Stream[]>;
  listConsumers?: (stream: string) => Promise<Consumer[]>;
  getStreamMessage?: (stream: string, seq: number) => Promise<Message | null>;
  searchStreamMessages?: (input: { stream: string; subject?: string; limit: number }) => Promise<Message[]>;
}

interface AgentDlqEvent {
  message: AgentMessage;
  originalSubject: string | null;
  reason: string | null;
}

export async function executeMcpTool(name: string, input: Record<string, unknown>, data: McpRuntimeData): Promise<QueryEnvelope<unknown>> {
  const timeoutMs = mcpTools.find((tool) => tool.name === name)?.timeoutMs ?? 5000;
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
    if (!data.searchStreamMessages) return notImplemented(name, limit);
    const filterName = stringInput(input.filter);
    if (!filterName) return inputError(name, limit, "filter is required");
    const filter = (data.filters ?? []).find((item) => item.id === filterName || item.name === filterName);
    if (!filter) return inputError(name, limit, `filter not found: ${filterName}`);
    if (!filter.stream) return inputError(name, limit, `filter requires a stream: ${filter.id}`);
    try {
      const messages = await data.searchStreamMessages({ stream: filter.stream, subject: filter.subject, limit });
      const results = messages.filter((message) => matchFilter(filter, message)).map((message) => toAgentMessage(message, filter.stream));
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, filter: filter.id }, results, limit });
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
    if (!data.searchStreamMessages) return notImplemented(name, limit);
    const stream = String(input.stream ?? "");
    if (!stream) return inputError(name, limit, "stream is required");
    try {
      const messages = await data.searchStreamMessages({ stream, subject: stringInput(input.subject), limit });
      const results = messages
        .filter((msg) => matchesString(msg.data, input.text))
        .map((msg) => toAgentMessage(msg, stream))
        .filter((msg) => matchesString(msg.requestId, input.requestId))
        .filter((msg) => matchesString(msg.correlationId, input.correlationId));
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, stream, subject: input.subject, requestId: input.requestId, correlationId: input.correlationId, text: input.text }, results, limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.trace_by_request_id" || name === "natstrail.trace_by_correlation_id") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.searchStreamMessages || !data.listStreams) return notImplemented(name, limit);
    const key = name.endsWith("request_id") ? "requestId" : "correlationId";
    const value = stringInput(input[key]);
    if (!value) return inputError(name, limit, `${key} is required`);
    try {
      const streams = await data.listStreams();
      const found: AgentMessage[] = [];
      for (const stream of streams) {
        if (found.length >= limit) break;
        const messages = await data.searchStreamMessages({ stream: stream.name, limit });
        const shaped = messages.map((msg) => toAgentMessage(msg, stream.name));
        found.push(...shaped.filter((msg) => key === "requestId" ? msg.requestId === value : msg.correlationId === value));
      }
      found.sort((a, b) => a.timestamp - b.timestamp);
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, [key]: value }, results: found, limit });
    } catch (err) {
      return toolError(name, limit, err);
    }
  }

  if (name === "natstrail.search_dlq") {
    const error = validateConnectedContext(name, input, data);
    if (error) return error;
    if (!data.searchStreamMessages || !data.listStreams) return notImplemented(name, limit);
    try {
      const streams = await data.listStreams();
      const found: AgentDlqEvent[] = [];
      const subject = stringInput(input.subject);
      for (const stream of streams) {
        if (found.length >= limit) break;
        const dlqSubjects = subject ? [subject] : stream.subjects.filter(isDlqSubject);
        for (const dlqSubject of dlqSubjects) {
          if (found.length >= limit) break;
          const messages = await data.searchStreamMessages({ stream: stream.name, subject: dlqSubject, limit });
          for (const message of messages) {
            const event = parseDlqEvent(message);
            found.push({
              message: toAgentMessage(message, stream.name),
              originalSubject: event.originalSubject,
              reason: event.reason,
            });
            if (found.length >= limit) break;
          }
        }
      }
      return createQueryEnvelope({ query: { tool: name, contextId: input.contextId, subject }, results: found, limit });
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

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function matchesString(actual: string | null | undefined, expected: unknown): boolean {
  if (typeof expected !== "string" || !expected) return true;
  return (actual ?? "").toLowerCase().includes(expected.toLowerCase());
}
