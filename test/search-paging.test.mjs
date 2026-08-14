import { test } from "node:test";
import assert from "node:assert/strict";
import { executeMcpTool } from "../packages/mcp/dist/index.js";
import { parseMessage } from "../packages/core/dist/index.js";

/**
 * A post-filter (free text, request id, a saved filter's event type) can only be
 * evaluated after a payload is read. Applying one to a single page of `limit`
 * messages reports "no matches" whenever the matches sit deeper in the stream.
 *
 * These tests pin that: the needle is deliberately placed near the end of a
 * stream far longer than the requested limit.
 */

const STREAM = "EVENTS";
const TOTAL = 1_200;
const NEEDLE_SEQ = 1_150;

/** A stream where exactly one message carries the needle, near the end. */
function fakeStream() {
  const messages = [];
  for (let seq = 1; seq <= TOTAL; seq++) {
    const body =
      seq === NEEDLE_SEQ
        ? { type: "etl.failed", error: "upstream 503", request_id: "req-needle" }
        : { type: "etl.ok", n: seq, request_id: `req-${seq}` };
    messages.push(
      parseMessage({ subject: seq === NEEDLE_SEQ ? "etl.failed" : "etl.ok", data: JSON.stringify(body), timestamp: seq * 1000, seq }),
    );
  }
  return messages;
}

/** Minimal runtime data that serves pages from an in-memory stream. */
function runtimeData(messages, extra = {}) {
  let calls = 0;
  return {
    data: {
      contexts: [],
      activeContextId: "ctx",
      queryStreamMessages: async ({ limit, startSeq, maxScan }) => {
        calls += 1;
        const from = startSeq ?? 1;
        const budget = Math.min(maxScan ?? messages.length, messages.length);
        const window = messages.filter((m) => m.seq >= from).slice(0, Math.min(limit, budget));
        const lastSeq = window.length ? window[window.length - 1].seq : from;
        const more = lastSeq < TOTAL;
        return {
          messages: window,
          scanned: window.length,
          nextCursor: more ? String(lastSeq + 1) : null,
          warnings: [],
        };
      },
      ...extra,
    },
    calls: () => calls,
  };
}

test("search_messages finds a deep text match despite a small limit", async () => {
  const { data, calls } = runtimeData(fakeStream());
  const envelope = await executeMcpTool(
    "natstrail.search_messages",
    { contextId: "ctx", stream: STREAM, text: "upstream 503", limit: 5 },
    data,
  );

  assert.deepEqual(envelope.errors, []);
  assert.equal(envelope.summary.returned, 1, "the needle at seq 1150 must be found with limit 5");
  assert.equal(envelope.results[0].seq, NEEDLE_SEQ);
  assert.equal(calls() > 1, true, "it must have paged rather than read one page");
});

test("search_messages finds a deep request_id match", async () => {
  const { data } = runtimeData(fakeStream());
  const envelope = await executeMcpTool(
    "natstrail.search_messages",
    { contextId: "ctx", stream: STREAM, requestId: "req-needle", limit: 3 },
    data,
  );
  assert.equal(envelope.summary.returned, 1);
  assert.equal(envelope.results[0].requestId, "req-needle");
});

test("search_messages without a post-filter reads one page and keeps its cursor", async () => {
  const { data, calls } = runtimeData(fakeStream());
  const envelope = await executeMcpTool(
    "natstrail.search_messages",
    { contextId: "ctx", stream: STREAM, limit: 5 },
    data,
  );
  assert.equal(envelope.summary.returned, 5);
  assert.equal(calls(), 1, "the unfiltered path must stay a single round trip");
  assert.equal(envelope.nextCursor, "6", "and must still hand back a resume cursor");
});

test("search_messages stops at the limit even when more match", async () => {
  // Every message carries request_id "req-<n>", so "req-" matches all of them.
  const { data } = runtimeData(fakeStream());
  const envelope = await executeMcpTool(
    "natstrail.search_messages",
    { contextId: "ctx", stream: STREAM, requestId: "req-", limit: 7 },
    data,
  );
  assert.equal(envelope.summary.returned, 7, "the limit is still a hard cap");
});

test("search_messages warns when the scan budget runs out before the limit", async () => {
  const { data } = runtimeData(fakeStream());
  const envelope = await executeMcpTool(
    "natstrail.search_messages",
    { contextId: "ctx", stream: STREAM, text: "upstream 503", limit: 50, maxScan: 100 },
    data,
  );
  assert.equal(envelope.summary.returned, 0, "the needle is beyond a 100-message budget");
  assert.equal(
    envelope.warnings.some((w) => w.code === "scan.budget_exhausted"),
    true,
    "an incomplete answer must not look complete",
  );
  assert.equal(envelope.nextCursor !== null, true, "and must be resumable");
});

test("run_filter pages the budget for a saved filter's text", async () => {
  const { data, calls } = runtimeData(fakeStream(), {
    filters: [{ id: "deep", name: "deep", stream: STREAM, text: "upstream 503" }],
  });
  const envelope = await executeMcpTool("natstrail.run_filter", { contextId: "ctx", filter: "deep", limit: 5 }, data);

  assert.deepEqual(envelope.errors, []);
  assert.equal(envelope.summary.returned, 1, "a saved filter must find deep matches too");
  assert.equal(envelope.results[0].seq, NEEDLE_SEQ);
  assert.equal(calls() > 1, true);
});

test("run_filter still reports a filter without a stream", async () => {
  const { data } = runtimeData(fakeStream(), { filters: [{ id: "nostream", name: "nostream" }] });
  const envelope = await executeMcpTool("natstrail.run_filter", { contextId: "ctx", filter: "nostream", limit: 5 }, data);
  assert.equal(envelope.errors.length, 1);
  assert.match(envelope.errors[0].message, /requires a stream/);
});
