# Features

## v1 (complete)

### Contexts
- Create / list / delete contexts (local, dev, staging, prod, custom).
- Create form captures auth (none / user-password / token / `.creds`) and TLS (CA path, server name).
- Secrets are stored locally under `data/contexts.json` and stripped from API responses.
- Visual environment badge plus a confirmation prompt before connecting to a prod context.

### Connection
- Connect / disconnect to the selected context through the API bridge.
- Connection status: `disconnected`, `connecting`, `connected`, `error`.
- Shows active URL and selected context; surfaces connection errors.

### NATS Core
- Subjects panel: enter a subject pattern (`orders.*`, `project.>`, `events.user.created`).
- Live subscription over WebSocket; incoming messages stream into a list ordered by time.
- Recent messages buffer kept in memory so you can review messages that already passed.

### Message viewer
- Full payload view with automatic JSON pretty print; non-JSON shown as text.
- Tree view for JSON with expand/collapse and per-key copy-path.
- In-payload search (filters tree nodes / raw lines, case-insensitive).
- Raw/Tree toggle, fullscreen mode, copy full message, and persisted viewer mode preference.

### JetStream
- Streams list: name, subjects, message count, size, last message time and basic configuration.
- Direct stream message inspection, plus replay + live tail of a consumer's subjects.
- Consumers view per stream: name, durable, pending, last delivered, state and relevant issues.
- Message buffers are filterable by subject, date range, text and JSON event type.

### Saved filters
- Save the current panel filters (subject, text, event type, date range) under a name.
- Saved filters live in `data/filters.json` and are served by `/api/filters`, so the CLI and
  MCP tools read the same definitions: `nats-trail filter run --filter <id>`.
- The save form asks for a stream because `natstrail.run_filter` scans a JetStream stream.
- Click a saved filter to apply it to the panel; delete it with the chip's `x`.

### DLQ
- Auto-detects dead-letter subjects per stream (subjects matching `dlq`/`dead`).
- Supports manually configured DLQ subjects when auto-detection is not enough.
- Replays dead-letter messages and shows them in the viewer.
- Vendor-agnostic, best-effort extraction of original subject and reason from the payload.

### States
Every panel handles: loading, empty, error, connected and disconnected.

### Branding
- "Waypoint" mark: a trail of nodes leading to a focus ring, evoking tracing a
  message flow to the event under inspection.
- Inline SVG in the header brand (inherits `--accent`/`--muted`), with the wordmark
  "NATS Trail" (Trail in accent). Favicon at `packages/ui/public/favicon.svg`.

### Persistence
- Contexts and UI preferences stored locally: selected context, last subject,
  recent + favorite subjects, recently inspected streams, DLQ subjects and viewer mode.
- Core panel shows favorite/recent subject chips; JetStream shows recent streams.

## v2 (complete)

- Query Engine contracts in core: stable envelopes, mandatory limits, truncation helpers and structured errors.
- CLI published as the unscoped `nats-trail` package, exposing the `nats-trail` binary.
- CLI interactive shell with `NATS-TRAIL CLI` ASCII banner and persistent `trail>` prompt.
- Reuses UI-created local contexts from `data/contexts.json` or `NATS_TRAIL_DATA`.
- Supports `contexts list`, `context use <id-or-name>`, `context current`, `context create`,
  `context delete`, `connection connect` and `connection disconnect`.
- CLI detects the selected or only configured context and auto-connects the bridge for live commands.
- Supports text, JSON, NDJSON and `--agent` JSON envelope output for current commands.
- Sanitizes contexts before printing so secrets are not exposed.
- MCP package defines explicit read-only `natstrail.*` tool contracts with input/output schemas and timeouts.
- MCP runtime validates required fields, field types, numeric ranges and unknown fields before execution.
- MCP/CLI expose bridge connection status through `natstrail.get_connection_status`.
- MCP/CLI expose recent audit entries through `natstrail.list_audit`.
- MCP stdio server exposes tools through the MCP protocol for agent clients.
- MCP stdio can forward tool calls to the bridge with `NATS_TRAIL_API` for live JetStream access.
- CLI `mcp run` can also forward tool calls to the bridge with `NATS_TRAIL_API`.
- CLI exposes human-friendly aliases for agent-safe filters, streams, consumers, message search,
  message detail, trace and DLQ search.
- CLI can listen to NATS Core subjects and replay/tail JetStream streams over the bridge WebSocket.
- Sentry enrichment is exposed as both `natstrail.enrich_sentry` and `sentry enrich` in the CLI.
- Saved filters are persisted under `data/filters.json` and exposed through `/api/filters`.
- MCP runtime executes `natstrail.list_contexts`, `natstrail.list_filters`, `natstrail.run_filter`,
  `natstrail.list_streams`, `natstrail.get_stream_info`, `natstrail.list_consumers`,
  `natstrail.search_messages`, `natstrail.trace_by_request_id`, `natstrail.trace_by_correlation_id`,
  `natstrail.search_dlq` and `natstrail.get_message_detail` through shared envelopes.
- Agent message output includes subject, timestamp, stream/sequence, payload truncation flags and
  extracted `request_id` / `correlation_id` when present.
- MCP runtime enforces tool timeouts and Integration API writes local audit entries.
- Audit entries distinguish `cli`, `mcp`, direct `integration-api` and unknown origins.
- Integration API exposes read-only tool discovery and tool execution endpoints under `/api/integration`.
- Integration API includes `POST /api/integration/enrich/sentry` to collect trace and DLQ context
  for external error tools without exposing NATS credentials.

## Packaging

- `core`, `mcp`, `cli` and `server` compile to `dist/` through TypeScript project references.
- `nats-trail`, `natstrail-server` and `natstrail-mcp` are `bin` entries running under plain `node`.
- `npm start` serves the built UI and the API from one process on `127.0.0.1:4000`.

## Planned

See [`roadmap.md`](roadmap.md) for the prioritized plan. In short: distribution (npm, Docker),
KV and Object Store browsing, server health, payload codecs, then write operations for the UI and
CLI only — the MCP runtime stays read-only by construction.

## KV Store

- Browse JetStream Key/Value buckets: values, size, history depth, TTL, storage and replicas.
- List live keys with their current value, revision and age; filter by key or value.
- Full revision history per key, including `DEL` / `PURGE` tombstones, which is what makes a
  value that disappeared explainable.
- Exposed on all three surfaces: `/api/kv`, `nats-trail kv list|keys|history`, and the read-only
  tools `natstrail.list_kv_buckets`, `natstrail.list_kv_keys` and `natstrail.get_kv_history`.

## Object Store

- Browse Object Store buckets: object count, total size, TTL, storage and replicas.
- List object metadata — name, description, size, chunk count, checksum digest and age —
  without ever streaming a payload through the bridge.
- Exposed on all three surfaces: `/api/obj`, `nats-trail obj list|objects`, and the read-only
  tools `natstrail.list_object_buckets` and `natstrail.list_objects`.

## Server health

- Reads the NATS HTTP monitoring port (`varz`, `jsz`, `connz`), which is a different endpoint from
  the client connection — so it reports clearly when monitoring is unreachable while NATS itself
  works, instead of implying the server is down.
- Version, uptime, connections, subscriptions, traffic, memory, CPU, routes and leaf nodes.
- JetStream totals: streams, consumers, messages, bytes, memory and file store.
- Client connection list with language, subscriptions, traffic, RTT and idle time.
- The monitoring URL defaults to the connection host on port 8222; override it per context with
  `monitorUrl`.
- Exposed as `/api/server/health` and `/api/server/connections`, `nats-trail server health|connections`,
  and the tools `natstrail.get_server_health` and `natstrail.list_server_connections`.

## Payload encodings

- Every message carries an `encoding`: `json`, `text` or `binary`.
- A payload is `binary` when the bytes are not valid UTF-8 — protobuf, msgpack, compressed blobs.
  The bridge now passes the original bytes through, so binary payloads are no longer reduced to
  replacement characters.
- Binary payloads get a hex dump with an offset column and an ASCII gutter, plus a base64 copy
  action. Both are capped at the first 1 KB.
- Agents receive binary payloads as **base64** with `encoding: "binary"`, never as lossy text — an
  agent must not reason about bytes that were never there.

> Protobuf and msgpack are shown as byte dumps, not decoded into fields. Decoding protobuf needs a
> schema descriptor per subject, and msgpack needs a decoding dependency; both are open decisions.

## Agent-native insight

Three tools that exist because an agent needs conclusions, not counters.

### Subject discovery — `natstrail.discover_subjects`
Lists the subjects that actually carry traffic (from server-side subject state, not declared
patterns) and infers each one's payload shape by sampling real messages: dotted field paths, the
JSON types seen at each path, how consistently each field is present, and an example value. Nested
objects become dotted paths; arrays collapse to a single `[]` segment. KV and Object Store backing
streams are skipped.

This is what lets an agent debug a topology nobody described to it.

### Flow reconstruction — `natstrail.reconstruct_flow`
Takes one `request_id` or `correlation_id` and returns the causal chain: ordered steps with the
elapsed time between them, which streams took part, whether the flow failed, and the **first**
failing step with its error text — the one actually worth reading.

Failure is detected from the payload (`error`, `reason`, `message`) and from the subject
(`*.failed`, `*.error`, dead-letter naming).

### Health summary — `natstrail.get_health_summary`
Answers "what is broken right now" with ranked findings instead of raw metrics: consumers falling
behind, redeliveries that point at repeated processing failures, dead-letter volume, and slow
consumers reported by the server. Critical first, then by magnitude.

All three are read-only, bounded by the same envelope, and available as `nats-trail discover`,
`nats-trail flow` and `nats-trail health`.
