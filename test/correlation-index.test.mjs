import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store resolves its file from NATS_TRAIL_DATA at import time, so point it
// at a scratch directory before loading it.
const dir = mkdtempSync(join(tmpdir(), "nats-trail-index-"));
process.env.NATS_TRAIL_DATA = dir;

const { closeIndex, dropIndex, getCoverage, indexBatch, lookup, recordCoverage } = await import(
  "../packages/server/dist/correlation-index.js"
);
const { parseMessage } = await import("../packages/core/dist/index.js");

const KEYS = [
  { name: "request_id", paths: ["request_id"] },
  { name: "order_id", paths: ["order_id"] },
];

const msg = (seq, subject, body, timestamp = seq * 1000) =>
  parseMessage({ subject, data: JSON.stringify(body), seq, timestamp });

before(() => {
  indexBatch(
    "ctx",
    "ORDERS",
    [
      msg(1, "orders.created", { request_id: "r1", order_id: "o1" }),
      msg(2, "orders.paid", { request_id: "r1", order_id: "o1" }),
      msg(3, "orders.created", { request_id: "r2", order_id: "o2" }),
      msg(4, "orders.noise", { unrelated: "x" }),
    ],
    KEYS,
  );
  recordCoverage("ctx", "ORDERS", 1, 4);
});

after(() => {
  closeIndex();
  rmSync(dir, { recursive: true, force: true });
});

test("lookup finds every location for a value, oldest first", () => {
  const hits = lookup("ctx", "request_id", "r1", 10);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.seq), [1, 2]);
  assert.equal(hits[0].subject, "orders.created");
  assert.equal(hits[0].stream, "ORDERS");
});

test("lookup indexes every configured key independently", () => {
  assert.equal(lookup("ctx", "order_id", "o1", 10).length, 2);
  assert.equal(lookup("ctx", "order_id", "o2", 10).length, 1);
});

test("lookup respects the limit", () => {
  assert.equal(lookup("ctx", "request_id", "r1", 1).length, 1);
});

test("lookup returns nothing for an unknown value or key", () => {
  assert.deepEqual(lookup("ctx", "request_id", "nope", 10), []);
  assert.deepEqual(lookup("ctx", "not_a_key", "r1", 10), []);
});

test("contexts are isolated from each other", () => {
  assert.deepEqual(lookup("other-ctx", "request_id", "r1", 10), [], "one context must not see another's index");
});

test("messages carrying no configured key store nothing", () => {
  // seq 4 has neither request_id nor order_id.
  const all = lookup("ctx", "request_id", "r1", 100).concat(lookup("ctx", "order_id", "o1", 100));
  assert.equal(all.some((hit) => hit.seq === 4), false, "the index holds identifiers, not a copy of the stream");
});

test("coverage reports the range, entry count and keys seen", () => {
  const [coverage] = getCoverage("ctx");
  assert.equal(coverage.stream, "ORDERS");
  assert.equal(coverage.fromSeq, 1);
  assert.equal(coverage.toSeq, 4);
  // 3 messages x 2 keys each; the fourth carries none.
  assert.equal(coverage.entries, 6);
  assert.deepEqual(coverage.keys, ["order_id", "request_id"]);
});

test("coverage widens rather than replacing, so a second pass cannot shrink it", () => {
  recordCoverage("ctx", "ORDERS", 900, 1000);
  const [coverage] = getCoverage("ctx", "ORDERS");
  assert.equal(coverage.fromSeq, 1, "the earlier start must survive");
  assert.equal(coverage.toSeq, 1000, "the later end must win");
});

test("reindexing the same message does not duplicate entries", () => {
  const before = getCoverage("ctx", "ORDERS")[0].entries;
  indexBatch("ctx", "ORDERS", [msg(1, "orders.created", { request_id: "r1", order_id: "o1" })], KEYS);
  assert.equal(getCoverage("ctx", "ORDERS")[0].entries, before, "rebuilding must be idempotent");
});

test("a reindexed message reflects its new value", () => {
  indexBatch("ctx", "ORDERS", [msg(3, "orders.created", { request_id: "r2-corrected", order_id: "o2" })], KEYS);
  assert.deepEqual(lookup("ctx", "request_id", "r2", 10), [], "the stale value is gone");
  assert.equal(lookup("ctx", "request_id", "r2-corrected", 10).length, 1);
});

test("dropping one stream leaves the others intact", () => {
  indexBatch("ctx", "OTHER", [msg(1, "other.event", { request_id: "r9" })], KEYS);
  recordCoverage("ctx", "OTHER", 1, 1);
  assert.equal(getCoverage("ctx").length, 2);

  dropIndex("ctx", "OTHER");
  assert.equal(getCoverage("ctx").length, 1);
  assert.deepEqual(lookup("ctx", "request_id", "r9", 10), []);
  assert.equal(lookup("ctx", "request_id", "r1", 10).length, 2, "the other stream survives");
});

test("dropping a whole context clears everything", () => {
  dropIndex("ctx");
  assert.deepEqual(getCoverage("ctx"), []);
  assert.deepEqual(lookup("ctx", "request_id", "r1", 10), []);
});
