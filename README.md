# NATS Trail

Visual tool to inspect and debug **NATS Core** and **JetStream**. Think of it as a
"Swagger for messaging systems": connect to a context, subscribe to subjects live,
read messages with JSON pretty print, and browse streams and consumers.

> **Status:** v0 — UI + API bridge + core. CLI and MCP/agent layers come later (see
> `nats-ui-v2.md`), but the architecture already separates a reusable core so those
> interfaces can be added without duplicating logic.

## Architecture

```
UI  ->  API bridge  ->  Core  ->  NATS / JetStream
```

- **UI** (`packages/ui`): React + Vite. Presentation, interaction and visual debugging only.
- **API bridge** (`packages/server`): Express + WebSocket. Owns connection state, exposes
  HTTP/WS endpoints, normalizes errors, enforces limits, protects credentials.
- **Core** (`packages/core`): reusable product logic shared by UI, and later CLI and MCP —
  message parsing, payload formatting, filters, context validation, error normalization.

See [`docs/architecture.md`](docs/architecture.md) for the full rationale.

## Requirements

- Node.js >= 20
- A reachable NATS server (local is fine: `nats-server -js`)

## Quick start

```bash
npm install
cp config/contexts.example.json data/contexts.json   # optional: seed a context
npm run dev
```

- UI: http://localhost:5173
- API bridge: http://localhost:4000

`npm run dev` runs the API bridge and the UI together. The UI proxies `/api` and `/ws`
to the bridge, so you only open the UI URL.

## v0 features

- Context selector (local / dev / staging / prod / custom)
- Connection status (connected / disconnected / errors)
- NATS Core: subjects panel + live subject subscription
- Received messages list + message viewer with JSON pretty print
- JetStream: streams list + basic consumers view
- Loading, empty, error, connected and disconnected states
- Local persistence of contexts and preferences

See [`docs/features.md`](docs/features.md).

## Development

See [`docs/development.md`](docs/development.md).

## Security

Credentials live in contexts stored locally (`data/`, git-ignored). The UI never holds the
NATS connection directly — it always goes through the API bridge. Never commit `.env` or real
credentials.
