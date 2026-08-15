import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CORRELATION_KEYS,
  extractCorrelation,
  extractCorrelations,
  parseMessage,
  suggestCorrelationKeys,
  toAgentMessage,
} from "../packages/core/dist/index.js";

const msg = (body, headers) =>
  parseMessage({ subject: "s", data: JSON.stringify(body), headers, timestamp: 1 });

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

// ---- defaults --------------------------------------------------------------

test("the defaults only cover conventions with a specification behind them", () => {
  const names = DEFAULT_CORRELATION_KEYS.map((k) => k.name);
  assert.deepEqual(names, ["trace_id", "request_id", "correlation_id"]);
  // Business identifiers are configured, never guessed.
  assert.equal(names.some((n) => /order|tenant|customer|user/.test(n)), false);
});

// ---- W3C trace context -----------------------------------------------------

test("extractCorrelation pulls the trace id out of a traceparent header", () => {
  const key = DEFAULT_CORRELATION_KEYS.find((k) => k.name === "trace_id");
  assert.equal(extractCorrelation(msg({}, { traceparent: [TRACEPARENT] }), key), TRACE_ID);
});

test("traceparent matching ignores header casing", () => {
  const key = DEFAULT_CORRELATION_KEYS.find((k) => k.name === "trace_id");
  assert.equal(extractCorrelation(msg({}, { TraceParent: [TRACEPARENT] }), key), TRACE_ID);
});

test("a malformed or all-zero traceparent yields nothing", () => {
  const key = DEFAULT_CORRELATION_KEYS.find((k) => k.name === "trace_id");
  assert.equal(extractCorrelation(msg({}, { traceparent: ["garbage"] }), key), null);
  assert.equal(extractCorrelation(msg({}, { traceparent: ["00-tooshort-x-01"] }), key), null);
  assert.equal(
    extractCorrelation(msg({}, { traceparent: [`00-${"0".repeat(32)}-00f067aa0ba902b7-01`] }), key),
    null,
    "an all-zero trace id is the spec's invalid sentinel",
  );
});

test("the whole traceparent is not used as the id", () => {
  // Two spans of one trace differ in parent id; using the whole string would
  // stop them correlating.
  const key = DEFAULT_CORRELATION_KEYS.find((k) => k.name === "trace_id");
  const a = extractCorrelation(msg({}, { traceparent: [`00-${TRACE_ID}-aaaaaaaaaaaaaaaa-01`] }), key);
  const b = extractCorrelation(msg({}, { traceparent: [`00-${TRACE_ID}-bbbbbbbbbbbbbbbb-01`] }), key);
  assert.equal(a, b);
});

// ---- sources and precedence ------------------------------------------------

test("headers win over the payload", () => {
  const key = { name: "id", headers: ["X-Id"], paths: ["id"] };
  const found = extractCorrelation(msg({ id: "from-body" }, { "X-Id": ["from-header"] }), key);
  assert.equal(found, "from-header", "the protocol level is more authoritative than the body");
});

test("nested dotted paths are supported", () => {
  const key = { name: "order_id", paths: ["data.order.id"] };
  assert.equal(extractCorrelation(msg({ data: { order: { id: "ord-1" } } }), key), "ord-1");
});

test("numeric identifiers are accepted", () => {
  assert.equal(extractCorrelation(msg({ id: 4711 }), { name: "id", paths: ["id"] }), "4711");
});

test("paths are tried in order and missing ones are skipped", () => {
  const key = { name: "id", paths: ["missing", "also.missing", "req_id"] };
  assert.equal(extractCorrelation(msg({ req_id: "r9" }), key), "r9");
  assert.equal(extractCorrelation(msg({ other: "x" }), key), null);
});

test("extractCorrelations omits keys it did not find", () => {
  const found = extractCorrelations(msg({ request_id: "r1" }));
  assert.deepEqual(found, { request_id: "r1" });
  assert.equal("correlation_id" in found, false, "absent keys are omitted, not set to null");
});

test("extractCorrelations reads every configured key at once", () => {
  const found = extractCorrelations(msg({ request_id: "r1", correlation_id: "c1" }, { traceparent: [TRACEPARENT] }));
  assert.deepEqual(found, { trace_id: TRACE_ID, request_id: "r1", correlation_id: "c1" });
});

test("custom keys need no code change", () => {
  const keys = [{ name: "tenant", paths: ["meta.tenant_id"] }];
  assert.deepEqual(extractCorrelations(msg({ meta: { tenant_id: "acme" } }), keys), { tenant: "acme" });
});

// ---- agent envelope --------------------------------------------------------

test("toAgentMessage exposes correlations and keeps the named aliases", () => {
  const agent = toAgentMessage(msg({ request_id: "r1", correlation_id: "c1" }, { traceparent: [TRACEPARENT] }));
  assert.deepEqual(agent.correlations, { trace_id: TRACE_ID, request_id: "r1", correlation_id: "c1" });
  assert.equal(agent.requestId, "r1", "the alias must keep working for existing callers");
  assert.equal(agent.correlationId, "c1");
});

test("toAgentMessage accepts custom keys", () => {
  const agent = toAgentMessage(msg({ order_id: "ord-7" }), "S", 4096, [{ name: "order_id", paths: ["order_id"] }]);
  assert.deepEqual(agent.correlations, { order_id: "ord-7" });
  assert.equal(agent.requestId, null, "an unconfigured alias is null, not invented");
});

// ---- suggestion ------------------------------------------------------------

const field = (path, subject, values) => ({ path, subject, values });

test("suggestCorrelationKeys ranks by values that recur across subjects", () => {
  const suggestions = suggestCorrelationKeys([
    // Same four values on two subjects: this links messages.
    field("request_id", "a.created", ["r1", "r2", "r3", "r4"]),
    field("request_id", "a.done", ["r1", "r2", "r3", "r4"]),
    field("order_id", "a.created", ["o1", "o2", "o3", "o4"]),
  ]);
  assert.equal(suggestions[0].path, "request_id");
  assert.equal(suggestions[0].linkingValues, 4);
  assert.match(suggestions[0].reason, /recur across 2 subjects/);
});

test("suggestCorrelationKeys demotes unique-per-message fields that never link", () => {
  // Present on two subjects, but no value is ever shared: it identifies the
  // message, not a flow. This is the false positive worth avoiding.
  const suggestions = suggestCorrelationKeys([
    field("message_id", "a.created", ["m1", "m2", "m3", "m4"]),
    field("message_id", "a.done", ["m5", "m6", "m7", "m8"]),
    field("request_id", "a.created", ["r1", "r2", "r3", "r4"]),
    field("request_id", "a.done", ["r1", "r2", "r3", "r4"]),
  ]);
  assert.equal(suggestions[0].path, "request_id", "linking beats mere presence");
  const messageId = suggestions.find((s) => s.path === "message_id");
  assert.equal(messageId.linkingValues, 0);
  assert.match(messageId.reason, /identifies a message rather than a flow/);
});

test("suggestCorrelationKeys rejects timestamps outright", () => {
  // A timestamp is unique per message and present everywhere — exactly the
  // shape that fooled the first version of this heuristic.
  const suggestions = suggestCorrelationKeys([
    field("emitted_at", "a.created", ["2026-08-14T10:00:00Z", "2026-08-14T10:00:01Z", "2026-08-14T10:00:02Z", "2026-08-14T10:00:03Z"]),
    field("emitted_at", "a.done", ["2026-08-14T11:00:00Z", "2026-08-14T11:00:01Z", "2026-08-14T11:00:02Z", "2026-08-14T11:00:03Z"]),
  ]);
  assert.deepEqual(suggestions, []);

  // Also by name, so an epoch-millis field is caught too.
  const epoch = suggestCorrelationKeys([field("created_ts", "a", ["1786745067388", "1786745067389", "1786745067390", "1786745067391"])]);
  assert.deepEqual(epoch, []);
});

test("suggestCorrelationKeys explains a single-subject id rather than hiding it", () => {
  const [only] = suggestCorrelationKeys([field("order_id", "a.created", ["o1", "o2", "o3", "o4"])]);
  assert.equal(only.path, "order_id");
  assert.match(only.reason, /only seen on one subject/, "the user should judge, not be silently filtered");
});

test("suggestCorrelationKeys rejects low-cardinality category fields", () => {
  const suggestions = suggestCorrelationKeys([
    field("status", "a.created", ["ok", "ok", "ok", "failed", "ok", "failed"]),
    field("type", "a.created", ["created", "created", "created", "created"]),
  ]);
  assert.deepEqual(suggestions, [], "a status field identifies nothing");
});

test("suggestCorrelationKeys ignores fields with too few samples to judge", () => {
  assert.deepEqual(suggestCorrelationKeys([field("id", "a", ["x", "y"])]), []);
});
