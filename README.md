# NATS Trail

Visual tool to inspect and debug **NATS Core** and **JetStream**. Think of it as a
"Swagger for messaging systems": connect to a context, subscribe to subjects live,
read messages with JSON pretty print, and browse streams and consumers.

> **Status:** v1 and v2 are complete. v1 is the UI + API bridge + core; v2 adds a shared
> Query Engine, explicit MCP tools, a read-only Integration API and a CLI fallback. The
> whole product is read-only by design: it never publishes, deletes or modifies anything.

## Architecture

```
UI  ->  API bridge  ->  Core  ->  NATS / JetStream
```

- **UI** (`packages/ui`): React + Vite. Presentation, interaction and visual debugging only.
- **API bridge** (`packages/server`): Express + WebSocket. Owns connection state, exposes
  HTTP/WS endpoints, normalizes errors, enforces limits, protects credentials.
- **Core** (`packages/core`): reusable product logic shared by UI, and later CLI and MCP —
  message parsing, payload formatting, filters, context validation, error normalization.
- **CLI** (`packages/cli`): v2 command-line interface over shared local state and core logic.
- **MCP** (`packages/mcp`): explicit read-only tool contracts for agents.

See [`docs/architecture.md`](docs/architecture.md) for the full rationale.

## Requirements

- Node.js >= 20
- A reachable NATS server (local is fine: `nats-server -js`)

## Quick start

```bash
npm install
cp config/contexts.example.json data/contexts.json   # optional: seed a context
npm start
```

Open http://127.0.0.1:4000 — the server builds on install and serves the UI and the API
from a single process and a single port.

For development with hot reload:

```bash
npm run dev
```

- UI: http://localhost:5173
- API bridge: http://localhost:4000

`npm run dev` runs the TypeScript watcher, the API bridge and the UI together. The UI
proxies `/api` and `/ws` to the bridge, so you only open the UI URL.

The server binds to `127.0.0.1` because the local API is unauthenticated and reads the
stored NATS credentials. Set `NATS_TRAIL_HOST=0.0.0.0` (and bearer tokens, see Security)
only when you mean to expose it.

## v1 features

- Context selector (local / dev / staging / prod / custom)
- Context auth with none, user/password, token and `.creds`; TLS CA and server name
- Connection status (connected / disconnected / errors)
- NATS Core: subjects panel + live subject subscription
- Received messages list + message viewer with JSON pretty print, tree view, search and fullscreen
- JetStream: streams list, stream message inspection, replay/live tail and consumers view
- Filters by subject, date range, text and JSON event type
- DLQ panel with auto-detected and manually configured dead-letter subjects
- Loading, empty, error, connected and disconnected states
- Local persistence of contexts and preferences

See [`docs/features.md`](docs/features.md).

## v2 Interfaces

```bash
npm run cli
npm run cli -- contexts list
npm run cli -- context use local
npm run cli -- context create --id local --name Local --url nats://127.0.0.1:4222 --environment local
npm run cli -- context current --output json
npm run cli -- mcp tools --output json
npm run cli -- context current --agent
npm run cli -- mcp run natstrail.list_contexts --limit 50 --agent
npm run cli -- mcp run natstrail.list_filters --limit 50 --agent
npm run cli -- filters list --limit 50 --agent
npm run cli -- connection status --limit 1 --agent
npm run cli -- audit list --limit 50 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- connection connect --context-id local --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- streams list --limit 50 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- subject listen --subject 'orders.>' --limit 20 --timeout-ms 30000 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- stream tail --stream SOURCE_EVENTS --limit 20 --timeout-ms 30000 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- streams list --context-id local --limit 50 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- trace --context-id local --request-id req-123 --limit 20 --agent
NATS_TRAIL_API=http://localhost:4000 npm run cli -- sentry enrich --context-id local --request-id req-123 --limit 20 --agent
npm run mcp
NATS_TRAIL_API=http://localhost:4000 npm run mcp
NATS_TRAIL_API=http://localhost:4000 npm run cli -- mcp run natstrail.list_streams --contextId local --limit 50 --agent
```

See [`docs/cli.md`](docs/cli.md) and [`docs/mcp-agent.md`](docs/mcp-agent.md).

The read-only Integration API exposes `/api/integration/tools`, `/api/integration/tools/:name`
`/api/integration/audit` and `/api/integration/enrich/sentry` for external systems.

## Development

See [`docs/development.md`](docs/development.md).

## Security

Credentials live in contexts stored locally (`data/`, git-ignored). The UI never holds the
NATS connection directly — it always goes through the API bridge. Never commit `.env` or real
credentials.

The bridge keeps one NATS connection per context (a pool), so agents and the UI can inspect
different contexts concurrently without disconnecting each other.

The server listens on `127.0.0.1` by default. `/api/contexts`, `/api/connect` and the
JetStream read routes are unauthenticated local endpoints; only the Integration API and the
WebSocket accept bearer tokens. Do not bind to a public interface without a proxy in front.

To require auth on the Integration API and the live WebSocket, configure bearer tokens via
`NATS_TRAIL_TOKENS=name:token[,name2:token2]` or `data/tokens.json`. Audit entries then record
the authenticated token name per call. Clients send the token from `NATS_TRAIL_TOKEN`.
