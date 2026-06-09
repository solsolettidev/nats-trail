# Architecture

NATS Trail is designed as a **product with multiple interfaces over a single core**, not as a
standalone UI:

```
1. UI for humans          (v1 complete)
2. CLI for humans/fallback (v2 started, see nats-ui-v2.md)
3. MCP / agent tools      (v2 started)
4. Integration API        (planned)
```

The guiding rule:

```
UI, CLI, MCP and Integration API are interfaces over the same core.
```

Not: each interface owning its own duplicated logic.

## Layers

```
UI  ->  API bridge  ->  Core  ->  NATS / JetStream
```

### UI (`packages/ui`)

React + Vite single-page app. Responsible **only** for presentation, user interaction and
visual debugging. It does **not** own:

- NATS connection logic
- JetStream logic
- message parsing rules
- filtering rules
- trace reconstruction

It talks to the API bridge over HTTP (state, lists) and WebSocket (live messages).

### API bridge (`packages/server`)

Express + `ws`. Responsibilities:

- expose HTTP and WebSocket endpoints for the UI
- manage NATS/JetStream connection state per process
- normalize errors into a stable shape (`core.normalizeError`)
- enforce limits (max results, max buffered messages)
- protect credentials (they never leave the server in API responses)
- prepare the product for future CLI and MCP usage (same core calls)

### Core (`packages/core`)

Pure, dependency-light TypeScript. **The most important architectural decision:** anything
that the UI, CLI or MCP will eventually need lives here, not in UI components.

Core owns the concepts:

```
Context, Connection, Subject, Subscription, Message,
Stream, Consumer, Filter, Trace, DLQEvent
```

Core owns the logic:

```
message parsing            payload formatting
context validation         filter building
request_id / correlation_id tracing
error normalization        result limiting
agent-safe output shaping
```

Core has **no** dependency on Express, React or the NATS client. The server adapts the NATS
client's raw data into core types; core decides how to parse, format and filter it.

### Query Engine (`packages/core/src/query.ts`)

The v2 center is the Query Engine contract, not CLI command execution. It defines stable
agent-friendly envelopes, result limits and truncation helpers that every interface must share.

Agent-facing responses use:

```
query, summary, results, nextCursor, warnings, errors
```

### CLI (`packages/cli`)

Node + TypeScript command-line interface. The first v2 slice reuses UI-created local contexts
and shared preferences without opening a NATS connection directly. It is a human terminal
interface and fallback for automation. `--agent` forces valid JSON envelopes and must keep results
bounded and sanitized.

### MCP (`packages/mcp`)

Explicit read-only tool contracts for agents. Tools are named `natstrail.*`, have strict input
schemas, stable output envelopes, mandatory limits, timeouts and no destructive actions.
The runtime accepts storage/connection data through adapters so MCP, CLI and HTTP can share the
same Query Engine behavior.
JetStream tools use the API bridge connection adapter and require the requested context to be the
active connected context.
Message query tools read bounded stream ranges and shape results as compact `AgentMessage` records
instead of exposing raw NATS client objects.

### Integration API (`packages/server`, planned)

Read-only HTTP API over the same Query Engine for Sentry enrichment, dashboards and external
systems. Sentry should not consume NATS directly; NATS Trail should enrich errors with relevant
message context, breadcrumbs and trace-related events.

Current initial endpoints expose tool discovery and execution:

```
GET  /api/integration/tools
POST /api/integration/tools/:name
```

### NATS Core vs JetStream

These are separated internally in the server:

- **NATS Core**: connection state, subjects, subscriptions, live messages.
- **JetStream**: streams, consumers, durables, persisted messages, DLQ-oriented inspection.

### Storage

Local product state only — never business secrets beyond what a context needs to connect:

```
contexts, saved filters, recent messages, preferences, basic audit logs
```

For v0 this is a JSON file under `data/` (git-ignored). If richer local persistence is needed
later, the preferred choice is SQLite — the storage module is isolated so it can be swapped
without touching core or the API surface.

## Data flow examples

**Live subscription**

```
UI  --WS subscribe(subject)-->  bridge  --sub-->  NATS
NATS --msg--> bridge --core.parseMessage--> bridge --WS message--> UI
```

**List streams**

```
UI --GET /api/streams--> bridge --JSM.streams.list--> JetStream
bridge --map to core.Stream--> UI
```
