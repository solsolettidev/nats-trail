import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredContextIds,
  loadDeclaredConfig,
  mergeContexts,
} from "../packages/server/dist/declared-config.js";

const dir = mkdtempSync(join(tmpdir(), "nats-trail-cfg-"));

/** Write a config file and load it, so each test states its own input. */
function load(config) {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
  return loadDeclaredConfig(path);
}

const context = (over = {}) => ({
  id: "prod",
  name: "Production",
  environment: "prod",
  url: "nats://nats:4222",
  ...over,
});

test("no config path means nothing declared, which is not an error", () => {
  const result = loadDeclaredConfig(undefined);
  assert.deepEqual(result.contexts, []);
  assert.deepEqual(result.errors, []);
});

test("a missing file is reported rather than ignored", () => {
  const result = loadDeclaredConfig(join(dir, "does-not-exist.json"));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /does not exist/);
});

test("invalid JSON is reported with the parser's reason", () => {
  const result = load("{ not json");
  assert.equal(result.contexts.length, 0);
  assert.match(result.errors[0], /not valid JSON/);
});

test("a declared context is loaded whole", () => {
  const result = load({ contexts: [context({ monitorUrl: "http://mon:8222" })] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.contexts.length, 1);
  assert.equal(result.contexts[0].id, "prod");
  assert.equal(result.contexts[0].monitorUrl, "http://mon:8222");
});

test("environment variables are interpolated, keeping secrets out of the file", () => {
  process.env.TEST_NATS_PASSWORD = "s3cr3t";
  const result = load({
    contexts: [context({ auth: { type: "userpass", username: "svc", password: "${TEST_NATS_PASSWORD}" } })],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.contexts[0].auth.password, "s3cr3t");
  delete process.env.TEST_NATS_PASSWORD;
});

test("an unset variable is an error, not an empty string", () => {
  const result = load({
    contexts: [context({ auth: { type: "userpass", username: "svc", password: "${DEFINITELY_UNSET_VAR}" } })],
  });
  assert.equal(
    result.errors.some((e) => /DEFINITELY_UNSET_VAR is not set/.test(e)),
    true,
    "connecting with a silently empty password is worse than failing to start",
  );
  assert.equal(result.contexts.length, 0, "and the context must not be usable");
});

test("interpolation reaches nested values and arrays", () => {
  process.env.TEST_NATS_HOST = "nats.internal";
  const result = load({
    contexts: [context({ url: "nats://${TEST_NATS_HOST}:4222" })],
    correlationKeys: [{ name: "trace_id", headers: ["${TEST_NATS_HOST}"] }],
  });
  assert.equal(result.contexts[0].url, "nats://nats.internal:4222");
  assert.deepEqual(result.correlationKeys[0].headers, ["nats.internal"]);
  delete process.env.TEST_NATS_HOST;
});

test("an invalid context is rejected with its reason, not silently dropped", () => {
  const result = load({ contexts: [{ id: "bad", name: "Bad", url: "http://not-nats:4222" }] });
  assert.equal(result.contexts.length, 0);
  assert.match(result.errors[0], /contexts\[0\]/);
});

test("a declared context must carry an id, since it is addressed by one", () => {
  const result = load({ contexts: [{ name: "No Id", url: "nats://h:4222" }] });
  assert.equal(result.contexts.length, 0);
  assert.match(result.errors[0], /id is required/);
});

test("invalid correlation keys are rejected as a set", () => {
  const result = load({ correlationKeys: [{ name: "broken" }] });
  assert.deepEqual(result.correlationKeys, [], "a key that looks nowhere would never match");
  assert.equal(result.errors.length > 0, true);
});

test("declaredContextIds lists what the API must refuse to change", () => {
  const config = load({ contexts: [context(), context({ id: "staging", environment: "staging" })] });
  assert.deepEqual([...declaredContextIds(config)].sort(), ["prod", "staging"]);
});

test("declared contexts win over stored ones with the same id", () => {
  const declared = [context({ url: "nats://declared:4222" })];
  const stored = [context({ url: "nats://stored:4222" }), context({ id: "local", url: "nats://local:4222" })];
  const merged = mergeContexts(declared, stored);

  assert.equal(merged.length, 2, "the duplicate id collapses");
  assert.equal(merged.find((c) => c.id === "prod").url, "nats://declared:4222", "the file is reasserted");
  assert.equal(merged.find((c) => c.id === "local").url, "nats://local:4222", "and local additions survive");
});

test("merging with nothing declared leaves stored contexts alone", () => {
  const stored = [context({ id: "local" })];
  assert.deepEqual(mergeContexts([], stored), stored);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
