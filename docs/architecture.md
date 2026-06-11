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
- manage a **connection pool keyed by contextId** — each context owns an independent
  NATS connection, so an agent querying `local` never disconnects the UI from `prod`
- normalize errors into a stable shape (`core.normalizeError`)
- enforce limits (max results, max buffered messages)
- protect credentials (they never leave the server in API responses)
- enforce **bearer-token auth** on the Integration API and the WebSocket endpoint
  when tokens are configured
- prepare the product for future CLI and MCP usage (same core calls)

The UI keeps a single *selected* context (shared preferences). `POST /api/connect`
only moves the selection when the caller sends `select: true` (the UI does); CLI and
agent auto-connects join the pool without stealing the selection. `GET /api/connection`
returns the selected context's state, `GET /api/connections` returns every pooled state,
and `POST /api/disconnect` accepts an optional `contextId`. JetStream endpoints and the
WebSocket `subscribe` / `js_subscribe` actions accept an optional `contextId` and default
to the selected context.

### Bridge auth

Tokens come from `NATS_TRAIL_TOKENS` (comma-separated `name:token` pairs) or
`data/tokens.json` (`[{ "name": "ci-agent", "token": "..." }]`, git-ignored). With no
token configured, auth is disabled for local development. With at least one token:

- `/api/integration/*` requires `Authorization: Bearer <token>` (or `?token=`).
- `/ws` requires the token via `Authorization` header or `?token=` query parameter.
- Audit entries record the matched token name as `identity`, which is the
  authenticated caller identity — the self-reported `x-nats-trail-origin` header is
  kept only as a transport hint.

Token comparison is constant-time. Clients (CLI, stdio MCP server) send the token from
the `NATS_TRAIL_TOKEN` environment variable.

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

Stream reads go through a single bounded contract (`StreamQuery` -> `StreamQueryPage`):

- The server scans streams with a **temporary ephemeral consumer** (ack-none, server-side
  `filter_subject`), fetching messages in batches instead of one round trip per sequence, so
  queries work on large streams.
- Every query is bounded by a **scan budget** (`maxScan`, default 10000, max 100000 examined
  messages) and an optional **time window** (`fromTs`/`toTs`, applied server-side via start time
  and chronological cut-off).
- When a scan stops early (limit or budget reached) the envelope returns a real `nextCursor`
  (the next stream sequence) so callers and agents can resume exactly where they stopped.
- With no explicit window or cursor, queries default to the most recent `maxScan` sequences and
  emit a `query.window_default` warning, so results are never silently partial.
- Trace tools page through each stream's window in `SCAN_PAGE_SIZE` chunks until the budget or
  result limit is reached, instead of sampling only the newest messages.

### CLI (`packages/cli`)

Node + TypeScript command-line interface. The first v2 slice reuses UI-created local contexts
and shared preferences without opening a NATS connection directly. It is a human terminal
interface and fallback for automation. `--agent` forces valid JSON envelopes and must keep results
bounded and sanitized.

### MCP (`packages/mcp`)

Explicit read-only tool contracts for agents. Tools are named `natstrail.*`, have strict input
schemas, stable output envelopes, mandatory limits, timeouts and no destructive actions.
Runtime validation rejects unknown tools, missing required fields, invalid field types, invalid
numeric ranges and extra properties before any NATS/JetStream adapter is called.
The runtime accepts storage/connection data through adapters so MCP, CLI and HTTP can share the
same Query Engine behavior.
JetStream tools use the API bridge connection adapter and require the requested context to be the
active connected context.
Message query tools read bounded stream windows through the shared `StreamQuery` contract and shape
results as compact `AgentMessage` records instead of exposing raw NATS client objects.
Every MCP tool execution is timeout-bounded. Integration API executions append a local audit entry
with timestamp, origin, tool, context, result count and error count.
Forwarded calls identify origin as `cli` or `mcp`; direct HTTP calls default to `integration-api`.

The stdio MCP server exposes local-state tools directly. Live JetStream querying remains behind the
API bridge adapter so credentials and active NATS connections stay in one process.
When `NATS_TRAIL_API` is set, the stdio server forwards tool calls to the bridge Integration API
so agents can query live JetStream without receiving connection secrets.

### Integration API (`packages/server`, planned)

Read-only HTTP API over the same Query Engine for Sentry enrichment, dashboards and external
systems. Sentry should not consume NATS directly; NATS Trail should enrich errors with relevant
message context, breadcrumbs and trace-related events.

Current initial endpoints expose tool discovery and execution:

```
GET  /api/integration/tools
GET  /api/integration/audit
POST /api/integration/tools/:name
POST /api/integration/enrich/sentry
```

The Sentry enrichment endpoint composes existing read-only tools instead of adding a separate NATS
query path.
The same composition is exposed as `natstrail.enrich_sentry` for MCP and CLI callers.

### NATS Core vs JetStream

These are separated internally in the server:

- **NATS Core**: connection state, subjects, subscriptions, live messages.
- **JetStream**: streams, consumers, durables, persisted messages, DLQ-oriented inspection.

### Storage

Local product state only — never business secrets beyond what a context needs to connect:

```
contexts, saved filters, recent messages, preferences, basic audit logs
```

Saved filters are stored locally in `data/filters.json` and can be executed through MCP/runtime
when they identify a stream to search.

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
