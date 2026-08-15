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

### Protobuf and msgpack

Both are decoded **without a schema and without a dependency**.

- **msgpack** decodes to the actual value: maps, arrays, sized integers, floats, binary as hex.
- **protobuf** decodes the wire format into field *numbers*, types and values, recursing into
  nested messages. Field **names** need a descriptor and are deliberately not guessed.

Both decoders return nothing rather than guess: trailing bytes, invalid UTF-8, unknown wire types
or unsupported ext types all fall back to the hex dump. A confident wrong decode would be worse
than no decode, because it would look authoritative.

Agents receive the decode instead of base64 — structured fields beat bytes they would have to
decode themselves.

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

### Trace panel (UI)
The `Trace` tab renders a reconstructed flow as a timeline: one step per event, elapsed time between
steps, the stream each came from, and the failing step highlighted with its error. A "What is
broken?" button runs the health summary in place.

Backed by `/api/flow?requestId=…` and `/api/health-summary`.

## Write operations (humans only)

NATS Trail can now change state, on the human surfaces only.

| Operation | UI | CLI | Guard |
|---|---|---|---|
| Publish | Core panel | `nats-trail publish` | Non-local contexts require typing the environment name |
| Request / reply | Core panel | `nats-trail request` | Bounded timeout, 30s max |
| Purge stream | JetStream row | `nats-trail purge` | Confirmation dialog / `--yes` |
| Delete message | — | `nats-trail delete message` | `--yes` |
| Delete consumer | Consumer row | `nats-trail delete consumer` | Confirmation dialog / `--yes` |
| Delete stream | — | `nats-trail delete stream` | Must name the stream back via `--confirm` |
| KV set | KV panel (edit) | `nats-trail kv put` | Optimistic concurrency via `--expected-revision` |
| KV delete | KV row | `nats-trail kv delete` | Confirmation; leaves a `DEL` tombstone |
| KV purge | — | `nats-trail kv purge` | Confirmation; discards the key history |
| Create/update stream | JetStream *New stream* / row edit | `nats-trail stream create` | Illegal changes surface the server error |
| Create/update consumer | Consumers *New consumer* | `nats-trail consumer create` | Durable by name |
| Object put | — | `nats-trail obj put` | Text payloads only, by design |
| Object delete | — | `nats-trail obj delete` | Confirmation |
| Import a blueprint | — | `nats-trail stream import` | Confirmation; refuses a rename that would collide |

### How the agent stays locked out

- Mutations live under `/api/mutate`, behind `mutationAuth`.
- `executeIntegrationTool` hands the MCP runtime an object containing read functions only. There is
  no disabled `publish` — the runtime has nothing to call.
- CLI write commands refuse to run under `--agent`.
- `test/write-boundary.test.mjs` asserts all of the above by reading the source, so the guarantee
  fails loudly if someone opens a path.

### Token scopes

Bearer tokens are read-only unless granted `write`:

```bash
NATS_TRAIL_TOKENS=reader:tok-read,writer:tok-write:write
```

Or in `data/tokens.json`: `[{ "name": "writer", "token": "…", "scopes": ["write"] }]`.

A `read` token attempting a mutation gets `403` naming the token. Every mutation is audited with its
action, target and arguments, success or failure, so a write can be reconstructed afterwards.

## nkey auth and monitoring URL

- Contexts accept a bare nkey seed (`SU…`) alongside none / user-password / token / `.creds`.
  The seed is validated for shape at creation rather than failing at connect time, and it is
  stripped by `sanitizeContext` like every other credential.
- A context can override its HTTP monitoring endpoint with `monitorUrl` when the server does not
  publish monitoring on the conventional port 8222.

### KV writes and concurrency

`kv put` accepts `--expected-revision`. Passing the revision a value was read at turns the write
into a compare-and-set: a concurrent change is refused with `wrong last sequence` instead of being
silently overwritten. The UI's edit dialog always sends it, so editing a value someone else changed
fails loudly.

`delete` leaves a `DEL` tombstone the history can show — a value that disappeared stays
explainable. `purge` discards the history, which is why it is CLI-only and needs `--yes`.

### Stream and consumer administration

Create and update are the same call: the name decides. Fields left unset are omitted from the
request, so an update never resets a setting nobody touched.

JetStream refuses some changes on a live stream — storage type and retention among them — and that
error is shown as-is rather than smoothed over. Silently ignoring a requested change is worse than
refusing it.

Durations are milliseconds everywhere in the product (`maxAge`, `ackWait`); the nanosecond
conversion happens at the NATS boundary.

### Stream blueprints

`stream export` writes a stream's shape — configuration plus durable consumers, no messages — as a
portable JSON document. `stream import` recreates it, in the same context under a new name or in
another context entirely. This is what teams mean by "give staging the same streams as prod", and it
belongs in version control.

Export is read-only, so it works in `--agent` mode. Import is a mutation and does not.

Two things the CLI refuses to let you get wrong:

- **A rename keeps its subjects**, and JetStream will not let two streams claim the same ones. The
  import stops with the reason and the two ways out (`--subjects` to remap, or `--context-id` to land
  elsewhere) rather than letting the server's "subjects overlap" read like a bug in the rename.
- **Remapping subjects does not remap consumer filters.** JetStream accepts a consumer filtering a
  subject its stream no longer carries — it just never receives anything. The import warns and names
  the consumers affected.

> **Binary snapshots are deliberately out.** `nats.js` exposes no snapshot API, and streaming message
> bytes through the bridge would turn a debugging tool into a file transfer service. Use
> `nats stream backup` for that.

## Correlation keys

What links messages together is not universal, so it is configured rather than assumed.

A **correlation key** declares where to find one identifier:

```jsonc
{
  "name": "order_id",
  "headers": ["X-Order-Id"],   // tried first: the protocol level is authoritative
  "paths": ["data.order.id"],  // dotted paths into the JSON payload
  "format": "raw"              // or "w3c-traceparent"
}
```

Messages carry a `correlations` map of every key they actually have. Absent keys are omitted rather
than set to null, so the shape reports what was found.

### Defaults

Only conventions with a specification behind them:

| Key | Source | Why |
|---|---|---|
| `trace_id` | `traceparent` header | W3C Trace Context — what OpenTelemetry emits |
| `correlation_id` | headers, then payload | The Correlation Identifier pattern; native in AMQP and JMS |
| `request_id` | headers, then payload | The `X-Request-Id` convention |

**Business identifiers are never guessed.** Order ids, tenant ids and the like are configured.

`trace_id` is the 32-hex id from the *middle* of `traceparent`, not the whole header: two spans of
one trace differ in parent id and would otherwise never correlate. A malformed or all-zero trace id
yields nothing.

### Finding your own keys

`suggestCorrelationKeys` proposes candidates from real traffic: string fields that are near-unique
per message **and** appear on more than one subject. Unique-per-message means it identifies
something; crossing subjects means it links them. A field that is unique but lives on one subject is
reported as a likely entity id rather than hidden, so the judgement stays with the reader.

Low-cardinality fields (`status`, `type`) are rejected — they categorise, they do not identify.

> NATS headers were previously read on publish but never on receive, so header-carried identifiers
> were invisible. They are now read on every path.

### Configuring keys

`GET /api/correlation-keys` reports what applies and where it came from:

```json
{ "effective": [ ... ], "source": "global", "global": [ ... ], "context": null }
```

Precedence is context override → deployment-wide (`data/correlation.json`) → defaults. An empty
array counts as "not configured" rather than "correlate nothing", which is never what anyone means.
Saving is validated: a key with neither a header nor a path would silently never match, so it is
refused at save time rather than at query time.

Exposed as `nats-trail keys list` and `nats-trail keys suggest`, and as the tools
`natstrail.list_correlation_keys` and `natstrail.suggest_correlation_keys`.

### Tracing by any key

`natstrail.trace_by_key` takes `--key` and `--value`, so a trace works on whatever a deployment
correlates by. An unknown key is rejected with the list of configured ones rather than returning an
empty result that looks like "nothing found".

`trace_by_request_id` and `trace_by_correlation_id` remain as named shortcuts that delegate to it.
