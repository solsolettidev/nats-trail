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

## Tools

Initial tool contracts live in `packages/mcp`:

- `natstrail.list_contexts`
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
- `natstrail.list_filters`
- `natstrail.run_filter` for filters that include a stream
- `natstrail.list_streams` via the API bridge active connection
- `natstrail.get_stream_info` via the API bridge active connection
- `natstrail.list_consumers` via the API bridge active connection
- `natstrail.search_messages` via direct JetStream reads from the active connection
- `natstrail.trace_by_request_id` across streams visible to the active connection
- `natstrail.trace_by_correlation_id` across streams visible to the active connection
- `natstrail.search_dlq` across detected DLQ subjects or an explicit subject
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
- Enforce timeouts.
- Write audit entries for Integration API tool calls.
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

JetStream tools require the requested `contextId` to match the bridge's active connected context.
Message outputs are agent-friendly: payloads are bounded, JSON is omitted when the payload had to
be truncated, and common `request_id` / `correlation_id` fields are extracted when present.

Sentry enrichment accepts `contextId`, optional `requestId`, optional `correlationId` and `limit`.
It returns a single envelope result containing trace envelopes and a DLQ envelope.
The endpoint delegates to the `natstrail.enrich_sentry` tool so MCP and HTTP return the same shape.
