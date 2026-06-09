import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createQueryEnvelope, sanitizeContext, type Context, type Filter } from "@nats-trail/core";
import { executeMcpTool, mcpTools } from "@nats-trail/mcp";

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
const CONTEXTS_FILE = join(DATA_DIR, "contexts.json");
const PREFS_FILE = join(DATA_DIR, "preferences.json");
const FILTERS_FILE = join(DATA_DIR, "filters.json");

const DEFAULT_PREFS: Preferences = {
  selectedContextId: null,
  lastSubject: null,
  recentSubjects: [],
  favoriteSubjects: [],
  recentStreams: [],
  dlqSubjects: [],
  messageViewerMode: "tree",
};

main(process.argv.slice(2)).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

async function main(args: string[]): Promise<void> {
  const agent = args.includes("--agent");
  const output = agent ? "json" : readOutput(args);
  const command = stripKnownFlags(args);

  if (command.length === 0 || command[0] === "help" || command[0] === "--help") {
    printHelp();
    return;
  }

  if (command[0] === "contexts" && command[1] === "list") {
    printContexts(output);
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

  fail(`Unknown command: ${command.join(" ")}`);
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

function printContexts(output: Output): void {
  const prefs = loadPreferences();
  const contexts = loadContexts().map(sanitizeContext);
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
  const envelope = await executeMcpTool(name, input, { contexts: loadContexts(), filters: loadFilters() });
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
    if (!value || value.startsWith("--")) fail(`Missing value for ${key}`);
    input[key.slice(2)] = key === "--limit" || key === "--seq" ? Number(value) : value;
    i += 1;
  }
  return input;
}

function loadContexts(): Context[] {
  return readJson<Context[]>(CONTEXTS_FILE, []);
}

function loadFilters(): Filter[] {
  return readJson<Filter[]>(FILTERS_FILE, []);
}

function loadPreferences(): Preferences {
  return { ...DEFAULT_PREFS, ...readJson<Partial<Preferences>>(PREFS_FILE, {}) };
}

function savePreferences(prefs: Preferences): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), "utf8");
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

function printHelp(): void {
  console.log(`nats-ui <command>

Commands:
  contexts list              List UI-configured contexts
  context current            Show selected context
  context use <id-or-name>   Select a context for CLI usage
  mcp tools                  List read-only MCP-friendly commands
  mcp describe               Describe agent response formats and safety
  mcp run <tool-name>        Run an MCP tool contract locally

Options:
  --output text|json|ndjson   Output format (default: text)
  --agent                     Force JSON envelopes for agent-safe usage`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
