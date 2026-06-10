export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  readOnly: true;
  timeoutMs: number;
}

export interface ToolInputError {
  code: string;
  message: string;
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
  tool("natstrail.get_connection_status", "Get the current bridge connection state.", withLimit({})),
  tool("natstrail.list_audit", "List recent Integration API audit entries.", withLimit({})),
  tool("natstrail.list_filters", "List saved reusable filters.", withLimit({})),
  tool("natstrail.run_filter", "Run a saved filter by id or name.", { contextId: { type: "string" }, filter: { type: "string" }, limit: limitProperty }),
  tool("natstrail.list_streams", "List JetStream streams for a context.", { contextId: { type: "string" }, limit: limitProperty }),
  tool("natstrail.get_stream_info", "Get one stream summary.", withLimit({ contextId: { type: "string" }, stream: { type: "string" } })),
  tool("natstrail.list_consumers", "List consumers for a stream.", { contextId: { type: "string" }, stream: { type: "string" }, limit: limitProperty }),
  tool("natstrail.search_messages", "Search bounded NATS/JetStream messages.", { contextId: { type: "string" }, stream: { type: "string" }, subject: { type: "string" }, requestId: { type: "string" }, correlationId: { type: "string" }, text: { type: "string" }, limit: limitProperty }, ["contextId", "stream", "limit"]),
  tool("natstrail.trace_by_request_id", "Trace messages by request_id.", { contextId: { type: "string" }, requestId: { type: "string" }, limit: limitProperty }),
  tool("natstrail.trace_by_correlation_id", "Trace messages by correlation_id.", { contextId: { type: "string" }, correlationId: { type: "string" }, limit: limitProperty }),
  tool("natstrail.search_dlq", "Search dead-letter messages.", { contextId: { type: "string" }, subject: { type: "string" }, limit: limitProperty }, ["contextId", "limit"]),
  tool("natstrail.enrich_sentry", "Collect trace and DLQ context for a Sentry issue.", { contextId: { type: "string" }, requestId: { type: "string" }, correlationId: { type: "string" }, limit: limitProperty }, ["contextId", "limit"]),
  tool("natstrail.get_message_detail", "Get a single message detail by locator.", withLimit({ contextId: { type: "string" }, stream: { type: "string" }, seq: { type: "integer" } })),
];

export function validateToolInput(name: string, input: Record<string, unknown>): ToolInputError[] {
  const tool = mcpTools.find((item) => item.name === name);
  if (!tool) return [{ code: "mcp.unknown_tool", message: `Unknown tool: ${name}` }];
  const schema = tool.inputSchema as {
    required?: string[];
    additionalProperties?: boolean;
    properties?: Record<string, { type?: string | string[]; minimum?: number; maximum?: number }>;
  };
  const errors: ToolInputError[] = [];
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (input[key] == null) errors.push({ code: "mcp.required", message: `${key} is required` });
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!properties[key]) errors.push({ code: "mcp.unknown_field", message: `Unknown field: ${key}` });
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property || value == null) continue;
    if (property.type && !matchesSchemaType(value, property.type)) {
      errors.push({ code: "mcp.type", message: `${key} has invalid type` });
      continue;
    }
    if (typeof value === "number" && property.minimum != null && value < property.minimum) {
      errors.push({ code: "mcp.minimum", message: `${key} must be >= ${property.minimum}` });
    }
    if (typeof value === "number" && property.maximum != null && value > property.maximum) {
      errors.push({ code: "mcp.maximum", message: `${key} must be <= ${property.maximum}` });
    }
  }
  return errors;
}

function matchesSchemaType(value: unknown, expected: string | string[]): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "null") return value === null;
    return typeof value === type;
  });
}

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
