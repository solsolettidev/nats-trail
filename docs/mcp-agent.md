# MCP / Agent Usage

Agents should use NATS Trail as a read-only debugging facade, not as a raw NATS client and not as
a generic shell command runner.

## Best Interface

- JSON is best for MCP request/response tools and bounded queries.
- NDJSON is best for live tailing, replay, large searches and incremental parsing.
- Text is for humans only.

The preferred shape is an MCP server exposing explicit tools with names, metadata and schemas.
The CLI remains useful for humans and as a fallback, but MCP tools are safer and easier for models
to call correctly.

## Run Server

```bash
npm run mcp
```

The stdio MCP server exposes the same `natstrail.*` tool contracts. Local-state tools such as
`natstrail.list_contexts` and `natstrail.list_filters` work directly. JetStream tools currently
return structured connection errors from the stdio server unless they are invoked through the API
bridge Integration API, which owns the live NATS connection.

To let the MCP server use the bridge's active NATS/JetStream connection, set `NATS_TRAIL_API`:

```bash
NATS_TRAIL_API=http://localhost:4000 npm run mcp
```

In that mode every `natstrail.*` tool call is forwarded to `/api/integration/tools/:name` and is
audited by the bridge.
Forwarded MCP calls are audited with origin `mcp`; CLI forwarding uses origin `cli`.

## Tools

Initial tool contracts live in `packages/mcp`:

- `natstrail.list_contexts`
- `natstrail.get_connection_status`
- `natstrail.list_audit`
- `natstrail.list_filters`
- `natstrail.run_filter`
- `natstrail.list_streams`
- `natstrail.get_stream_info`
- `natstrail.list_consumers`
- `natstrail.search_messages`
- `natstrail.trace_by_request_id`
- `natstrail.trace_by_correlation_id`
- `natstrail.search_dlq`
- `natstrail.enrich_sentry`
- `natstrail.get_message_detail`

`packages/mcp` now also exposes a small runtime executor. Implemented tools return real envelopes;
planned tools return structured `not implemented yet` errors instead of throwing raw exceptions.

Implemented runtime tools:

- `natstrail.list_contexts`
- `natstrail.get_connection_status`
- `natstrail.list_audit`
- `natstrail.list_filters`
- `natstrail.run_filter` for filters that include a stream
- `natstrail.list_streams` via the API bridge active connection
- `natstrail.get_stream_info` via the API bridge active connection
- `natstrail.list_consumers` via the API bridge active connection
- `natstrail.search_messages` via bounded ephemeral-consumer stream scans
- `natstrail.trace_by_request_id` across streams visible to the active connection
- `natstrail.trace_by_correlation_id` across streams visible to the active connection
- `natstrail.search_dlq` across detected DLQ subjects or an explicit subject

Stream-scanning tools (`run_filter`, `search_messages`, `trace_*`, `search_dlq`, `enrich_sentry`)
accept optional window and pagination inputs:

- `fromTs` / `toTs` — epoch-millisecond time window, applied server-side.
- `cursor` — resume sequence returned as `nextCursor` by a previous truncated query
  (`run_filter` and `search_messages`).
- `maxScan` — scan budget per query (default 10000, max 100000 examined messages).

Without an explicit window or cursor, scans cover the most recent `maxScan` sequences and the
envelope includes a `query.window_default` warning. When a scan stops at the limit or budget, the
envelope returns a non-null `nextCursor` and, on budget exhaustion, a `query.scan_truncated`
warning — so an agent always knows whether coverage was complete and how to continue.
- `natstrail.enrich_sentry` as a composed trace + DLQ context envelope
- `natstrail.get_message_detail` via stream + sequence direct lookup

## Output Contract

Agent-facing commands should return small envelopes:

```json
{
  "query": { "contextId": "dev", "limit": 50 },
  "summary": { "returned": 12, "truncated": false },
  "results": [],
  "nextCursor": null,
  "warnings": [],
  "errors": []
}
```

For streams, each NDJSON line should be independently useful:

```json
{"type":"message","subject":"orders.created","timestamp":1710000000000,"stream":"ORDERS","seq":42,"requestId":"req-1","payload":{"id":"o1"}}
```

## Rules

- Read-only by default.
- Never expose secrets from contexts.
- Always enforce limits.
- Validate required fields, field types, numeric ranges and unknown fields before execution.
- Enforce timeouts.
- Write audit entries for Integration API tool calls.
- Preserve caller origin in audit entries when provided by CLI or MCP.
- Prefer interpreted fields over raw protocol details.
- Include normalized errors and truncation/cursor metadata.
- Log agent-originated commands once audit storage exists.

## Integration API

Sentry should not consume NATS directly. NATS Trail should expose read-only enrichment endpoints
that attach event context, message breadcrumbs and trace-related messages to errors or dashboards.

Initial read-only endpoints:

- `GET /api/filters`
- `POST /api/filters`
- `DELETE /api/filters/:id`
- `GET /api/integration/tools?limit=50`
- `GET /api/integration/audit?limit=50`
- `POST /api/integration/tools/:name`
- `POST /api/integration/enrich/sentry`

JetStream tools require the requested `contextId` to be connected in the bridge connection pool.
Connecting one context never disconnects another, so agents and the UI can inspect different
contexts at the same time. `natstrail.get_connection_status` returns every pooled connection state.

When the bridge has tokens configured (`NATS_TRAIL_TOKENS` or `data/tokens.json`), Integration API
calls require `Authorization: Bearer <token>` and audit entries record the matched token name as
`identity` — the authenticated identity replaces trust in the self-reported origin header. The CLI
and the stdio MCP server read the token from `NATS_TRAIL_TOKEN`.
Message outputs are agent-friendly: payloads are bounded, JSON is omitted when the payload had to
be truncated, and common `request_id` / `correlation_id` fields are extracted when present.

Sentry enrichment accepts `contextId`, optional `requestId`, optional `correlationId` and `limit`.
It returns a single envelope result containing trace envelopes and a DLQ envelope.
The endpoint delegates to the `natstrail.enrich_sentry` tool so MCP and HTTP return the same shape.

## Listing on the MCP Registry

`packages/mcp/server.json` is the registry manifest, and `mcpName` in `packages/mcp/package.json`
is the verification field the registry matches it against. Both are kept in sync with the published
version by `scripts/prepare-packages.mjs`, so a release cannot drift from its manifest.

Publishing is two commands from a checkout, and needs the GitHub account that owns the
`io.github.solsolettidev` namespace:

```bash
cd packages/mcp
mcp-publisher login github
mcp-publisher publish
```

Install `mcp-publisher` with `brew install mcp-publisher`, or grab a binary from the
[registry releases](https://github.com/modelcontextprotocol/registry/releases).

Verify afterwards:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.solsolettidev/nats-trail"
```

## Incident enrichment

`natstrail.enrich_incident` returns one flat, destination-agnostic object rather than a bundle of
query envelopes:

```json
{
  "key": "request_id",
  "value": "req-8f21c",
  "summary": "req-8f21c failed at bronze.etl.failed: upstream 503 from provider api; after 5 steps across 3 stream(s) in 3ms; 1 related dead-letter message(s).",
  "flow": { "steps": [], "failedAt": {}, "durationMs": 3, "streams": [] },
  "dlq": [],
  "findings": [],
  "traceUrl": "http://localhost:4000/?tab=trace&requestId=req-8f21c"
}
```

Dead letters are filtered to the incident, not to the whole context. `summary` is one sentence that
leads with the failure, so it can be dropped straight into a notification body.

### Destination adapters

Each route below reshapes that same context for one tool's format. Adding a destination means adding
a shaper, never another query:

| Route | Shape |
|---|---|
| `POST /api/integration/enrich/incident` | The context itself |
| `POST /api/integration/enrich/grafana` | Annotation: `time`, `timeEnd`, `tags`, `text` |
| `POST /api/integration/enrich/datadog` | Event: `title`, markdown `text`, `alert_type`, `tags`, `aggregation_key` |
| `POST /api/integration/enrich/sentry` | `message`, `level`, `fingerprint`, `contexts["nats-trail"]` |
| `POST /api/integration/enrich/pagerduty` | Events API v2: `event_action`, `dedup_key`, `payload`, `links` |

Pass `uiBaseUrl` to get a `traceUrl` deep link back into the Trace tab.

The PagerDuty shaper sends `trigger` when the flow failed and `resolve` when it did not, keyed on
the correlation value — repeated enrichment updates one alert instead of paging twice. It never
includes `routing_key`: that is the caller's integration secret, and the bridge has no business
holding it.

> The registry caps `description` at 100 characters and enforces it at publish time.
> `scripts/prepare-packages.mjs` checks it on every release so that is not discovered halfway
> through one. Run `mcp-publisher validate` before `publish` to catch the rest.
