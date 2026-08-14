import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executeMcpTool, mcpTools, validateToolInput } from "../packages/mcp/dist/index.js";

const RUNTIME_SOURCE = new URL("../packages/mcp/src/runtime.ts", import.meta.url);

test("every tool is declared read-only with schemas and a timeout", () => {
  assert.equal(mcpTools.length > 0, true);
  for (const tool of mcpTools) {
    assert.equal(tool.readOnly, true, `${tool.name} must be read-only`);
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.description.length > 0, true, `${tool.name} needs a description`);
    assert.equal(typeof tool.inputSchema, "object", `${tool.name} needs an input schema`);
    assert.equal(typeof tool.outputSchema, "object", `${tool.name} needs an output schema`);
    assert.equal(tool.timeoutMs > 0, true, `${tool.name} needs a timeout`);
    assert.match(tool.name, /^natstrail\./);
  }
});

test("no tool name suggests a mutation", () => {
  // The read-only guarantee is the product's core claim. If a write tool is
  // ever added to this list, that claim is broken and this test must fail.
  const forbidden = /(^|_)(publish|put|post|delete|purge|remove|drop|create|update|edit|write|set|ack|nak)(_|$)/;
  for (const tool of mcpTools) {
    const bare = tool.name.replace(/^natstrail\./, "");
    assert.equal(forbidden.test(bare), false, `${tool.name} looks like a mutation`);
  }
});

test("the runtime data interface exposes no write capability", () => {
  // Reading the source is deliberate: the guarantee is that writes are absent
  // from the interface the runtime is handed, not merely disabled at runtime.
  const source = readFileSync(RUNTIME_SOURCE, "utf8");
  const start = source.indexOf("export interface McpRuntimeData");
  assert.equal(start > -1, true, "McpRuntimeData must exist");
  const body = source.slice(start, source.indexOf("\n}", start));
  const forbidden = ["publish", "purge", "deleteMsg", "delete(", "put(", "update", "addStream", "addConsumer"];
  for (const term of forbidden) {
    assert.equal(body.includes(term), false, `McpRuntimeData must not expose ${term}`);
  }
});

test("every tool requires an explicit limit", () => {
  for (const tool of mcpTools) {
    const required = tool.inputSchema.required ?? [];
    assert.equal(required.includes("limit"), true, `${tool.name} must require an explicit limit`);
  }
});

test("validateToolInput rejects missing required fields", () => {
  const errors = validateToolInput("natstrail.list_streams", {});
  assert.equal(errors.length > 0, true);
  assert.equal(errors.some((e) => e.message.includes("limit")), true);
});

test("validateToolInput rejects unknown fields and out-of-range limits", () => {
  const unknown = validateToolInput("natstrail.list_contexts", { limit: 10, bogus: 1 });
  assert.equal(unknown.some((e) => e.code === "mcp.unknown_field"), true);

  const tooBig = validateToolInput("natstrail.list_contexts", { limit: 5000 });
  assert.equal(tooBig.length > 0, true, "a limit above the cap must be rejected, not silently clamped");
});

test("validateToolInput rejects an unknown tool", () => {
  const errors = validateToolInput("natstrail.definitely_not_a_tool", { limit: 1 });
  assert.equal(errors.some((e) => e.code === "mcp.unknown_tool"), true);
});

test("validateToolInput accepts a well-formed call", () => {
  assert.deepEqual(validateToolInput("natstrail.list_contexts", { limit: 10 }), []);
});

test("executeMcpTool returns a structured error for an unknown tool", async () => {
  const envelope = await executeMcpTool("natstrail.nope", { limit: 5 }, { contexts: [] });
  assert.equal(envelope.errors.length > 0, true);
  assert.equal(envelope.results.length, 0);
  assert.equal(typeof envelope.summary.returned, "number");
});

test("executeMcpTool refuses a live tool when the context is not connected", async () => {
  const envelope = await executeMcpTool(
    "natstrail.list_streams",
    { contextId: "prod", limit: 5 },
    { contexts: [], activeContextId: null },
  );
  assert.equal(envelope.errors[0].code, "mcp.context_not_connected");
  assert.equal(envelope.errors[0].retriable, true);
  assert.equal(envelope.results.length, 0);
});

test("executeMcpTool always returns the full envelope shape", async () => {
  const envelope = await executeMcpTool("natstrail.list_contexts", { limit: 5 }, { contexts: [] });
  for (const key of ["query", "summary", "results", "nextCursor", "warnings", "errors"]) {
    assert.equal(key in envelope, true, `envelope is missing ${key}`);
  }
  assert.equal(Array.isArray(envelope.results), true);
});

test("list_contexts never leaks credentials through the agent surface", async () => {
  const envelope = await executeMcpTool(
    "natstrail.list_contexts",
    { limit: 5 },
    {
      contexts: [
        {
          id: "prod",
          name: "Prod",
          environment: "prod",
          url: "nats://prod:4222",
          auth: { type: "userpass", username: "admin", password: "hunter2" },
          tls: { enabled: false },
        },
      ],
    },
  );
  assert.equal(JSON.stringify(envelope).includes("hunter2"), false);
});
