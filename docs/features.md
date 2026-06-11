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

## v2 (started)

- Query Engine contracts in core: stable envelopes, mandatory limits, truncation helpers and structured errors.
- CLI package (`@nats-trail/cli`) with `nats-ui` / `nats-trail` command names reserved.
- CLI interactive shell with `NATS-TRAIL CLI` ASCII banner and persistent `trail>` prompt.
- Reuses UI-created local contexts from `data/contexts.json` or `NATS_TRAIL_DATA`.
- Supports `contexts list`, `context use <id-or-name>`, `context current`, `context create`,
  `context delete`, `connection connect` and `connection disconnect`.
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

## Planned

- Saved filters, `request_id` / `correlation_id` tracing.
- Subject, stream, consumer and DLQ read queries from CLI.
- MCP server implementation over the Query Engine (see `nats-ui-v2.md`).
- Read-only Integration API for Sentry enrichment, dashboards and external systems.
