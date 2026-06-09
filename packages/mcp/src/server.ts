import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeMcpTool } from "./runtime.js";
import { mcpTools } from "./tools.js";
import { loadLocalContexts, loadLocalFilters } from "./local-data.js";

const server = new Server(
  { name: "nats-trail", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const input = request.params.arguments && typeof request.params.arguments === "object"
    ? request.params.arguments as Record<string, unknown>
    : {};
  const envelope = await executeMcpTool(request.params.name, input, {
    contexts: loadLocalContexts(),
    filters: loadLocalFilters(),
  });
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    isError: envelope.errors.length > 0,
  };
});

await server.connect(new StdioServerTransport());
