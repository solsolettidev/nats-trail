#!/usr/bin/env node
/**
 * Seed a local NATS server with a realistic event-driven workload, so the UI
 * has something worth looking at. Development helper — never run against a
 * shared or production server.
 *
 *   node scripts/seed-demo.mjs [nats://127.0.0.1:4222]
 */
import { connect, AckPolicy } from "nats";

const URL = process.argv[2] ?? "nats://127.0.0.1:4222";
if (!/127\.0\.0\.1|localhost/.test(URL)) {
  console.error(`refusing to seed a non-local server: ${URL}`);
  process.exit(1);
}

const STREAMS = [
  { name: "SOURCE_EVENTS", subjects: ["source.>"] },
  { name: "ETL_EVENTS", subjects: ["bronze.>", "silver.>"] },
  { name: "ORDER_EVENTS", subjects: ["orders.>"] },
  { name: "DLQ_EVENTS", subjects: ["dlq.>"] },
];

const CONSUMERS = [
  { stream: "SOURCE_EVENTS", durable: "refresh-worker", filter: "source.refresh.>" },
  { stream: "ETL_EVENTS", durable: "bronze-loader", filter: "bronze.>" },
  { stream: "ORDER_EVENTS", durable: "order-projector", filter: "orders.>" },
];

const rid = (n) => `req-${n.toString(16).padStart(5, "0")}`;
const pick = (a, i) => a[i % a.length];

const nc = await connect({ servers: URL });
const jsm = await nc.jetstreamManager();
const js = nc.jetstream();

for (const s of STREAMS) {
  await jsm.streams.add({ name: s.name, subjects: s.subjects }).catch(() => {});
}
console.log(`streams: ${STREAMS.map((s) => s.name).join(", ")}`);

const SOURCES = ["salesforce", "hubspot", "postgres-prod", "s3-events", "stripe"];
const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1"];
let seq = 0;
let now = Date.now() - 45 * 60 * 1000;
const step = () => (now += 400 + Math.floor(Math.random() * 2600));

/** Publish one event, carrying the correlation ids in both headers and body. */
async function emit(subject, body, requestId, correlationId) {
  await js.publish(
    subject,
    new TextEncoder().encode(
      JSON.stringify({
        ...body,
        request_id: requestId,
        correlation_id: correlationId,
        emitted_at: new Date(step()).toISOString(),
      }),
    ),
  );
}

// Happy-path refresh flows.
for (let i = 0; i < 26; i++) {
  const requestId = rid(++seq);
  const correlationId = `corr-${pick(SOURCES, i)}`;
  const source = pick(SOURCES, i);
  await emit("source.created", { type: "source.created", source, region: pick(REGIONS, i) }, requestId, correlationId);
  await emit("source.refresh.started", { type: "source.refresh.started", source, rows: 1200 + i * 37 }, requestId, correlationId);
  await emit("bronze.etl.started", { type: "bronze.etl.started", source, partition: `dt=2026-08-13/h=${i % 24}` }, requestId, correlationId);
  await emit("bronze.etl.completed", { type: "bronze.etl.completed", source, rows_written: 1200 + i * 37, duration_ms: 3800 + i * 90 }, requestId, correlationId);
  await emit("source.refresh.completed", { type: "source.refresh.completed", source, status: "ok" }, requestId, correlationId);
}

// Failing flows that end in the dead-letter stream.
const FAILURES = [
  { reason: "connection timeout after 30000ms", code: "ETIMEDOUT" },
  { reason: "schema drift: column `amount_cents` changed int -> string", code: "ESCHEMA" },
  { reason: "upstream 503 from provider api", code: "EUPSTREAM" },
];
for (let i = 0; i < 3; i++) {
  const requestId = rid(++seq);
  const source = pick(SOURCES, i + 1);
  const correlationId = `corr-${source}`;
  const failure = FAILURES[i];
  await emit("source.created", { type: "source.created", source, region: pick(REGIONS, i) }, requestId, correlationId);
  await emit("source.refresh.started", { type: "source.refresh.started", source, rows: 8400 }, requestId, correlationId);
  await emit("bronze.etl.started", { type: "bronze.etl.started", source, partition: "dt=2026-08-13/h=17" }, requestId, correlationId);
  await emit("bronze.etl.failed", { type: "bronze.etl.failed", source, error: failure.reason, code: failure.code, attempt: 3, retries_exhausted: true }, requestId, correlationId);
  await emit("dlq.message.created", { type: "dlq.message.created", original_subject: "bronze.etl.started", reason: failure.reason, code: failure.code, source, attempts: 3 }, requestId, correlationId);
}

// Order traffic, so the Core panel has live-looking subjects.
for (let i = 0; i < 34; i++) {
  const requestId = rid(++seq);
  await emit("orders.created", { type: "orders.created", order_id: `ord-${2400 + i}`, total_cents: 1990 + i * 315, currency: "USD", items: 1 + (i % 4) }, requestId, `corr-ord-${2400 + i}`);
  if (i % 3 === 0) await emit("orders.paid", { type: "orders.paid", order_id: `ord-${2400 + i}`, processor: "stripe" }, requestId, `corr-ord-${2400 + i}`);
  if (i % 7 === 0) await emit("orders.failed", { type: "orders.failed", order_id: `ord-${2400 + i}`, error: "card_declined" }, requestId, `corr-ord-${2400 + i}`);
}

// Key/Value buckets: config, feature flags and a key with a visible history.
const kvConfig = await js.views.kv("app-config", { history: 10 });
for (const [key, value] of [
  ["etl.batch_size", { value: 5000, updated_by: "platform" }],
  ["etl.max_retries", { value: 3, updated_by: "platform" }],
  ["api.rate_limit", { value: 1200, window: "1m" }],
  ["features.new_pipeline", { enabled: false, rollout_pct: 0 }],
]) {
  await kvConfig.put(key, new TextEncoder().encode(JSON.stringify(value)));
}
// Same key edited repeatedly, then deleted: this is what history is for.
for (const pct of [5, 25, 60, 100]) {
  await kvConfig.put("features.new_pipeline", new TextEncoder().encode(JSON.stringify({ enabled: true, rollout_pct: pct })));
}
await kvConfig.put("etl.deprecated_flag", new TextEncoder().encode(JSON.stringify({ value: "legacy" })));
await kvConfig.delete("etl.deprecated_flag");

const kvLocks = await js.views.kv("worker-locks", { history: 3 });
for (const worker of ["refresh-worker", "bronze-loader"]) {
  await kvLocks.put(worker, new TextEncoder().encode(JSON.stringify({ holder: `pod-${worker}-7f9`, acquired_at: new Date().toISOString() })));
}

for (const c of CONSUMERS) {
  await jsm.consumers
    .add(c.stream, { durable_name: c.durable, ack_policy: AckPolicy.Explicit, filter_subject: c.filter })
    .catch(() => {});
}

// Leave the refresh-worker with visible pending work.
const sub = await js.consumers.get("SOURCE_EVENTS", "refresh-worker");
const batch = await sub.fetch({ max_messages: 20, expires: 2000 });
let acked = 0;
for await (const m of batch) {
  if (acked++ < 14) m.ack();
}

for (const s of STREAMS) {
  const info = await jsm.streams.info(s.name);
  console.log(`  ${s.name.padEnd(15)} ${String(info.state.messages).padStart(4)} messages`);
}
for (const bucket of ["app-config", "worker-locks"]) {
  const status = await (await js.views.kv(bucket, { bindOnly: true })).status();
  console.log(`  KV ${bucket.padEnd(12)} ${String(status.values).padStart(4)} revisions`);
}
console.log(`\nfailing request ids: ${[27, 28, 29].map(rid).join(", ")}`);

await nc.drain();
