# Development

## Build

`npm run build` compiles `core`, `mcp`, `cli` and `server` to `dist/` (TypeScript project
references) and bundles the UI with Vite. `npm run clean` removes the compiled output.

The workspace packages resolve each other through their compiled `dist`, so `npm run dev` also
runs `tsc -b --watch` (`dev:types`) alongside the server and the UI. `prepare` builds on
`npm install`, so a fresh clone can run `npm start` right away.

The `cli`, `server` and `mcp` packages ship `bin` entries (`nats-trail`, `natstrail-server` and
`natstrail-mcp`)
pointing at the compiled output, so they run under plain `node` without `tsx`.

## Layout

```
packages/
  core/     @nats-trail/core    pure product logic + types (no NATS/Express/React deps)
  cli/      @nats-trail/cli     v2 command-line interface over shared local state
  mcp/      @nats-trail/mcp     explicit read-only agent tool contracts
  server/   @nats-trail/server  API bridge: Express + ws + nats client
  ui/       @nats-trail/ui       React + Vite SPA
docs/
config/     example local config (committed, no secrets)
data/        local runtime state (git-ignored)
```

Managed as npm workspaces.

## Setup

```bash
npm install
```

## Run

```bash
npm run dev          # bridge (:4000) + UI (:5173) together
npm run dev:server   # API bridge only
npm run dev:ui       # UI only
npm run cli -- help  # CLI only
npm run mcp          # MCP stdio server
```

The UI dev server proxies `/api` and `/ws` to the bridge at `:4000`.

To test against NATS locally:

```bash
nats-server -js      # enable JetStream
```

Then create a context in the UI pointing at `nats://127.0.0.1:4222`, or seed one:

```bash
mkdir -p data
cp config/contexts.example.json data/contexts.json
```

## Validation

```bash
npm run typecheck    # tsc --noEmit across all packages
npm run build        # production build of the UI
```

There are no automated tests in v0 (tests are added only when explicitly requested).

## Conventions

- Conventional Commits, small and focused.
- Keep reusable logic in `core`; the server and UI are thin adapters.
- Never commit secrets or `.env`; contexts with credentials live in `data/` (git-ignored).
- UI styling: a single `packages/ui/src/styles.css` driven by CSS variables (4px spacing
  scale, type scale, reusable primitives `.btn` / `.input` / `.badge` / `.tbl` / `.filters`
  / `.list` / `.msg` / `.viewer` / `.jt` / `.overlay` / `.state`). No CSS framework.
- Icons: Phosphor (`@phosphor-icons/web`) loaded via CDN `<link>` in `index.html`; use the
  shared `Icon` helper in `components/ui.tsx`.

## Environment variables (server)

```
NATS_TRAIL_PORT   API bridge port (default 4000)
NATS_TRAIL_DATA   data directory  (default ./data)
NATS_TRAIL_API    MCP server bridge URL for live tools (example http://localhost:4000)
```

## Demo data

`scripts/seed-demo.mjs` fills a local NATS server with a realistic workload: four streams, three
durable consumers with pending messages, ~200 correlated events, and three flows that fail and land
in `DLQ_EVENTS`. It refuses to run against anything that is not loopback.

```bash
docker compose up -d
node scripts/seed-demo.mjs
```

The failing request ids it prints are the ones worth tracing:

```bash
nats-trail trace --request-id req-0001b --context-id local --limit 20
```

## Tests

```bash
npm test
```

`node:test` against the compiled `dist/`, so the tests exercise exactly what ships — no test
framework dependency. They cover the parts an agent depends on being correct: envelope limits and
truncation, UTF-8 payload cutting, subject wildcard semantics, filter evaluation, credential
sanitization, and the MCP contract.

Two of those are guardrails rather than unit tests: one asserts every tool is `readOnly` with a
required `limit`, and one reads `McpRuntimeData` to assert no write capability was ever added to the
interface the agent runtime receives. If someone adds a write path to the agent surface, the suite
fails.
