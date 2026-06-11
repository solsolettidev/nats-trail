import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createQueryEnvelope, sanitizeContext, validateContext, type AuthType, type ConnectionState, type Context, type Environment, type Filter } from "@nats-trail/core";
import { callIntegrationTool, executeMcpTool, mcpTools } from "@nats-trail/mcp";

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
const CONTEXTS_FILE = join(DATA_DIR, "contexts.json");
const PREFS_FILE = join(DATA_DIR, "preferences.json");
const FILTERS_FILE = join(DATA_DIR, "filters.json");
let interactiveMode = false;

const DEFAULT_PREFS: Preferences = {
  selectedContextId: null,
  lastSubject: null,
  recentSubjects: [],
  favoriteSubjects: [],
  recentStreams: [],
  dlqSubjects: [],
  messageViewerMode: "tree",
};

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
  const output = agent ? "json" : readOutput(args);
  const command = stripKnownFlags(args);

  if (command[0] === "help" || command[0] === "--help") {
    printHelp();
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
    await disconnectContext(output);
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

  if (command[0] === "streams" && command[1] === "list") {
    await runMcpTool("natstrail.list_streams", command.slice(2), output);
    return;
  }

  if (command[0] === "stream" && command[1] === "info") {
    await runMcpTool("natstrail.get_stream_info", command.slice(2), output);
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

async function disconnectContext(output: Output): Promise<void> {
  if (!INTEGRATION_API) return printCliError(output, "connection.disconnect", "connection disconnect requires NATS_TRAIL_API=http://localhost:4000");
  const state = await bridgePost<ConnectionState>("/disconnect", {});
  if (output === "json" || output === "ndjson") printJson(createQueryEnvelope({ query: { tool: "connection.disconnect" }, results: [state], limit: 1 }));
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
  if (!name) fail("Usage: nats-ui mcp run <tool-name> --limit <n>");
  const input = readNamedArgs(args);
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

function readNamedArgs(args: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const value = args[i + 1];
    const inputKey = toCamelCase(key.slice(2));
    if (key === "--no-auto-connect") {
      input[inputKey] = true;
      continue;
    }
    if (!value || value.startsWith("--")) fail(`Missing value for ${key}`);
    input[inputKey] = inputKey === "limit" || inputKey === "seq" ? Number(value) : value;
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
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
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

function printHelp(): void {
  console.log(`nats-ui <command>

Run without arguments to open the interactive shell. Type exit or quit to leave.

Commands:
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
  mcp run <tool-name>        Run an MCP tool contract locally
  filters list               List saved filters
  filter run                 Run a saved filter by --filter
  streams list               List JetStream streams
  stream info                Get one stream summary
  consumers list             List stream consumers
  messages search            Search JetStream messages through the Query Engine
  message detail             Get one stream message by --stream and --seq
  trace                      Trace by --requestId or --correlationId
  dlq search                 Search dead-letter messages
  sentry enrich              Collect trace and DLQ context for Sentry

Options:
  --output text|json|ndjson   Output format (default: text)
  --agent                     Force JSON envelopes for agent-safe usage`);
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
