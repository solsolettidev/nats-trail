# Roadmap

Ordered by priority. Phase 0 blocks adoption; phase 1 closes functional gaps against
[NUI](https://github.com/nats-nui/nui) and [natscli](https://github.com/nats-io/natscli); phase 2
makes NATS Trail a daily driver without giving up the agent guarantee; phase 3 is where nobody else
competes.

Nothing in phases 0-2 may weaken the rule in [Write boundary](#write-boundary).

---

## Phase 0 — Make it installable ✅

Nothing else matters until someone who is not the author can run this. Highest return per hour of
work in the whole document.

**Complete.** `npx nats-trail serve` works from a clean machine; the packages are on npm under
Apache-2.0; CI builds on Node 20 and 22.

| # | Task | Notes |
|---|---|---|
| 0.1 | Apache-2.0 `LICENSE` and `license` field in every manifest | **done** — without this nobody may legally use the project |
| 0.2 | Publish to npm | **done** — `nats-trail` and `@nats-trail/{core,mcp,ui,server}` v0.1.0 are live |
| 0.3 | `npx nats-trail serve` works from a clean machine | **done** — verified from a clean install: UI, API, 14 MCP tools and the `natstrail-mcp` stdio binary |
| 0.4 | Docker image + `docker-compose.yml` with a `nats-server -js` | **done** — multi-stage build, non-root, `/data` volume, healthcheck |
| 0.5 | Rename the primary binary to `nats-trail` | **done** — `nats-ui` is taken on npm by an unrelated package, so the alias was dropped rather than deprecated |
| 0.6 | GitHub Actions: typecheck + build on PR, publish on tag | **done** — CI on Node 20/22 with a serve smoke test; release workflow needs `NPM_TOKEN` |
| 0.7 | Screenshots of the UI in the README | **done** — four panels, seeded with `scripts/seed-demo.mjs` |

## Phase 1 — Functional parity ✅

The gaps a NATS user notices in the first ten minutes.

| # | Task | Why |
|---|---|---|
| 1.1 | **KV Store browsing**: buckets, entries, entry history | **done** — buckets, live keys, and per-key revision history including tombstones |
| 1.2 | **Object Store browsing**: buckets, objects, metadata | **done** — object metadata only; payloads are never streamed through the bridge |
| 1.3 | **Server and cluster health**: `varz`, `connz`, `jsz` panel | **done** — with a clear error when the monitoring port is unreachable but NATS is not |
| 1.4 | **Payload codecs** | **done** — binary detection, hex dump, base64, plus schema-less protobuf wire decoding and full msgpack decoding, with no runtime dependency. Protobuf field *names* still need a descriptor |
| 1.5 | **Request/reply** from the UI and CLI | **done** — shipped with the phase 2 write surface |
| 1.6 | Tests on the query engine, `matchFilter`, envelope limits and truncation | **done** — 67 tests, including guardrails on the write boundary. Found and fixed a real `>` wildcard bug |
| 1.7 | Bare nkey seed auth | **done** — validated at creation, stripped like every other credential; verified against a server configured with nkey auth |

## Phase 2 — Writes, on the human side only ✅

Makes NATS Trail a daily driver instead of a second panel. Every item lands in the UI and the CLI;
none of it reaches the MCP runtime.

| # | Task | Guard |
|---|---|---|
| 2.1 | Publish to a subject | **done** — typed environment confirmation on non-local contexts |
| 2.2 | Purge stream, delete message | **done** — confirmation dialog in the UI, `--yes` in the CLI, always audited |
| 2.3 | Consumer create / update / delete | **done** — durable by name; create and update are the same call |
| 2.4 | Stream create / update / delete, config export/import | **done** — delete must name the stream back; illegal live changes surface the server error. Binary snapshots are **out**: `nats.js` exposes no snapshot API, and moving message bytes through the bridge would make it a file transfer service |
| 2.5 | KV and Object Store writes | **done** — KV set with optimistic concurrency, delete leaving a tombstone, purge discarding history; object put and delete. Object put takes text, not a stream: the bridge is a debugging tool, not a file transfer service |
| 2.6 | **Token scopes** (`read`, `write`) | **done** — tokens are read-only unless granted `write`; a read token gets 403 |
| 2.7 | Audit mutations with their arguments | **done** — action, target and args, on success and failure |

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

## Phase 3 — Extend the lead ✅

Uncontested ground. Phase 0 buys the audience for this.

| # | Task | Why it matters |
|---|---|---|
| 3.1 | **Publish the MCP server** to the MCP registry | **done** — listed as `io.github.solsolettidev/nats-trail`, and republished automatically on every tag via `mcp-publisher login github-oidc`. **Smithery is out for now**: it no longer accepts an npm stdio package and requires building an `.mcpb` bundle, which is a separate distribution artifact rather than a config file |
| 3.2 | **Subject and schema discovery tool** | **done** — `natstrail.discover_subjects`: real subjects with counts, plus inferred field paths, types, presence and examples |
| 3.3 | **Flow reconstruction** | **done** — `natstrail.reconstruct_flow` plus a `Trace` tab that renders the chain and highlights the failing step |
| 3.4 | **Health summary tool** | **done** — `natstrail.get_health_summary`, ranked critical-first, with a "What is broken?" button in the UI |
| 3.5 | More integrations on the Sentry pattern | **done** — Sentry, Grafana, Datadog and PagerDuty. One `enrich_incident` tool builds a flat context; each route only reshapes it |
| 3.6 | Indexed search over stream history | **done** — opt-in per stream, backed by `node:sqlite` (hence the Node 22 floor), indexing the configured correlation keys and reporting the sequence range it covers. Building is human-only; querying is automatic |

---

## Open

| Task | Notes |
|---|---|
| Multi-user | Still a single-user local tool: `data/` on disk, no login, loopback binding. A team cannot share an instance. The one gap identified in the competitive review that has no decision behind it yet |
| Cluster awareness | Topology, supercluster and leaf-node visibility. Deliberately deferred rather than refused — see below |
| Smithery listing | Requires building an `.mcpb` bundle, a distribution artifact rather than a config file |
| Protobuf field *names* | Needs a per-subject schema registry. The wire format is decoded; only the names are missing |

---

## Explicitly not doing

- **Competing with NUI on GUI breadth.** It is public domain, has 650+ stars and ships desktop
  binaries for three platforms. Matching it feature for feature is unwinnable solo and would not
  differentiate anything.
- **Cluster administration and topology management.** That is Synadia Control Plane's product.
- **Agent writes behind a flag.** See [Write boundary](#write-boundary).
