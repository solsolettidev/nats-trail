import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPath,
  isDlqSubject,
  matchFilter,
  monitoringUrl,
  parseDlqEvent,
  parseMessage,
  sanitizeContext,
  subjectMatches,
  validateContext,
} from "../packages/core/dist/index.js";

const message = (over = {}) =>
  parseMessage({
    subject: "orders.created",
    data: JSON.stringify({ type: "orders.created", total: 100 }),
    timestamp: 1_000,
    size: 40,
    ...over,
  });

test("subjectMatches implements NATS wildcards", () => {
  assert.equal(subjectMatches("orders.created", "orders.created"), true);
  assert.equal(subjectMatches("orders.*", "orders.created"), true);
  assert.equal(subjectMatches("orders.*", "orders.created.eu"), false, "* matches exactly one token");
  assert.equal(subjectMatches("orders.>", "orders.created.eu"), true, "> matches the rest");
  assert.equal(subjectMatches("orders.>", "orders"), false);
  assert.equal(subjectMatches("orders.created", "orders"), false, "a longer pattern cannot match a shorter subject");
  assert.equal(subjectMatches("orders", "orders.created"), false);
  assert.equal(subjectMatches("*.created", "orders.created"), true);
});

test("getPath reads nested values and tolerates missing branches", () => {
  const value = { a: { b: { c: 42 } }, n: null };
  assert.equal(getPath(value, "a.b.c"), 42);
  assert.equal(getPath(value, "a.b.missing"), undefined);
  assert.equal(getPath(value, "missing.deep.path"), undefined, "must not throw on absent branches");
  assert.equal(getPath(value, "n"), null);
});

test("matchFilter combines subject, time, text and event type", () => {
  const m = message();
  assert.equal(matchFilter({ id: "f", name: "f" }, m), true, "an empty filter matches everything");
  assert.equal(matchFilter({ id: "f", name: "f", subject: "orders.*" }, m), true);
  assert.equal(matchFilter({ id: "f", name: "f", subject: "events.>" }, m), false);
  assert.equal(matchFilter({ id: "f", name: "f", fromTs: 2_000 }, m), false);
  assert.equal(matchFilter({ id: "f", name: "f", toTs: 500 }, m), false);
  assert.equal(matchFilter({ id: "f", name: "f", fromTs: 500, toTs: 2_000 }, m), true);
  assert.equal(matchFilter({ id: "f", name: "f", text: "ORDERS" }, m), true, "text match is case-insensitive");
  assert.equal(matchFilter({ id: "f", name: "f", text: "nope" }, m), false);
  assert.equal(matchFilter({ id: "f", name: "f", eventType: "orders.created" }, m), true, "bare value defaults to the type field");
  assert.equal(matchFilter({ id: "f", name: "f", eventType: "total=100" }, m), true);
  assert.equal(matchFilter({ id: "f", name: "f", eventType: "total=999" }, m), false);
});

test("matchFilter does not match an event type against a non-JSON payload", () => {
  const plain = message({ data: "not json" });
  assert.equal(matchFilter({ id: "f", name: "f", eventType: "orders.created" }, plain), false);
});

test("isDlqSubject recognises dead-letter naming", () => {
  assert.equal(isDlqSubject("orders.dlq"), true);
  assert.equal(isDlqSubject("ORDERS.DLQ"), true);
  assert.equal(isDlqSubject("events.dead.letter"), true);
  assert.equal(isDlqSubject("orders.created"), false);
});

test("parseDlqEvent extracts subject and reason from common shapes", () => {
  const event = parseDlqEvent(
    message({
      subject: "dlq.message.created",
      data: JSON.stringify({ original_subject: "bronze.etl.started", reason: "timeout" }),
    }),
  );
  assert.equal(event.originalSubject, "bronze.etl.started");
  assert.equal(event.reason, "timeout");
});

test("parseDlqEvent degrades gracefully on an unknown payload", () => {
  const event = parseDlqEvent(message({ subject: "dlq.x", data: "opaque" }));
  assert.equal(event.originalSubject, null);
  assert.equal(typeof event.reason === "string" || event.reason === null, true);
});

test("sanitizeContext strips every credential", () => {
  const clean = sanitizeContext({
    id: "prod",
    name: "Prod",
    environment: "prod",
    url: "nats://prod:4222",
    auth: { type: "userpass", username: "admin", password: "hunter2", token: "tok", credsPath: "/x.creds" },
    tls: { enabled: true, caPath: "/ca.pem" },
  });
  const serialized = JSON.stringify(clean);
  assert.equal(serialized.includes("hunter2"), false, "passwords must never leave the bridge");
  assert.equal(serialized.includes("tok"), false, "tokens must never leave the bridge");
  assert.equal(clean.auth.type, "userpass", "the auth type is kept so the UI can render it");
  assert.equal(clean.url, "nats://prod:4222");
});

test("validateContext rejects bad input and accepts good input", () => {
  assert.equal(validateContext({ name: "ok", url: "nats://h:4222" }).length, 0);
  assert.equal(validateContext({ name: "", url: "nats://h:4222" }).length > 0, true);
  assert.equal(validateContext({ name: "ok", url: "" }).length > 0, true);
  assert.equal(validateContext({ name: "ok", url: "http://h:4222" }).length > 0, true, "http is not a NATS scheme");
  assert.equal(validateContext({ name: "ok", url: "tls://h:4222" }).length, 0);
  assert.equal(validateContext({ name: "ok", url: "nats://h:4222", environment: "nope" }).length > 0, true);
});

test("monitoringUrl derives the monitoring port and honours an override", () => {
  assert.equal(monitoringUrl({ url: "nats://127.0.0.1:4222" }), "http://127.0.0.1:8222");
  assert.equal(monitoringUrl({ url: "tls://prod:4222" }), "https://prod:8222", "tls implies https monitoring");
  assert.equal(monitoringUrl({ url: "nats://user:pw@host:4222" }), "http://host:8222", "credentials are dropped");
  assert.equal(monitoringUrl({ url: "nats://[::1]:4222" }), "http://[::1]:8222");
  assert.equal(monitoringUrl({ url: "nonsense" }), null);
  assert.equal(monitoringUrl({ url: "nats://a:4222", monitorUrl: "http://mon:9999/" }), "http://mon:9999");
});

test("validateContext checks nkey seeds", () => {
  const base = { name: "ok", url: "nats://h:4222" };
  assert.equal(validateContext({ ...base, auth: { type: "nkey" } }).length > 0, true, "nkey needs a seed");
  assert.equal(validateContext({ ...base, auth: { type: "nkey", nkeySeed: "  " } }).length > 0, true);
  assert.equal(
    validateContext({ ...base, auth: { type: "nkey", nkeySeed: "not-a-seed" } }).length > 0,
    true,
    "a seed that is not shaped like one is rejected early, not at connect time",
  );
  assert.equal(
    validateContext({ ...base, auth: { type: "nkey", nkeySeed: "SUACBDINSB5BZ5YFKJEH276KOJEA4OXAFBM6WOVXMGGURS7NY7VRUSATAU" } }).length,
    0,
  );
});

test("sanitizeContext strips an nkey seed", () => {
  const clean = sanitizeContext({
    id: "x",
    name: "x",
    environment: "custom",
    url: "nats://h:4222",
    auth: { type: "nkey", nkeySeed: "SUACBDINSB5BZ5YFKJEH276KOJEA4OXAFBM6WOVXMGGURS7NY7VRUSATAU" },
    tls: { enabled: false },
  });
  assert.equal(JSON.stringify(clean).includes("SUACB"), false, "a seed is a credential and must never leave the bridge");
  assert.equal(clean.auth.type, "nkey");
});
