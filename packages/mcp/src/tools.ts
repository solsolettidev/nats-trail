export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  readOnly: true;
  timeoutMs: number;
}

const envelopeSchema = {
  type: "object",
  required: ["query", "summary", "results", "nextCursor", "warnings", "errors"],
  properties: {
    query: { type: "object" },
    summary: { type: "object" },
    results: { type: "array" },
    nextCursor: { type: ["string", "null"] },
    warnings: { type: "array" },
    errors: { type: "array" },
  },
};

const limitProperty = {
  type: "integer",
  minimum: 1,
  maximum: 200,
  description: "Required maximum number of results.",
};

export const mcpTools: McpToolDefinition[] = [
  tool("natstrail.list_contexts", "List sanitized configured contexts.", withLimit({})),
  tool("natstrail.list_streams", "List JetStream streams for a context.", { contextId: { type: "string" }, limit: limitProperty }),
  tool("natstrail.get_stream_info", "Get one stream summary.", withLimit({ contextId: { type: "string" }, stream: { type: "string" } })),
  tool("natstrail.list_consumers", "List consumers for a stream.", { contextId: { type: "string" }, stream: { type: "string" }, limit: limitProperty }),
  tool("natstrail.search_messages", "Search bounded NATS/JetStream messages.", { contextId: { type: "string" }, stream: { type: "string" }, subject: { type: "string" }, requestId: { type: "string" }, correlationId: { type: "string" }, text: { type: "string" }, limit: limitProperty }, ["contextId", "stream", "limit"]),
  tool("natstrail.trace_by_request_id", "Trace messages by request_id.", { contextId: { type: "string" }, requestId: { type: "string" }, limit: limitProperty }),
  tool("natstrail.trace_by_correlation_id", "Trace messages by correlation_id.", { contextId: { type: "string" }, correlationId: { type: "string" }, limit: limitProperty }),
  tool("natstrail.search_dlq", "Search dead-letter messages.", { contextId: { type: "string" }, subject: { type: "string" }, limit: limitProperty }, ["contextId", "limit"]),
  tool("natstrail.get_message_detail", "Get a single message detail by locator.", withLimit({ contextId: { type: "string" }, stream: { type: "string" }, seq: { type: "integer" } })),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      required,
      additionalProperties: false,
      properties,
    },
    outputSchema: envelopeSchema,
    readOnly: true,
    timeoutMs: 5000,
  };
}

function withLimit(properties: Record<string, unknown>): Record<string, unknown> {
  return { ...properties, limit: limitProperty };
}
