# Development

## Layout

```
packages/
  core/     @nats-trail/core    pure product logic + types (no NATS/Express/React deps)
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

## Environment variables (server)

```
NATS_TRAIL_PORT   API bridge port (default 4000)
NATS_TRAIL_DATA   data directory  (default ./data)
```
