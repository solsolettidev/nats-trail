# CLI

The v2 CLI is a read-only human interface and fallback automation interface over the Query Engine.
MCP agents should prefer explicit MCP tools instead of free-form terminal commands.

## Run

```bash
npm run cli -- contexts list
npm run cli -- context use local
npm run cli -- context current --output json
npm run cli -- mcp describe --output json
npm run cli -- context current --agent
npm run cli -- mcp run natstrail.list_contexts --limit 50 --agent
```

JetStream MCP tools run through the API bridge Integration API because they need an active NATS
connection. The local CLI runtime only executes tools that can use local state safely.

Agent message records are intentionally compact: subject, timestamp, stream/sequence, bounded
payload, truncation flag, JSON when safe, and extracted request/correlation IDs.

The future installed binary name is `nats-ui` (`nats-trail` is also reserved).

## Contexts

The CLI reuses contexts created by the UI from `data/contexts.json`, or from the directory
configured with `NATS_TRAIL_DATA`.

```bash
npm run cli -- contexts list
npm run cli -- contexts list --output json
npm run cli -- context use <id-or-name>
npm run cli -- context current
```

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
