# CLI

The v2 CLI is a read-only human interface and fallback automation interface over the Query Engine.
MCP agents should prefer explicit MCP tools instead of free-form terminal commands.

## Run

```bash
npm run cli
npm run cli -- contexts list
npm run cli -- context use local
npm run cli -- context current --output json
npm run cli -- context create --id local --name Local --url nats://127.0.0.1:4222 --environment local
npm run cli -- context delete --context-id local
npm run cli -- mcp describe --output json
npm run cli -- context current --agent
npm run cli -- connection status --limit 1 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- connection connect --context-id local --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- connection disconnect --agent
npm run cli -- audit list --limit 50 --agent
npm run cli -- mcp run natstrail.list_contexts --limit 50 --agent
npm run cli -- mcp run natstrail.list_filters --limit 50 --agent
npm run cli -- filters list --limit 50 --agent
npm run cli -- filter run --context-id local --filter failed-refreshes --limit 20 --agent
npm run cli -- streams list --context-id local --limit 50 --agent
npm run cli -- stream info --context-id local --stream SOURCE_EVENTS --limit 1 --agent
npm run cli -- consumers list --context-id local --stream SOURCE_EVENTS --limit 50 --agent
npm run cli -- messages search --context-id local --stream SOURCE_EVENTS --request-id req-123 --limit 20 --agent
npm run cli -- message detail --context-id local --stream SOURCE_EVENTS --seq 42 --limit 1 --agent
npm run cli -- trace --context-id local --request-id req-123 --limit 20 --agent
npm run cli -- dlq search --context-id local --limit 20 --agent
npm run cli -- sentry enrich --context-id local --request-id req-123 --limit 20 --agent
```

JetStream MCP tools run through the API bridge Integration API because they need an active NATS
connection. The local CLI runtime only executes tools that can use local state safely.

Set `NATS_TRAIL_API` to forward `mcp run` calls to the bridge:

```bash
NATS_TRAIL_API=http://localhost:4000 npm run cli -- mcp run natstrail.list_streams --context-id local --limit 50 --agent
```

The higher-level CLI aliases (`connection status`, `audit list`, `filters list`, `filter run`, `streams list`,
`stream info`, `consumers list`, `messages search`, `message detail`, `trace`, `dlq search`,
`sentry enrich`) use the same forwarding behavior and output envelopes.
If `--context-id` is omitted, the CLI uses the selected context from shared preferences when one
exists.

Agent message records are intentionally compact: subject, timestamp, stream/sequence, bounded
payload, truncation flag, JSON when safe, and extracted request/correlation IDs.
The MCP runtime enforces tool timeouts; Integration API calls are audited by the server.
When CLI forwards through `NATS_TRAIL_API`, audit entries use origin `cli`.

The future installed binary name is `nats-ui` (`nats-trail` is also reserved).

Running the CLI without arguments opens an interactive shell with the same commands:

```txt
trail> connection status --limit 1 --agent
trail> streams list --context-id local --limit 50 --agent
trail> exit
```

## Contexts

The CLI reuses contexts created by the UI from `data/contexts.json`, or from the directory
configured with `NATS_TRAIL_DATA`.

```bash
npm run cli -- contexts list
npm run cli -- contexts list --output json
npm run cli -- context use <id-or-name>
npm run cli -- context current
npm run cli -- context create --id local --name Local --url nats://127.0.0.1:4222 --environment local
npm run cli -- context delete --context-id local
```

When `NATS_TRAIL_API` is set, `contexts list`, `context create`, `context delete`,
`connection connect` and `connection disconnect` operate through the bridge API.

Context output is sanitized with the shared core sanitizer, so password, token and `.creds`
path values are not printed.

## Current Scope

- List configured contexts.
- Select the current context in shared preferences.
- Print text, JSON or NDJSON output.
- `--agent` forces JSON envelopes for automation.
- `mcp run <tool-name>` executes the same local read-only MCP runtime used by future servers.

## Agent Output

Use `--agent` for automation. It forces JSON envelopes, no colors, no prompts, no spinners,
sanitized output and bounded results. Use NDJSON only for live tails, replay and large incremental
streams.

Every future query command should return compact, interpreted records instead of raw NATS dumps:
normalized subject, timestamp, stream/sequence when available, detected JSON payload, extracted
`request_id` / `correlation_id`, size, match reason, cursor and result limits.

```bash
npm run cli -- mcp tools --output json
npm run cli -- contexts list --output ndjson
npm run cli -- mcp run natstrail.list_contexts --limit 50 --agent
```

Next v2 steps are saved filters, subject/stream read queries and agent-safe audit logging.
