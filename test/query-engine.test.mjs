import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  MAX_SCAN,
  createQueryEnvelope,
  normalizeLimit,
  normalizeScan,
  parseCursor,
  truncateText,
} from "../packages/core/dist/index.js";

test("normalizeLimit clamps to the documented bounds", () => {
  assert.equal(normalizeLimit(20), 20);
  assert.equal(normalizeLimit(MAX_QUERY_LIMIT + 500), MAX_QUERY_LIMIT, "must cap at the max");
  assert.equal(normalizeLimit(0), DEFAULT_QUERY_LIMIT, "zero falls back rather than returning nothing");
  assert.equal(normalizeLimit(-5), DEFAULT_QUERY_LIMIT);
  assert.equal(normalizeLimit("30"), 30, "numeric strings arrive from CLI flags and query params");
  assert.equal(normalizeLimit(undefined), DEFAULT_QUERY_LIMIT);
  assert.equal(normalizeLimit(Number.NaN), DEFAULT_QUERY_LIMIT);
  assert.equal(normalizeLimit(7.9), 7, "fractional limits floor instead of throwing");
});

test("normalizeScan clamps the scan budget", () => {
  assert.equal(normalizeScan(500), 500);
  assert.equal(normalizeScan(MAX_SCAN * 10), MAX_SCAN);
  assert.equal(normalizeScan(-1), 10_000);
});

test("parseCursor accepts sequences and rejects everything else", () => {
  assert.equal(parseCursor(42), 42);
  assert.equal(parseCursor("42"), 42);
  assert.equal(parseCursor(0), undefined, "sequence 0 is not a valid resume point");
  assert.equal(parseCursor(""), undefined);
  assert.equal(parseCursor(null), undefined);
  assert.equal(parseCursor("abc"), undefined);
});

test("truncateText cuts on a utf-8 byte budget without splitting a character", () => {
  assert.deepEqual(truncateText("hello", 100), { value: "hello", truncated: false });

  const cut = truncateText("hello world", 5);
  assert.equal(cut.value, "hello");
  assert.equal(cut.truncated, true);

  // "é" is two bytes: a budget of 3 fits one, not two, and must not emit half.
  const accented = truncateText("ééé", 3);
  assert.equal(accented.value, "é");
  assert.equal(accented.truncated, true);
  assert.equal(Buffer.byteLength(accented.value, "utf8") <= 3, true);

  // Astral-plane characters are 4 bytes and must survive intact or be dropped.
  const emoji = truncateText("🚀🚀", 5);
  assert.equal(emoji.value, "🚀");
  assert.equal(emoji.truncated, true);
});

test("createQueryEnvelope never returns more than the limit and flags truncation", () => {
  const results = Array.from({ length: 10 }, (_, i) => i);
  const envelope = createQueryEnvelope({ query: { tool: "t" }, results, limit: 3 });

  assert.equal(envelope.results.length, 3);
  assert.equal(envelope.summary.returned, 3);
  assert.equal(envelope.summary.limit, 3);
  assert.equal(envelope.summary.truncated, true, "callers must be able to tell results were cut");
  assert.equal(envelope.query.limit, 3, "the effective limit is echoed back in the query");
  assert.equal(envelope.nextCursor, null);
  assert.deepEqual(envelope.errors, []);
  assert.deepEqual(envelope.warnings, []);
});

test("createQueryEnvelope reports no truncation when everything fits", () => {
  const envelope = createQueryEnvelope({ query: {}, results: [1, 2], limit: 10 });
  assert.equal(envelope.summary.truncated, false);
  assert.equal(envelope.summary.returned, 2);
});

test("createQueryEnvelope enforces the cap even when a caller asks for more", () => {
  const results = Array.from({ length: MAX_QUERY_LIMIT + 50 }, (_, i) => i);
  const envelope = createQueryEnvelope({ query: {}, results, limit: MAX_QUERY_LIMIT + 50 });
  assert.equal(envelope.results.length, MAX_QUERY_LIMIT, "an agent cannot opt out of the cap");
  assert.equal(envelope.summary.truncated, true);
});

test("createQueryEnvelope carries warnings and errors through", () => {
  const envelope = createQueryEnvelope({
    query: {},
    results: [],
    limit: 10,
    warnings: [{ code: "scan.truncated", message: "partial" }],
    errors: [{ code: "x", message: "boom", retriable: true }],
  });
  assert.equal(envelope.warnings.length, 1);
  assert.equal(envelope.errors[0].retriable, true);
});
