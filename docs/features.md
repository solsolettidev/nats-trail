# Features

## v0 (current)

### Contexts
- Create / list / delete contexts (local, dev, staging, prod, custom).
- Each context: name, environment, NATS URL, optional auth and TLS fields.
- Persisted locally under `data/contexts.json`.
- Visual environment badge to avoid confusing prod with local.

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
- Raw/Tree toggle, fullscreen mode, and copy full message.

### JetStream
- Streams list: name, subjects, message count, size, last message time.
- Consumers view per stream: name, durable, pending, last delivered, basic state.
- Replay + live tail of a consumer's subjects, filterable by subject, date range and text.

### States
Every panel handles: loading, empty, error, connected and disconnected.

### Persistence
- Contexts and UI preferences (selected context, last subject) stored locally.

## Planned (later versions)

- Saved filters, DLQ panel, `request_id` / `correlation_id` tracing.
- CLI (`nats-ui ...`) and MCP/agent layer over the same core (see `nats-ui-v2.md`).
