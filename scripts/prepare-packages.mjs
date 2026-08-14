#!/usr/bin/env node
/**
 * Give every published package a LICENSE and a README.
 *
 * npm always ships a root-level LICENSE/README from the package directory, but
 * a monorepo keeps only one of each at the repository root. Rather than commit
 * five drifting copies, generate them here and run this from `prepack`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/solsolettidev/nats-trail";
const RAW = "https://raw.githubusercontent.com/solsolettidev/nats-trail/master";
const license = readFileSync(join(ROOT, "LICENSE"), "utf8");

/** Package READMEs, keyed by directory under `packages/`. */
const readmes = {
  cli: `<p align="center">
  <img src="${RAW}/docs/assets/banner.svg" alt="NATS Trail" width="880">
</p>

# nats-trail

**Agent-native observability for NATS and JetStream.** A web UI, a CLI and an MCP server over one
bounded query engine, so humans and agents debug the same event bus from the same source of truth.

\`\`\`bash
npx nats-trail serve      # UI + API on http://127.0.0.1:4000
npx nats-trail trace --request-id req-8f21c --limit 20
\`\`\`

## Why

Every NATS GUI answers *"what is in this stream?"*. The hard question is **"why did this one flow
fail?"** — following a single \`request_id\` across four streams and a dead-letter subject. NATS Trail
answers that, and exposes the answer to agents as a typed, bounded, read-only tool contract.

<p align="center">
  <img src="${RAW}/docs/assets/trace.svg" alt="One request id traced across four streams" width="880">
</p>

## The agent surface is read-only by construction

\`executeMcpTool()\` receives an interface that exposes only read functions. There is no disabled
\`publish\` behind a feature flag — there is no \`publish\` to call. A misconfigured environment
variable cannot purge your production stream, because the code path does not exist.

That is the only reason it is reasonable to hand an agent a \`prod\` context.

## Commands

\`\`\`
serve            Start the API bridge and the web UI
contexts list    List configured contexts
streams list     List JetStream streams
messages search  Search messages through the Query Engine
trace            Trace by --request-id or --correlation-id
dlq search       Search dead-letter messages
mcp run <tool>   Run an MCP tool contract
\`\`\`

Run without arguments for an interactive shell, or \`nats-trail help\` for the full list.

Full documentation: [${REPO}](${REPO})

## License

Apache-2.0
`,
  core: `# @nats-trail/core

Shared query engine for [NATS Trail](${REPO}): stable result envelopes, mandatory limits,
truncation helpers, subject matching, filter evaluation, message parsing and error normalization.

No dependency on Express, React or the NATS client — this package decides how to parse, format and
bound data that the server adapts from NATS.

Install the product instead if you are not embedding it: \`npx nats-trail serve\`.

## License

Apache-2.0
`,
  mcp: `# @nats-trail/mcp

Read-only MCP tool contracts and stdio server for [NATS Trail](${REPO}).

\`\`\`bash
claude mcp add nats-trail -- npx -y @nats-trail/mcp
\`\`\`

Twenty-five \`natstrail.*\` tools with explicit JSON input **and** output schemas, required result
limits capped at 200, cursors, scan budgets with truncation warnings, per-tool timeouts, and
structured error envelopes.

Start here when the topology is unknown:

- \`discover_subjects\` — which subjects carry traffic, and the payload shape inferred from real messages
- \`reconstruct_flow\` — the causal chain behind one \`request_id\`, ending at the step that failed
- \`get_health_summary\` — what is broken right now, ranked worst first
- \`enrich_incident\` — flat incident context for Sentry, Grafana or Datadog

**The runtime cannot write.** It receives an interface exposing only read functions, so publish,
purge and delete are absent rather than disabled.

Set \`NATS_TRAIL_API\` to forward tool calls to a running bridge, and \`NATS_TRAIL_TOKEN\` when the
bridge has bearer auth enabled.

## License

Apache-2.0
`,
  server: `# @nats-trail/server

API bridge for [NATS Trail](${REPO}): Express + WebSocket. Owns NATS connections (pooled per
context), protects credentials, enforces limits and serves the built UI.

\`\`\`bash
npx nats-trail serve
\`\`\`

Exports \`startServer()\` for embedding. Binds to \`127.0.0.1\` by default because the local API is
unauthenticated and reads stored NATS credentials.

## License

Apache-2.0
`,
  ui: `# @nats-trail/ui

Prebuilt web UI for [NATS Trail](${REPO}). Static assets only — served by
\`@nats-trail/server\`, not meant to be imported.

\`\`\`bash
npx nats-trail serve
\`\`\`

## License

Apache-2.0
`,
};

/**
 * Keep the MCP Registry manifest pinned to the package it describes.
 *
 * The registry verifies a server by matching `server.json`'s name to the
 * `mcpName` in the published package.json, and rejects a version that does not
 * exist on npm. Both are easy to forget on a release, so they are derived here
 * rather than maintained by hand.
 */
function syncMcpManifest() {
  const pkgPath = join(ROOT, "packages/mcp/package.json");
  const manifestPath = join(ROOT, "packages/mcp/server.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (!pkg.mcpName) throw new Error("packages/mcp/package.json is missing mcpName");
  if (manifest.name !== pkg.mcpName) {
    throw new Error(`server.json name (${manifest.name}) must equal package.json mcpName (${pkg.mcpName})`);
  }

  // The registry rejects a description over 100 characters, and it does so at
  // publish time — long after a release is otherwise finished.
  if (manifest.description.length > 100) {
    throw new Error(
      `server.json description is ${manifest.description.length} characters; the MCP Registry caps it at 100`,
    );
  }

  manifest.version = pkg.version;
  manifest.packages = manifest.packages.map((entry) => ({ ...entry, version: pkg.version }));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`synced server.json to ${pkg.version}`);
}

syncMcpManifest();

for (const [dir, readme] of Object.entries(readmes)) {
  const target = join(ROOT, "packages", dir);
  writeFileSync(join(target, "LICENSE"), license);
  writeFileSync(join(target, "README.md"), readme);
  console.log(`prepared packages/${dir}`);
}
