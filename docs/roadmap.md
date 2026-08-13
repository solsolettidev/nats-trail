# Roadmap

Ordered by priority. Phase 0 blocks adoption; phase 1 closes functional gaps against
[NUI](https://github.com/nats-nui/nui) and [natscli](https://github.com/nats-io/natscli); phase 2
makes NATS Trail a daily driver without giving up the agent guarantee; phase 3 is where nobody else
competes.

Nothing in phases 0-2 may weaken the rule in [Write boundary](#write-boundary).

---

## Phase 0 — Make it installable

Nothing else matters until someone who is not the author can run this. Highest return per hour of
work in the whole document.

| # | Task | Notes |
|---|---|---|
| 0.1 | Apache-2.0 `LICENSE` and `license` field in every manifest | **done** — without this nobody may legally use the project |
| 0.2 | Publish to npm | Blocked on the `NPM_TOKEN` secret. Publish order: `core`, `mcp`, `ui`, `server`, `nats-trail` |
| 0.3 | `npx nats-trail serve` works from a clean machine | Follows from 0.2. `serve` runs today from source and in Docker |
| 0.4 | Docker image + `docker-compose.yml` with a `nats-server -js` | **done** — multi-stage build, non-root, `/data` volume, healthcheck |
| 0.5 | Rename the primary binary to `nats-trail` | **done** — `nats-ui` is taken on npm by an unrelated package, so the alias was dropped rather than deprecated |
| 0.6 | GitHub Actions: typecheck + build on PR, publish on tag | **done** — CI on Node 20/22 with a serve smoke test; release workflow needs `NPM_TOKEN` |
| 0.7 | Screenshots or a short GIF of the UI in the README | Text-only READMEs read as unfinished |

## Phase 1 — Functional parity

The gaps a NATS user notices in the first ten minutes.

| # | Task | Why |
|---|---|---|
| 1.1 | **KV Store browsing**: buckets, entries, entry history | Largest functional hole. NUI, gnat and natscli all have it; KV carries config, locks and service state |
| 1.2 | **Object Store browsing**: buckets, objects, metadata | Same gap, lower usage |
| 1.3 | **Server and cluster health**: `varz`, `connz`, `jsz`, `routez` panel | Nearly free (HTTP monitoring port) and removes the "this tool cannot see the server" impression |
| 1.4 | **Payload codecs**: protobuf (with descriptor), msgpack, hex fallback | A protobuf payload is currently unreadable. NUI decodes it |
| 1.5 | **Request/reply** from the UI and CLI | A debugging primitive, not just a write. First write-path feature — see phase 2 |
| 1.6 | Tests on the query engine, `matchFilter`, envelope limits and truncation | Currently zero. These are the parts an agent depends on being correct |
| 1.7 | Bare nkey seed auth | `creds` covers most JWT setups; nkey alone does not |

## Phase 2 — Writes, on the human side only

Makes NATS Trail a daily driver instead of a second panel. Every item lands in the UI and the CLI;
none of it reaches the MCP runtime.

| # | Task | Guard |
|---|---|---|
| 2.1 | Publish to a subject | Typed confirmation on non-local contexts |
| 2.2 | Purge stream, delete message | Typed confirmation, always audited |
| 2.3 | Consumer create / edit / delete | Typed confirmation |
| 2.4 | Stream create / edit / delete, backup and restore | Typed confirmation |
| 2.5 | KV and Object Store writes | Typed confirmation |
| 2.6 | **Token scopes** (`read`, `write`) on the Integration API | Writes require a token explicitly created with `write`; default stays `read` |
| 2.7 | Extend audit entries with the mutation performed and its arguments | Writes must be reconstructable after the fact |

### Write boundary

The reason an agent can be pointed at production is structural, not procedural:

- `McpRuntimeData` **never** gains write members. Writes are not disabled in the MCP runtime;
  they are absent from the interface it is handed, so there is nothing to call.
- Write handlers live in `packages/server/src/routes.ts` and the CLI, and are reached only by an
  authenticated human session or a `write`-scoped token.
- No environment variable, config file or CLI flag may make a write reachable from
  `executeMcpTool`. A flag that could be flipped is worth nothing as a guarantee.

**Soon:** teams that genuinely want agent writes get a **separate opt-in binary**,
`natstrail-mcp-write`, published as its own package with its own runtime data interface. Installing
it is a deliberate act with a different name in the MCP client config. It is never a flag on
`natstrail-mcp`, because the value of the read-only claim is precisely that it cannot be toggled.

## Phase 3 — Extend the lead

Uncontested ground. Phase 0 buys the audience for this.

| # | Task | Why it matters |
|---|---|---|
| 3.1 | **Publish the MCP server** to the MCP registry, npm and Smithery | The differentiator is currently invisible. Highest-return item in this phase |
| 3.2 | **Subject and schema discovery tool** — "what subjects exist and what shape are their payloads" | Nobody has it. An agent cannot debug a topology it must be told about first |
| 3.3 | **Flow reconstruction** — render a trace as its causal chain (`source.created → refresh.started → etl.failed → dlq`) | The events are already collected and ordered; this is the demo that sells the product |
| 3.4 | **Health summary tool** — "what is broken right now": consumers with growing pending, DLQ rate spikes, redelivery counts | Turns the agent from a query runner into a diagnostician |
| 3.5 | More integrations on the Sentry pattern: Grafana, Datadog, PagerDuty | Each one is an entry point from a tool teams already run |
| 3.6 | Indexed search over stream history | Removes the `maxScan` ceiling. Large; only worth it once 3.1-3.4 have users |

---

## Explicitly not doing

- **Competing with NUI on GUI breadth.** It is public domain, has 650+ stars and ships desktop
  binaries for three platforms. Matching it feature for feature is unwinnable solo and would not
  differentiate anything.
- **Cluster administration and topology management.** That is Synadia Control Plane's product.
- **Agent writes behind a flag.** See [Write boundary](#write-boundary).
