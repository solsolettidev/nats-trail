# Features

## v1 (current)

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

### Persistence
- Contexts and UI preferences stored locally: selected context, last subject,
  recent + favorite subjects, recently inspected streams, DLQ subjects and viewer mode.
- Core panel shows favorite/recent subject chips; JetStream shows recent streams.

## Planned (later versions)

- Saved filters, `request_id` / `correlation_id` tracing.
- CLI (`nats-ui ...`) and MCP/agent layer over the same core (see `nats-ui-v2.md`).
