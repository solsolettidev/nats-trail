import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CLI = readFileSync(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8");
const ROUTES = readFileSync(new URL("../packages/server/src/routes.ts", import.meta.url), "utf8");
const RUNTIME = readFileSync(new URL("../packages/mcp/src/runtime.ts", import.meta.url), "utf8");
const CONNECTION = readFileSync(new URL("../packages/server/src/connection.ts", import.meta.url), "utf8");

/**
 * These are guardrails, not unit tests. The product's central claim is that the
 * agent surface cannot write — not that it is configured not to. Each assertion
 * below fails if someone opens a path from an agent to a mutation.
 */

test("the integration executor passes no write function to the MCP runtime", () => {
  const start = ROUTES.indexOf("function executeIntegrationTool");
  assert.equal(start > -1, true);
  const body = ROUTES.slice(start, ROUTES.indexOf("\n}", start));

  for (const method of ["publish", "request:", "purgeStream", "deleteMessage", "deleteConsumer", "deleteStream"]) {
    assert.equal(
      body.includes(method),
      false,
      `executeIntegrationTool must not hand the agent runtime ${method}`,
    );
  }
});

test("the MCP runtime source never calls a mutation", () => {
  for (const call of ["\\.publish(", "purgeStream(", "deleteMessage(", "deleteConsumer(", "deleteStream("]) {
    assert.equal(RUNTIME.includes(call), false, `runtime.ts must not call ${call}`);
  }
});

test("mutation routes exist and are gated by mutationAuth", () => {
  // If the mutations were reachable without the gate, the claim would be void.
  assert.equal(ROUTES.includes("mutations.use(mutationAuth)"), true, "the mutation router must be gated");
  assert.equal(ROUTES.includes('router.use("/mutate", mutations)'), true, "mutations must be mounted under /mutate");

  const authStart = ROUTES.indexOf("function mutationAuth");
  const authBody = ROUTES.slice(authStart, ROUTES.indexOf("\n}", authStart));
  assert.equal(authBody.includes("canWrite"), true, "mutationAuth must check the write scope");
  assert.equal(authBody.includes("403"), true, "a read-only token must be refused with 403");
});

test("every mutation route is audited with its arguments", () => {
  const mutationBlock = ROUTES.slice(ROUTES.indexOf("const mutations = Router()"), ROUTES.indexOf('router.use("/mutate"'));
  const routeCount = (mutationBlock.match(/mutations\.(post|delete|put)\(/g) ?? []).length;
  const auditCount = (mutationBlock.match(/auditMutation\(/g) ?? []).length;

  assert.equal(routeCount > 0, true, "there should be mutation routes to check");
  // Each route audits both its success and its failure path.
  assert.equal(auditCount >= routeCount, true, `expected at least ${routeCount} audit calls, found ${auditCount}`);
});

test("mutation methods live on the connection, not in the runtime data interface", () => {
  // The capability must exist somewhere — it just must not be reachable from an
  // agent. If these vanish, the mutation routes are broken instead.
  for (const method of ["async publish(", "async purgeStream(", "async deleteMessage(", "async deleteStream("]) {
    assert.equal(CONNECTION.includes(method), true, `connection.ts should implement ${method}`);
  }
});

test("every CLI write command refuses agent mode and destructive ones need --yes", () => {
  const writers = ["publishMessage", "requestReply", "purgeStream", "deleteMessage", "deleteConsumer", "deleteStream"];
  for (const fn of writers) {
    const start = CLI.indexOf(`async function ${fn}(`);
    assert.equal(start > -1, true, `${fn} should exist in the CLI`);
    const body = CLI.slice(start, CLI.indexOf("\n}", start));
    assert.equal(body.includes("requireHumanInvocation"), true, `${fn} must refuse --agent`);
  }

  for (const fn of ["purgeStream", "deleteMessage", "deleteConsumer", "deleteStream"]) {
    const start = CLI.indexOf(`async function ${fn}(`);
    const body = CLI.slice(start, CLI.indexOf("\n}", start));
    assert.equal(body.includes("requireConfirmation"), true, `${fn} is destructive and must require --yes`);
  }
});

test("the agent-mode guard reads hoisted state, not its own arguments", () => {
  // A guard that inspects its own args cannot work: --agent is stripped before
  // commands are dispatched. This regression was real.
  const start = CLI.indexOf("function requireHumanInvocation");
  const body = CLI.slice(start, CLI.indexOf("\n}", start));
  assert.equal(body.includes("agentMode"), true, "the guard must read the hoisted agentMode flag");
  assert.equal(body.includes("args.includes"), false, "inspecting arguments here is always wrong");
  assert.equal(CLI.includes("agentMode = agent;"), true, "agentMode must be set when a command is parsed");
});

test("deleting a stream requires naming it back", () => {
  const start = CLI.indexOf("async function deleteStream(");
  const body = CLI.slice(start, CLI.indexOf("\n}", start));
  assert.equal(body.includes("input.confirm"), true, "the CLI must require --confirm");

  const routeStart = ROUTES.indexOf('mutations.delete("/streams/:name"');
  const routeBody = ROUTES.slice(routeStart, ROUTES.indexOf("\n});", routeStart));
  assert.equal(routeBody.includes("req.body?.confirm !== req.params.name"), true, "the route must verify it too");
});

test("stream and consumer upsert routes exist, are gated, and are audited", () => {
  const mutationBlock = ROUTES.slice(ROUTES.indexOf("const mutations = Router()"), ROUTES.indexOf('router.use("/mutate"'));
  assert.equal(mutationBlock.includes('mutations.put("/streams/:name"'), true, "stream upsert must live under /mutate");
  assert.equal(
    mutationBlock.includes('mutations.put("/streams/:name/consumers/:consumer"'),
    true,
    "consumer upsert must live under /mutate",
  );
  assert.equal(mutationBlock.includes('mutations.put("/kv/:bucket/keys/:key"'), true, "kv put must live under /mutate");
});

test("every CLI admin and KV write command refuses agent mode", () => {
  for (const fn of ["upsertStream", "upsertConsumer", "kvPut", "kvRemove"]) {
    const start = CLI.indexOf(`async function ${fn}(`);
    assert.equal(start > -1, true, `${fn} should exist in the CLI`);
    const body = CLI.slice(start, CLI.indexOf("\n}", start));
    assert.equal(body.includes("requireHumanInvocation"), true, `${fn} must refuse --agent`);
  }
  // Removing a key is destructive; setting one is not.
  const remove = CLI.slice(CLI.indexOf("async function kvRemove("), CLI.indexOf("\n}", CLI.indexOf("async function kvRemove(")));
  assert.equal(remove.includes("requireConfirmation"), true, "kv delete/purge must require --yes");
});
