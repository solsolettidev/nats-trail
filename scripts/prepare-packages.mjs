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

Fourteen tools (\`natstrail.*\`) with explicit JSON input **and** output schemas, required result
limits capped at 200, cursors, scan budgets with truncation warnings, per-tool timeouts, and
structured error envelopes.

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

for (const [dir, readme] of Object.entries(readmes)) {
  const target = join(ROOT, "packages", dir);
  writeFileSync(join(target, "LICENSE"), license);
  writeFileSync(join(target, "README.md"), readme);
  console.log(`prepared packages/${dir}`);
}
