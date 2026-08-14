#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createQueryEnvelope, sanitizeContext, validateContext, type AuthType, type ConnectionState, type Context, type Environment, type Filter } from "@nats-trail/core";
import { callIntegrationTool, executeMcpTool, mcpTools } from "@nats-trail/mcp";
import WebSocket from "ws";

type Output = "text" | "json" | "ndjson";

interface Preferences {
  selectedContextId: string | null;
  lastSubject: string | null;
  recentSubjects: string[];
  favoriteSubjects: string[];
  recentStreams: string[];
  dlqSubjects: string[];
  messageViewerMode: "tree" | "raw";
}

const DATA_DIR = process.env.NATS_TRAIL_DATA ?? join(process.cwd(), "data");
const INTEGRATION_API = process.env.NATS_TRAIL_API;
const API_TOKEN = process.env.NATS_TRAIL_TOKEN;
const CONTEXTS_FILE = join(DATA_DIR, "contexts.json");
const PREFS_FILE = join(DATA_DIR, "preferences.json");
const FILTERS_FILE = join(DATA_DIR, "filters.json");
let interactiveMode = false;

/**
 * True when the current invocation asked for agent-shaped output. Hoisted
 * because `stripKnownFlags` removes --agent before commands are dispatched,
 * so a mutation guard cannot find it by inspecting its own arguments.
 */
let agentMode = false;

const DEFAULT_PREFS: Preferences = {
  selectedContextId: null,
  lastSubject: null,
  recentSubjects: [],
  favoriteSubjects: [],
  recentStreams: [],
  dlqSubjects: [],
  messageViewerMode: "tree",
};

const NUMERIC_FLAGS = new Set([
  "limit", "seq", "timeoutMs", "fromTs", "toTs", "maxScan", "port", "keep", "expectedRevision",
  "replicas", "maxAge", "maxMessages", "maxBytes", "startSeq", "ackWait", "maxDeliver",
]);

/** Flags that are switches rather than key/value pairs. */
const BOOLEAN_FLAGS = new Set(["yes", "noAutoConnect"]);

/**
 * Tools require an explicit limit so agents never ask for unbounded results. A
 * human typing `nats-ui streams list` should not have to know that, so the CLI
 * fills one in and still sends it explicitly.
 */
const DEFAULT_LIMIT = 50;

const LIVE_TOOLS = new Set([
  "natstrail.run_filter",
  "natstrail.list_streams",
  "natstrail.get_stream_info",
  "natstrail.list_consumers",
  "natstrail.search_messages",
  "natstrail.get_message_detail",
  "natstrail.trace_by_request_id",
  "natstrail.trace_by_correlation_id",
  "natstrail.search_dlq",
  "natstrail.enrich_sentry",
  "natstrail.list_kv_buckets",
  "natstrail.list_kv_keys",
  "natstrail.get_kv_history",
  "natstrail.list_object_buckets",
  "natstrail.list_objects",
  "natstrail.get_server_health",
  "natstrail.list_server_connections",
  "natstrail.discover_subjects",
  "natstrail.reconstruct_flow",
  "natstrail.get_health_summary",
]);

main(process.argv.slice(2)).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

async function main(args: string[]): Promise<void> {
  if (args.length === 0) {
    await startInteractive();
    return;
  }
  await runCommand(args);
}

async function runCommand(args: string[]): Promise<void> {
  const agent = args.includes("--agent");
  agentMode = agent;
  const output = agent ? "json" : readOutput(args);
  const command = stripKnownFlags(args);

  if (command[0] === "help" || command[0] === "--help") {
    printHelp();
    return;
  }

  if (command[0] === "serve") {
    await serve(command.slice(1));
    return;
  }

  if (command[0] === "contexts" && command[1] === "list") {
    await printContexts(output);
    return;
  }

  if (command[0] === "context" && command[1] === "create") {
    await createContext(command.slice(2), output);
    return;
  }

  if (command[0] === "context" && command[1] === "delete") {
    await deleteContext(command.slice(2), output);
    return;
  }

  if (command[0] === "context" && command[1] === "current") {
    printCurrentContext(output);
    return;
  }

  if (command[0] === "context" && command[1] === "use") {
    useContext(command[2], output);
    return;
  }

  if (command[0] === "connection" && command[1] === "status") {
    await runMcpTool("natstrail.get_connection_status", command.slice(2), output);
    return;
  }

  if (command[0] === "connection" && command[1] === "connect") {
    await connectContext(command.slice(2), output);
    return;
  }

  if (command[0] === "connection" && command[1] === "disconnect") {
    await disconnectContext(command.slice(2), output);
    return;
  }

  if (command[0] === "audit" && command[1] === "list") {
    await runMcpTool("natstrail.list_audit", command.slice(2), output);
    return;
  }

  if (command[0] === "mcp" && command[1] === "tools") {
    printMcpTools(output);
    return;
  }

  if (command[0] === "mcp" && command[1] === "describe") {
    printMcpDescribe(output);
    return;
  }

  if (command[0] === "mcp" && command[1] === "run") {
    await runMcpTool(command[2], command.slice(3), output);
    return;
  }

  if (command[0] === "filters" && command[1] === "list") {
    await runMcpTool("natstrail.list_filters", command.slice(2), output);
    return;
  }

  if (command[0] === "filter" && command[1] === "run") {
    await runMcpTool("natstrail.run_filter", command.slice(2), output);
    return;
  }

  if (command[0] === "messages" && command[1] === "search") {
    await runMcpTool("natstrail.search_messages", command.slice(2), output);
    return;
  }

  if (command[0] === "subject" && command[1] === "listen") {
    await listenSubject(command.slice(2), output);
    return;
  }

  if (command[0] === "streams" && command[1] === "list") {
    await runMcpTool("natstrail.list_streams", command.slice(2), output);
    return;
  }

  if (command[0] === "stream" && command[1] === "info") {
    await runMcpTool("natstrail.get_stream_info", command.slice(2), output);
    return;
  }

  if (command[0] === "stream" && command[1] === "tail") {
    await tailStream(command.slice(2), output);
    return;
  }

  if (command[0] === "consumers" && command[1] === "list") {
    await runMcpTool("natstrail.list_consumers", command.slice(2), output);
    return;
  }

  if (command[0] === "message" && command[1] === "detail") {
    await runMcpTool("natstrail.get_message_detail", command.slice(2), output);
    return;
  }

  if (command[0] === "trace") {
    const input = readNamedArgs(command.slice(1));
    if (input.requestId) await runMcpTool("natstrail.trace_by_request_id", command.slice(1), output);
    else if (input.correlationId) await runMcpTool("natstrail.trace_by_correlation_id", command.slice(1), output);
    else fail("Usage: nats-ui trace --requestId <id> --contextId <id> --limit <n>");
    return;
  }

  if (command[0] === "kv" && command[1] === "list") {
    await runMcpTool("natstrail.list_kv_buckets", command.slice(2), output);
    return;
  }

  if (command[0] === "kv" && command[1] === "keys") {
    await runMcpTool("natstrail.list_kv_keys", command.slice(2), output);
    return;
  }

  if (command[0] === "kv" && command[1] === "history") {
    await runMcpTool("natstrail.get_kv_history", command.slice(2), output);
    return;
  }

  if (command[0] === "obj" && command[1] === "list") {
    await runMcpTool("natstrail.list_object_buckets", command.slice(2), output);
    return;
  }

  if (command[0] === "obj" && command[1] === "objects") {
    await runMcpTool("natstrail.list_objects", command.slice(2), output);
    return;
  }

  if (command[0] === "server" && command[1] === "health") {
    await runMcpTool("natstrail.get_server_health", command.slice(2), output);
    return;
  }

  if (command[0] === "server" && command[1] === "connections") {
    await runMcpTool("natstrail.list_server_connections", command.slice(2), output);
    return;
  }

  if (command[0] === "publish") {
    await publishMessage(command.slice(1), output);
    return;
  }

  if (command[0] === "request") {
    await requestReply(command.slice(1));
    return;
  }

  if (command[0] === "stream" && (command[1] === "create" || command[1] === "update")) {
    await upsertStream(command.slice(2), output);
    return;
  }

  if (command[0] === "consumer" && (command[1] === "create" || command[1] === "update")) {
    await upsertConsumer(command.slice(2), output);
    return;
  }

  if (command[0] === "obj" && command[1] === "put") {
    await objectPut(command.slice(2), output);
    return;
  }

  if (command[0] === "obj" && command[1] === "delete") {
    await objectDelete(command.slice(2), output);
    return;
  }

  if (command[0] === "kv" && command[1] === "put") {
    await kvPut(command.slice(2), output);
    return;
  }

  if (command[0] === "kv" && (command[1] === "delete" || command[1] === "purge")) {
    await kvRemove(command[1], command.slice(2), output);
    return;
  }

  if (command[0] === "purge") {
    await purgeStream(command.slice(1), output);
    return;
  }

  if (command[0] === "delete" && command[1] === "message") {
    await deleteMessage(command.slice(2), output);
    return;
  }

  if (command[0] === "delete" && command[1] === "consumer") {
    await deleteConsumer(command.slice(2), output);
    return;
  }

  if (command[0] === "delete" && command[1] === "stream") {
    await deleteStream(command.slice(2), output);
    return;
  }

  if (command[0] === "discover") {
    await runMcpTool("natstrail.discover_subjects", command.slice(1), output);
    return;
  }

  if (command[0] === "flow") {
    await runMcpTool("natstrail.reconstruct_flow", command.slice(1), output);
    return;
  }

  if (command[0] === "health") {
    await runMcpTool("natstrail.get_health_summary", command.slice(1), output);
    return;
  }

  if (command[0] === "dlq" && command[1] === "search") {
    await runMcpTool("natstrail.search_dlq", command.slice(2), output);
    return;
  }

  if (command[0] === "sentry" && command[1] === "enrich") {
    await runMcpTool("natstrail.enrich_sentry", command.slice(2), output);
    return;
  }

  fail(`Unknown command: ${command.join(" ")}`);
}

async function startInteractive(): Promise<void> {
  interactiveMode = true;
  printBanner();
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question("trail> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      try {
        await runCommand(splitCommand(line));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    interactiveMode = false;
    rl.close();
  }
}

function splitCommand(line: string): string[] {
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
}

function readOutput(args: string[]): Output {
  const idx = args.indexOf("--output");
  if (idx === -1) return "text";
  const value = args[idx + 1];
  if (value === "json" || value === "text" || value === "ndjson") return value;
  fail("--output must be text, json or ndjson");
}

function stripOutputArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") continue;
    if (args[i] === "--output") {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function stripKnownFlags(args: string[]): string[] {
  return stripOutputArgs(args);
}

async function printContexts(output: Output): Promise<void> {
  const prefs = loadPreferences();
  const contexts = INTEGRATION_API ? await bridgeGet<Context[]>("/contexts") : loadContexts().map(sanitizeContext);
  if (output === "json") {
    printJson(createQueryEnvelope({ query: { tool: "contexts.list", currentContextId: prefs.selectedContextId }, results: contexts }));
    return;
  }
  if (output === "ndjson") {
    for (const ctx of contexts) printJsonLine({ type: "context", context: ctx, current: ctx.id === prefs.selectedContextId });
    return;
  }
  if (contexts.length === 0) {
    console.log("No contexts found. Create one in the UI or seed data/contexts.json.");
    return;
  }
  for (const ctx of contexts) {
    const marker = ctx.id === prefs.selectedContextId ? "*" : " ";
    console.log(`${marker} ${ctx.id}\t${ctx.name}\t${ctx.environment}\t${ctx.url}`);
  }
}

async function createContext(args: string[], output: Output): Promise<void> {
  const input = readNamedArgs(args);
  const ctx = contextFromInput(input);
  const errors = validateContext(ctx);
  if (errors.length) {
    printJson(createQueryEnvelope({ query: { tool: "context.create" }, results: [], errors }));
    return;
  }
  const saved = INTEGRATION_API ? await bridgePost<Context>("/contexts", ctx) : saveLocalContext(ctx);
  if (output === "json" || output === "ndjson") printJson(createQueryEnvelope({ query: { tool: "context.create" }, results: [sanitizeContext(saved)] }));
  else console.log(`Created context ${saved.id}`);
}

async function deleteContext(args: string[], output: Output): Promise<void> {
  const input = readNamedArgs(args);
  const id = stringValue(input.contextId ?? input.id);
  if (!id) fail("Usage: nats-ui context delete --context-id <id>");
  if (INTEGRATION_API) await bridgeDelete(`/contexts/${encodeURIComponent(id)}`);
  else saveContexts(loadContexts().filter((ctx) => ctx.id !== id));
  if (output === "json" || output === "ndjson") printJson(createQueryEnvelope({ query: { tool: "context.delete", contextId: id }, results: [{ ok: true }] }));
  else console.log(`Deleted context ${id}`);
}

async function connectContext(args: string[], output: Output): Promise<void> {
  if (!INTEGRATION_API) return printCliError(output, "connection.connect", "connection connect requires NATS_TRAIL_API=http://localhost:4000");
  const input = readNamedArgs(args);
  const contextId = stringValue(input.contextId ?? input.id) ?? await detectContextId();
  if (!contextId) fail("Usage: nats-ui connection connect --context-id <id>");
  const state = await bridgePost<ConnectionState>("/connect", { contextId });
  if (output === "json" || output === "ndjson") printJson(createQueryEnvelope({ query: { tool: "connection.connect", contextId }, results: [state], limit: 1 }));
  else console.log(`${state.status}\t${state.contextId ?? "-"}\t${state.url ?? "-"}`);
}

async function disconnectContext(args: string[], output: Output): Promise<void> {
  if (!INTEGRATION_API) return printCliError(output, "connection.disconnect", "connection disconnect requires NATS_TRAIL_API=http://localhost:4000");
  const input = readNamedArgs(args);
  const contextId = stringValue(input.contextId ?? input.id);
  const state = await bridgePost<ConnectionState>("/disconnect", contextId ? { contextId } : {});
  if (output === "json" || output === "ndjson") printJson(createQueryEnvelope({ query: { tool: "connection.disconnect", contextId }, results: [state], limit: 1 }));
  else console.log(state.status);
}

function printCurrentContext(output: Output): void {
  const prefs = loadPreferences();
  const ctx = loadContexts().find((item) => item.id === prefs.selectedContextId) ?? null;
  const safe = ctx ? sanitizeContext(ctx) : null;
  if (output === "json") {
    printJson(createQueryEnvelope({ query: { tool: "context.current" }, results: safe ? [safe] : [] }));
    return;
  }
  if (output === "ndjson") {
    printJsonLine({ type: "current_context", context: safe });
    return;
  }
  if (!safe) {
    console.log("No current context selected.");
    return;
  }
  console.log(`${safe.id}\t${safe.name}\t${safe.environment}\t${safe.url}`);
}

function useContext(target: string | undefined, output: Output): void {
  if (!target) fail("Usage: nats-ui context use <id-or-name>");
  const contexts = loadContexts();
  const ctx = contexts.find((item) => item.id === target || item.name === target);
  if (!ctx) fail(`Context not found: ${target}`);
  const prefs = loadPreferences();
  savePreferences({ ...prefs, selectedContextId: ctx.id });
  const safe = sanitizeContext(ctx);
  if (output === "json") {
    printJson(createQueryEnvelope({ query: { tool: "context.use", context: safe.id }, results: [safe] }));
    return;
  }
  if (output === "ndjson") {
    printJsonLine({ type: "context_selected", context: safe });
    return;
  }
  console.log(`Using context ${safe.id}`);
}

function printMcpTools(output: Output): void {
  if (output === "json") {
    printJson(createQueryEnvelope({ query: { tool: "mcp.tools" }, results: mcpTools }));
    return;
  }
  if (output === "ndjson") {
    for (const tool of mcpTools) printJsonLine({ type: "mcp_tool", tool });
    return;
  }
  for (const tool of mcpTools) console.log(`${tool.name}\t${tool.description}`);
}

function printMcpDescribe(output: Output): void {
  const description = {
    name: "nats-trail",
    purpose: "Fast, bounded and sanitized NATS/JetStream inspection for humans, scripts and agents.",
    responseModel: {
      json: "Best for MCP tool calls and single bounded queries.",
      ndjson: "Best for streaming messages, large result sets and incremental agent parsing.",
      text: "Human terminal output only.",
    },
    safety: ["read-only commands", "sanitized contexts", "bounded results", "normalized errors"],
  };
  if (output === "json") {
    printJson(createQueryEnvelope({ query: { tool: "mcp.describe" }, results: [description] }));
    return;
  }
  if (output === "ndjson") {
    printJsonLine({ type: "mcp_description", description });
    return;
  }
  console.log(description.purpose);
}

async function runMcpTool(name: string | undefined, args: string[], output: Output): Promise<void> {
  if (!name) fail("Usage: nats-ui mcp run <tool-name> [--limit <n>]");
  const input = readNamedArgs(args);
  if (input.limit == null) input.limit = DEFAULT_LIMIT;
  if (LIVE_TOOLS.has(name) && !input.contextId) input.contextId = await detectContextId();
  if (INTEGRATION_API && LIVE_TOOLS.has(name) && input.noAutoConnect !== true) {
    await ensureBridgeConnected(stringValue(input.contextId));
  }
  delete input.noAutoConnect;
  const envelope = INTEGRATION_API
    ? await callIntegrationTool(INTEGRATION_API, name, input, "cli")
    : await executeMcpTool(name, input, { contexts: loadContexts(), filters: loadFilters(), auditEntries: [], connectionState: localConnectionState() });
  if (output === "ndjson") {
    for (const result of envelope.results) printJsonLine({ type: "mcp_result", result });
    return;
  }
  printJson(envelope);
}

async function listenSubject(args: string[], output: Output): Promise<void> {
  const input = readNamedArgs(args);
  const subject = stringValue(input.subject);
  if (!subject) return printCliError(output, "subject.listen", "subject listen requires --subject");
  try {
    await ensureLiveBridge(input);
    await collectWsMessages({ action: "subscribe", subject, contextId: input.contextId }, "message", input, output, "subject.listen");
  } catch (err) {
    printCliError(output, "subject.listen", err instanceof Error ? err.message : String(err));
  }
}

async function tailStream(args: string[], output: Output): Promise<void> {
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  if (!stream) return printCliError(output, "stream.tail", "stream tail requires --stream");
  try {
    await ensureLiveBridge(input);
    const filterSubjects = stringValue(input.subject) ? [stringValue(input.subject)] : [];
    await collectWsMessages({ action: "js_subscribe", stream, filterSubjects, contextId: input.contextId }, "js_message", input, output, "stream.tail");
  } catch (err) {
    printCliError(output, "stream.tail", err instanceof Error ? err.message : String(err));
  }
}

async function ensureLiveBridge(input: Record<string, unknown>): Promise<void> {
  if (!INTEGRATION_API) throw new Error("live CLI commands require NATS_TRAIL_API=http://localhost:4000");
  if (!input.contextId) input.contextId = await detectContextId();
  if (input.noAutoConnect !== true) await ensureBridgeConnected(stringValue(input.contextId));
}

async function collectWsMessages(subscribe: Record<string, unknown>, messageType: string, input: Record<string, unknown>, output: Output, tool: string): Promise<void> {
  if (!INTEGRATION_API) fail("NATS_TRAIL_API is required for live commands");
  const limit = numberValue(input.limit) ?? 50;
  const timeoutMs = numberValue(input.timeoutMs) ?? 30000;
  const results: unknown[] = [];
  const ws = new WebSocket(toWsUrl(INTEGRATION_API));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify(subscribe)));
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as { type?: string; message?: unknown; error?: unknown };
      if (event.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(JSON.stringify(event.error)));
        return;
      }
      if (event.type !== messageType) return;
      results.push(event.message);
      if (output === "ndjson") printJsonLine({ type: messageType, message: event.message });
      else if (output === "text") printLiveMessage(event.message);
      if (results.length >= limit) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (output === "json") {
    printJson(createQueryEnvelope({ query: { tool, limit, timeoutMs }, results, limit }));
  }
}

function readNamedArgs(args: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const value = args[i + 1];
    const inputKey = toCamelCase(key.slice(2));
    if (BOOLEAN_FLAGS.has(inputKey)) {
      input[inputKey] = true;
      continue;
    }
    if (!value || value.startsWith("--")) fail(`Missing value for ${key}`);
    input[inputKey] = NUMERIC_FLAGS.has(inputKey) ? Number(value) : value;
    i += 1;
  }
  return input;
}

async function detectContextId(): Promise<string | undefined> {
  if (INTEGRATION_API) {
    const prefs = await bridgeGet<Partial<Preferences>>("/preferences").catch((): Partial<Preferences> => ({}));
    if (prefs.selectedContextId) return prefs.selectedContextId;
    const contexts = await bridgeGet<Context[]>("/contexts").catch(() => []);
    if (contexts.length === 1) return contexts[0].id;
    return undefined;
  }
  const selectedContextId = loadPreferences().selectedContextId;
  if (selectedContextId) return selectedContextId;
  const contexts = loadContexts();
  return contexts.length === 1 ? contexts[0].id : undefined;
}

async function ensureBridgeConnected(contextId: string | undefined): Promise<void> {
  if (!contextId) return;
  const state = await bridgeGet<ConnectionState>("/connection").catch(() => null);
  if (state?.status === "connected" && state.contextId === contextId) return;
  await bridgePost<ConnectionState>("/connect", { contextId });
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function loadContexts(): Context[] {
  return readJson<Context[]>(CONTEXTS_FILE, []);
}

function saveContexts(contexts: Context[]): void {
  writeJson(CONTEXTS_FILE, contexts);
}

function loadFilters(): Filter[] {
  return readJson<Filter[]>(FILTERS_FILE, []);
}

function loadPreferences(): Preferences {
  return { ...DEFAULT_PREFS, ...readJson<Partial<Preferences>>(PREFS_FILE, {}) };
}

function localConnectionState(): ConnectionState {
  return { status: "disconnected", contextId: loadPreferences().selectedContextId, url: null, error: null, reconnects: 0 };
}

function savePreferences(prefs: Preferences): void {
  writeJson(PREFS_FILE, prefs);
}

function saveLocalContext(ctx: Context): Context {
  saveContexts(loadContexts().filter((item) => item.id !== ctx.id).concat(ctx));
  return ctx;
}

function contextFromInput(input: Record<string, unknown>): Context {
  const name = stringValue(input.name) ?? "context";
  const id = stringValue(input.id) ?? slug(name);
  const authType = (stringValue(input.authType) ?? "none") as AuthType;
  return {
    id,
    name,
    environment: (stringValue(input.environment) ?? "custom") as Environment,
    url: stringValue(input.url) ?? "",
    auth: {
      type: authType,
      username: stringValue(input.username),
      password: stringValue(input.password),
      token: stringValue(input.token),
      credsPath: stringValue(input.credsPath),
    },
    tls: {
      enabled: input.tls === true || input.tls === "true",
      serverName: stringValue(input.serverName),
      caPath: stringValue(input.caPath),
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "context";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toWsUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  if (API_TOKEN) url.searchParams.set("token", API_TOKEN);
  return url.toString();
}

function printLiveMessage(value: unknown): void {
  const msg = value as { subject?: string; timestamp?: number; data?: string; seq?: number };
  const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
  const seq = msg.seq != null ? ` #${msg.seq}` : "";
  console.log(`${ts}${seq}\t${msg.subject ?? "-"}\t${msg.data ?? ""}`);
}

async function bridgeGet<T>(path: string): Promise<T> {
  return bridgeRequest<T>(path, { method: "GET" });
}

async function bridgePost<T>(path: string, body: unknown): Promise<T> {
  return bridgeRequest<T>(path, { method: "POST", body: JSON.stringify(body) });
}

async function bridgeDelete(path: string): Promise<void> {
  await bridgeRequest(path, { method: "DELETE" });
}

async function bridgeRequest<T = unknown>(path: string, init: RequestInit): Promise<T> {
  if (!INTEGRATION_API) fail("NATS_TRAIL_API is required for bridge requests");
  const res = await fetch(`${INTEGRATION_API.replace(/\/+$/, "")}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

function writeJson(file: string, value: unknown): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printJsonLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printCliError(output: Output, tool: string, message: string): void {
  if (output === "json" || output === "ndjson") {
    printJson(createQueryEnvelope({
      query: { tool },
      results: [],
      errors: [{ code: "cli.bridge_required", message, retriable: false }],
    }));
    return;
  }
  fail(message);
}

/**
 * Start the bridge (and the built UI when present) in this process. Imported
 * lazily so the query commands do not pay for express and the NATS client.
 */
async function serve(args: string[]): Promise<void> {
  const input = readNamedArgs(args);
  const { startServer } = await import("@nats-trail/server");
  const { url, hasUi } = await startServer({
    port: numberValue(input.port),
    host: stringValue(input.host),
  });
  console.log(`[nats-trail] ${hasUi ? "UI + API" : "API bridge"} listening on ${url}`);
  if (!hasUi) console.log("[nats-trail] UI bundle not found; API only.");
}

// ---- Mutations -------------------------------------------------------------
//
// Write commands always go through the bridge, never through the MCP runtime.
// They refuse to run under --agent: an agent invoking the CLI must not be able
// to reach a mutation just because a human could.

/** Reject a mutation attempted from an agent-shaped invocation. */
function requireHumanInvocation(action: string): void {
  if (agentMode) {
    fail(`${action} is not available in --agent mode: mutations are for humans and scripts, not agents`);
  }
}

/** Destructive commands require --yes, so a typo cannot purge a stream. */
function requireConfirmation(action: string, target: string, input: Record<string, unknown>): void {
  if (input.yes !== true) {
    fail(`${action} on ${target} is destructive. Re-run with --yes to confirm.`);
  }
}

async function publishMessage(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("publish");
  const input = readNamedArgs(args);
  const subject = stringValue(input.subject);
  if (!subject) fail("Usage: nats-trail publish --subject <subject> --payload <json-or-text>");
  const result = await bridgePost<{ ok: boolean }>("/mutate/publish", {
    subject,
    payload: stringValue(input.payload) ?? "",
  });
  if (output === "json" || output === "ndjson") printJson(result);
  else console.log(`published to ${subject}`);
}

async function requestReply(args: string[]): Promise<void> {
  requireHumanInvocation("request");
  const input = readNamedArgs(args);
  const subject = stringValue(input.subject);
  if (!subject) fail("Usage: nats-trail request --subject <subject> --payload <json-or-text> [--timeout-ms 5000]");
  const reply = await bridgePost<Record<string, unknown>>("/mutate/request", {
    subject,
    payload: stringValue(input.payload) ?? "",
    timeoutMs: numberValue(input.timeoutMs),
  });
  printJson(reply);
}

/** Split a repeatable comma-separated flag into trimmed values. */
function listValue(value: unknown): string[] | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

async function upsertStream(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("stream create");
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  const subjects = listValue(input.subjects);
  if (!stream || !subjects?.length) {
    fail("Usage: nats-trail stream create --stream <name> --subjects 'a.>,b.*' [--retention limits|interest|workqueue] [--storage file|memory] [--replicas n] [--max-age ms] [--max-messages n] [--max-bytes n]");
  }
  const result = await bridgeRequest<{ name: string; subjects: string[] }>(
    `/mutate/streams/${encodeURIComponent(stream)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        subjects,
        retention: stringValue(input.retention),
        storage: stringValue(input.storage),
        replicas: numberValue(input.replicas),
        maxAge: numberValue(input.maxAge),
        maxMessages: numberValue(input.maxMessages),
        maxBytes: numberValue(input.maxBytes),
        discard: stringValue(input.discard),
        description: stringValue(input.description),
      }),
    },
  );
  if (output === "json" || output === "ndjson") printJson(result);
  else console.log(`${result.name} now carries ${result.subjects.join(", ")}`);
}

async function upsertConsumer(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("consumer create");
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  const consumer = stringValue(input.consumer);
  if (!stream || !consumer) {
    fail("Usage: nats-trail consumer create --stream <name> --consumer <name> [--filter-subjects 'a.>'] [--ack-policy explicit|all|none] [--deliver-policy all|last|new] [--ack-wait ms] [--max-deliver n]");
  }
  const result = await bridgeRequest<{ name: string; pending: number }>(
    `/mutate/streams/${encodeURIComponent(stream)}/consumers/${encodeURIComponent(consumer)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        filterSubjects: listValue(input.filterSubjects),
        ackPolicy: stringValue(input.ackPolicy),
        deliverPolicy: stringValue(input.deliverPolicy),
        startSeq: numberValue(input.startSeq),
        ackWait: numberValue(input.ackWait),
        maxDeliver: numberValue(input.maxDeliver),
        description: stringValue(input.description),
      }),
    },
  );
  if (output === "json" || output === "ndjson") printJson(result);
  else console.log(`${stream}/${result.name} ready, ${result.pending} pending`);
}

async function objectPut(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("obj put");
  const input = readNamedArgs(args);
  const bucket = stringValue(input.bucket);
  const name = stringValue(input.name);
  const value = stringValue(input.value);
  if (!bucket || !name || value === undefined) {
    fail("Usage: nats-trail obj put --bucket <name> --name <object> --value <text> [--description <text>]");
  }
  const result = await bridgeRequest<{ name: string; size: number }>(
    `/mutate/obj/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(name)}`,
    { method: "PUT", body: JSON.stringify({ value, description: stringValue(input.description) }) },
  );
  if (output === "json" || output === "ndjson") printJson(result);
  else console.log(`stored ${bucket}/${result.name} (${result.size} bytes)`);
}

async function objectDelete(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("obj delete");
  const input = readNamedArgs(args);
  const bucket = stringValue(input.bucket);
  const name = stringValue(input.name);
  if (!bucket || !name) fail("Usage: nats-trail obj delete --bucket <name> --name <object> --yes");
  requireConfirmation("obj delete", `${bucket}/${name}`, input);
  await bridgeRequest(
    `/mutate/obj/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (output === "text") console.log(`deleted ${bucket}/${name}`);
}

async function kvPut(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("kv put");
  const input = readNamedArgs(args);
  const bucket = stringValue(input.bucket);
  const key = stringValue(input.key);
  const value = stringValue(input.value);
  if (!bucket || !key || value === undefined) {
    fail("Usage: nats-trail kv put --bucket <name> --key <key> --value <json-or-text> [--expected-revision <n>]");
  }
  const result = await bridgeRequest<{ revision: number }>(
    `/mutate/kv/${encodeURIComponent(bucket)}/keys/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify({ value, expectedRevision: numberValue(input.expectedRevision) }) },
  );
  if (output === "json" || output === "ndjson") printJson(result);
  else console.log(`${bucket}/${key} is now revision ${result.revision}`);
}

async function kvRemove(mode: "delete" | "purge", args: string[], output: Output): Promise<void> {
  requireHumanInvocation(`kv ${mode}`);
  const input = readNamedArgs(args);
  const bucket = stringValue(input.bucket);
  const key = stringValue(input.key);
  if (!bucket || !key) fail(`Usage: nats-trail kv ${mode} --bucket <name> --key <key> --yes`);
  requireConfirmation(`kv ${mode}`, `${bucket}/${key}`, input);
  await bridgeRequest(
    `/mutate/kv/${encodeURIComponent(bucket)}/keys/${encodeURIComponent(key)}?purge=${mode === "purge"}`,
    { method: "DELETE" },
  );
  if (output === "text") console.log(`${mode}d ${bucket}/${key}`);
}

async function purgeStream(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("purge");
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  if (!stream) fail("Usage: nats-trail purge --stream <name> [--subject <filter>] [--keep <n>] --yes");
  requireConfirmation("purge", stream, input);
  const result = await bridgePost<{ purged: number }>(`/mutate/streams/${encodeURIComponent(stream)}/purge`, {
    subject: stringValue(input.subject),
    keep: numberValue(input.keep),
  });
  if (output === "json" || output === "ndjson") printJson(result);
  else console.log(`purged ${result.purged} messages from ${stream}`);
}

async function deleteMessage(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("delete message");
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  const seq = numberValue(input.seq);
  if (!stream || !seq) fail("Usage: nats-trail delete message --stream <name> --seq <n> --yes");
  requireConfirmation("delete message", `${stream}#${seq}`, input);
  await bridgeDelete(`/mutate/streams/${encodeURIComponent(stream)}/messages/${seq}`);
  if (output === "text") console.log(`deleted ${stream}#${seq}`);
}

async function deleteConsumer(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("delete consumer");
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  const consumer = stringValue(input.consumer);
  if (!stream || !consumer) fail("Usage: nats-trail delete consumer --stream <name> --consumer <name> --yes");
  requireConfirmation("delete consumer", `${stream}/${consumer}`, input);
  await bridgeDelete(`/mutate/streams/${encodeURIComponent(stream)}/consumers/${encodeURIComponent(consumer)}`);
  if (output === "text") console.log(`deleted consumer ${stream}/${consumer}`);
}

async function deleteStream(args: string[], output: Output): Promise<void> {
  requireHumanInvocation("delete stream");
  const input = readNamedArgs(args);
  const stream = stringValue(input.stream);
  if (!stream) fail("Usage: nats-trail delete stream --stream <name> --confirm <name> --yes");
  requireConfirmation("delete stream", stream, input);
  if (stringValue(input.confirm) !== stream) {
    fail(`--confirm must equal the stream name to delete it: "${stream}"`);
  }
  await bridgeRequest(`/mutate/streams/${encodeURIComponent(stream)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: stream }),
  });
  if (output === "text") console.log(`deleted stream ${stream}`);
}

function printHelp(): void {
  console.log(`nats-trail <command>

Run without arguments to open the interactive shell. Type exit or quit to leave.

Commands:
  serve                      Start the API bridge and the web UI
  contexts list              List UI-configured contexts
  context current            Show selected context
  context use <id-or-name>   Select a context for CLI usage
  context create             Create a context locally or through the bridge
  context delete             Delete a context locally or through the bridge
  connection status          Show bridge/local connection state
  connection connect         Connect the bridge to a context
  connection disconnect      Disconnect the bridge
  audit list                 List recent audit entries
  mcp tools                  List read-only MCP-friendly commands
  mcp describe               Describe agent response formats and safety
  mcp run <tool-name>        Run an MCP tool contract locally (--limit defaults to 50)
  filters list               List saved filters
  filter run                 Run a saved filter by --filter
  streams list               List JetStream streams
  stream info                Get one stream summary
  stream tail                Replay/tail JetStream messages over WebSocket
  consumers list             List stream consumers
  subject listen             Listen to a NATS Core subject over WebSocket
  messages search            Search JetStream messages through the Query Engine
  message detail             Get one stream message by --stream and --seq
  trace                      Trace by --requestId or --correlationId
  kv list                    List Key/Value buckets
  kv keys                    List keys and values in a bucket (--bucket)
  kv history                 Revision history for one key (--bucket --key)
  obj list                   List Object Store buckets
  obj objects                List objects in a bucket (--bucket)
  discover                   Discover subjects and infer payload shapes
  flow                       Reconstruct a flow by --request-id or --correlation-id
  health                     What looks broken right now, ranked
  server health              Server version, uptime, traffic and JetStream totals
  server connections         List client connections
  dlq search                 Search dead-letter messages
  sentry enrich              Collect trace and DLQ context for Sentry

Write commands (human and scripts only, never --agent):
  publish                    Publish to a subject (--subject --payload)
  request                    Request/reply on a subject (--subject --payload)
  stream create              Create or update a stream (--stream --subjects)
  consumer create            Create or update a consumer (--stream --consumer)
  obj put                    Store an object from text (--bucket --name --value)
  obj delete                 Delete an object (--bucket --name) --yes
  kv put                     Set a key (--bucket --key --value [--expected-revision])
  kv delete                  Delete a key, keeping its history (--bucket --key) --yes
  kv purge                   Purge a key and its history (--bucket --key) --yes
  purge                      Purge a stream (--stream [--subject] [--keep]) --yes
  delete message             Delete one message (--stream --seq) --yes
  delete consumer            Delete a consumer (--stream --consumer) --yes
  delete stream              Delete a stream (--stream --confirm <name>) --yes

Options:
  --yes                       Confirm a destructive write
  --port <n> / --host <addr>  Bind options for serve (default: 127.0.0.1:4000)
  --limit <n>                 Max results per query (default: 50, max 200)
  --output text|json|ndjson   Output format (default: text)
  --agent                     Force JSON envelopes for agent-safe usage
  --from-ts / --to-ts <ms>    Bound stream queries to a time window (epoch ms)
  --cursor <seq>              Resume a truncated stream query from nextCursor
  --max-scan <n>              Max messages scanned per query (default 10000)

Environment:
  NATS_TRAIL_API              Bridge URL for live commands and forwarding
  NATS_TRAIL_TOKEN            Bearer token when the bridge has auth enabled`);
}

function printBanner(): void {
  console.log(String.raw`
 _  _   _   _____ ___   _____ ___    _   ___ _
| \| | /_\ |_   _/ __| |_   _| _ \  /_\ |_ _| |
| .  |/ _ \  | | \__ \   | | |   / / _ \ | || |__
|_|\_/_/ \_\ |_| |___/   |_| |_|_\/_/ \_\___|____|

  .--.        .--.        .--.
 (    )--.--(    )--.--(    )     NATS-TRAIL CLI
  '--'        '--'        '--'      type help for commands
`);
}

function fail(message: string): never {
  if (interactiveMode) throw new Error(message);
  console.error(message);
  process.exit(1);
}
