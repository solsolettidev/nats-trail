import {
  connect,
  credsAuthenticator,
  nkeyAuthenticator,
  AckPolicy,
  DeliverPolicy,
  type NatsConnection,
  type ConnectionOptions,
  type ConsumerConfig,
  type JetStreamManager,
} from "nats";
import { readFileSync } from "node:fs";
import {
  normalizeError,
  normalizeScan,
  parseMessage,
  truncateText,
  type Context,
  type ConsumerSpec,
  type KvBucket,
  type KvEntry,
  type StreamSpec,
  type ObjectBucket,
  type ObjectEntry,
  type ConnectionState,
  type Stream,
  type StreamQuery,
  type StreamQueryPage,
  type Consumer,
  type Message,
  type QueryWarning,
} from "@nats-trail/core";

const decoder = new TextDecoder();

/**
 * One managed NATS connection bound to a single context. Owns connection state,
 * JetStream access and status tracking. The UI never touches NATS directly.
 */
class ManagedConnection {
  private nc: NatsConnection | null = null;
  private state: ConnectionState = {
    status: "disconnected",
    contextId: null,
    url: null,
    error: null,
    reconnects: 0,
  };

  getState(): ConnectionState {
    return { ...this.state };
  }

  getConnection(): NatsConnection | null {
    return this.nc;
  }

  async connectTo(ctx: Context): Promise<ConnectionState> {
    await this.disconnect();
    this.state = {
      status: "connecting",
      contextId: ctx.id,
      url: ctx.url,
      error: null,
      reconnects: 0,
    };
    try {
      this.nc = await connect(toConnectionOptions(ctx));
      this.state.status = "connected";
      this.watchStatus(this.nc);
    } catch (err) {
      const e = normalizeError(err);
      this.state = {
        status: "error",
        contextId: ctx.id,
        url: ctx.url,
        error: e.message,
        reconnects: 0,
      };
    }
    return this.getState();
  }

  async disconnect(): Promise<void> {
    if (this.nc) {
      try {
        await this.nc.close();
      } catch {
        /* ignore */
      }
      this.nc = null;
    }
    this.state = {
      status: "disconnected",
      contextId: null,
      url: null,
      error: null,
      reconnects: 0,
    };
  }

  private watchStatus(nc: NatsConnection): void {
    (async () => {
      for await (const s of nc.status()) {
        if (s.type === "reconnect") {
          this.state.reconnects += 1;
          this.state.status = "connected";
          this.state.error = null;
        } else if (s.type === "disconnect") {
          this.state.status = "connecting";
        } else if (s.type === "error") {
          this.state.status = "error";
          this.state.error = String(s.data ?? "connection error");
        }
      }
      // iterator ends when the connection is closed
      if (this.nc === nc) {
        this.state.status = "disconnected";
      }
    })().catch(() => {
      this.state.status = "error";
    });
  }

  async listStreams(): Promise<Stream[]> {
    const jsm = await this.requireJsm();
    const out: Stream[] = [];
    for await (const si of jsm.streams.list()) {
      out.push(toStream(si));
    }
    return out;
  }

  /**
   * Concrete subjects that actually carry messages in a stream, with counts.
   *
   * A stream declares subject patterns (`orders.>`); this reports what really
   * arrived (`orders.created`, `orders.paid`), which is what an agent needs to
   * explore a topology nobody documented for it.
   */
  async streamSubjects(stream: string): Promise<Record<string, number>> {
    const jsm = await this.requireJsm();
    const info = await jsm.streams.info(stream, { subjects_filter: ">" });
    return info.state.subjects ?? {};
  }

  async listConsumers(stream: string): Promise<Consumer[]> {
    const jsm = await this.requireJsm();
    const out: Consumer[] = [];
    for await (const ci of jsm.consumers.list(stream)) {
      const errors = consumerIssues(ci.num_ack_pending, ci.num_redelivered, ci.cluster?.replicas?.some((r) => !r.current) ?? false);
      out.push({
        name: ci.name,
        stream,
        durableName: ci.config.durable_name ?? null,
        pending: ci.num_pending,
        ackPending: ci.num_ack_pending,
        redelivered: ci.num_redelivered,
        lastDelivered: ci.delivered?.stream_seq ?? null,
        deliveryKind: ci.config.deliver_subject ? "push" : "pull",
        filterSubjects:
          ci.config.filter_subjects ??
          (ci.config.filter_subject ? [ci.config.filter_subject] : []),
        state: errors.length ? "warning" : "ok",
        errors,
      });
    }
    return out;
  }

  /**
   * List Key/Value buckets. KV is backed by streams named `KV_<bucket>`, so the
   * bucket list is derived from the stream list rather than opening every
   * bucket, which keeps this a single round trip.
   */
  async listKvBuckets(): Promise<KvBucket[]> {
    const jsm = await this.requireJsm();
    const out: KvBucket[] = [];
    for await (const si of jsm.streams.list()) {
      const name = si.config.name;
      if (!name.startsWith("KV_")) continue;
      out.push({
        name: name.slice(3),
        values: si.state.messages,
        bytes: si.state.bytes,
        history: si.config.max_msgs_per_subject,
        ttl: Number(si.config.max_age),
        storage: String(si.config.storage),
        replicas: si.config.num_replicas,
        stream: name,
      });
    }
    return out;
  }

  /**
   * List the live keys of a bucket with their current values, bounded by
   * `limit`. Values follow the same truncation rules as stream messages.
   */
  async listKvEntries(bucket: string, limit: number): Promise<KvEntry[]> {
    const kv = await this.requireKv(bucket);
    // Drain the key iterator before fetching any value: it is backed by a
    // consumer, and issuing another JetStream request mid-iteration ends it
    // early, which silently returns just the first key.
    const names: string[] = [];
    const keys = await kv.keys();
    for await (const key of keys) {
      names.push(key);
      if (names.length >= limit) break;
    }
    const out: KvEntry[] = [];
    for (const key of names) {
      const entry = await kv.get(key);
      if (entry) out.push(toKvEntry(bucket, entry));
    }
    return out;
  }

  /**
   * Full revision history for one key, oldest first. Includes `DEL`/`PURGE`
   * tombstones, which are what make a disappearing value explainable.
   */
  async kvHistory(bucket: string, key: string, limit: number): Promise<KvEntry[]> {
    const kv = await this.requireKv(bucket);
    const out: KvEntry[] = [];
    const history = await kv.history({ key });
    for await (const entry of history) {
      out.push(toKvEntry(bucket, entry));
    }
    // Keep the most recent revisions when the history exceeds the budget.
    return out.slice(-limit);
  }

  private async requireKv(bucket: string) {
    if (!this.nc || this.state.status !== "connected") {
      throw new Error("Not connected to NATS");
    }
    return this.nc.jetstream().views.kv(bucket, { bindOnly: true });
  }

  /**
   * List Object Store buckets. Like KV, these are streams (`OBJ_<bucket>`), so
   * the list is derived from the stream list in a single round trip.
   */
  async listObjectBuckets(): Promise<ObjectBucket[]> {
    const jsm = await this.requireJsm();
    const out: ObjectBucket[] = [];
    for await (const si of jsm.streams.list()) {
      const name = si.config.name;
      if (!name.startsWith("OBJ_")) continue;
      // Every object writes exactly one metadata message under `$O.<bucket>.M.>`,
      // so counting those subjects counts objects without reading any payload.
      // `streams.list()` never carries subject detail, hence the extra info call.
      const detail = await jsm.streams.info(name, { subjects_filter: "$O.*.M.>" }).catch(() => null);
      out.push({
        name: name.slice(4),
        description: si.config.description ?? "",
        objects: detail?.state.subjects ? Object.keys(detail.state.subjects).length : 0,
        bytes: si.state.bytes,
        ttl: Number(si.config.max_age),
        storage: String(si.config.storage),
        replicas: si.config.num_replicas,
        stream: name,
      });
    }
    return out;
  }

  /** List object metadata in a bucket. Object payloads are never read here. */
  async listObjects(bucket: string, limit: number): Promise<ObjectEntry[]> {
    if (!this.nc || this.state.status !== "connected") {
      throw new Error("Not connected to NATS");
    }
    const os = await this.nc.jetstream().views.os(bucket);
    const infos = await os.list();
    return infos.slice(0, limit).map((info) => ({
      bucket,
      name: info.name,
      description: info.description ?? "",
      size: info.size,
      chunks: info.chunks,
      digest: info.digest,
      deleted: info.deleted,
      timestamp: Date.parse(info.mtime) || 0,
    }));
  }

  // ---- Mutations ----------------------------------------------------------
  //
  // These live on the connection, are reached only from the mutation routes,
  // and are deliberately absent from the interface handed to the MCP runtime.

  /** Publish a message to a subject. Core NATS, no JetStream ack expected. */
  async publish(subject: string, payload: string, headers?: Record<string, string>): Promise<void> {
    if (!this.nc || this.state.status !== "connected") throw new Error("Not connected to NATS");
    const encoded = new TextEncoder().encode(payload);
    if (headers && Object.keys(headers).length > 0) {
      const { headers: makeHeaders } = await import("nats");
      const h = makeHeaders();
      for (const [key, value] of Object.entries(headers)) h.set(key, value);
      this.nc.publish(subject, encoded, { headers: h });
    } else {
      this.nc.publish(subject, encoded);
    }
    await this.nc.flush();
  }

  /** Request/reply against a subject, with a bounded wait. */
  async request(subject: string, payload: string, timeoutMs: number): Promise<Message> {
    if (!this.nc || this.state.status !== "connected") throw new Error("Not connected to NATS");
    const reply = await this.nc.request(subject, new TextEncoder().encode(payload), { timeout: timeoutMs });
    return parseMessage({
      subject: reply.subject,
      data: decoder.decode(reply.data),
      bytes: reply.data,
      timestamp: Date.now(),
      size: reply.data.length,
    });
  }

  /**
   * Create a stream, or update it when it already exists.
   *
   * JetStream rejects some changes on a live stream (storage and retention among
   * them); the error is surfaced rather than smoothed over, because silently
   * ignoring a requested change is worse than refusing it.
   */
  async upsertStream(spec: StreamSpec): Promise<Stream> {
    const jsm = await this.requireJsm();
    const config = toStreamConfig(spec);
    const exists = await jsm.streams.info(spec.name).then(() => true).catch(() => false);
    const info = exists ? await jsm.streams.update(spec.name, config) : await jsm.streams.add(config);
    return toStream(info);
  }

  /** Create a consumer, or update it when it already exists. */
  async upsertConsumer(stream: string, spec: ConsumerSpec): Promise<Consumer> {
    const jsm = await this.requireJsm();
    const config = toConsumerConfig(spec);
    const exists = await jsm.consumers.info(stream, spec.name).then(() => true).catch(() => false);
    if (exists) await jsm.consumers.update(stream, spec.name, config);
    else await jsm.consumers.add(stream, config);
    const consumers = await this.listConsumers(stream);
    const found = consumers.find((c) => c.name === spec.name);
    if (!found) throw new Error(`consumer was not created: ${spec.name}`);
    return found;
  }

  /**
   * Set a key. Returns the new revision.
   *
   * Optimistic concurrency: pass `expectedRevision` to fail rather than clobber
   * a value that changed since it was read.
   */
  async kvPut(bucket: string, key: string, value: string, expectedRevision?: number): Promise<number> {
    const kv = await this.requireKv(bucket);
    const encoded = new TextEncoder().encode(value);
    if (expectedRevision != null) {
      return kv.update(key, encoded, expectedRevision);
    }
    return kv.put(key, encoded);
  }

  /**
   * Store an object from a string payload.
   *
   * Deliberately not a streaming upload: the bridge is a debugging tool, and
   * accepting arbitrary-size bodies through it would make it a file transfer
   * service with the memory profile of one.
   */
  async objectPut(bucket: string, name: string, value: string, description?: string): Promise<ObjectEntry> {
    if (!this.nc || this.state.status !== "connected") throw new Error("Not connected to NATS");
    const os = await this.nc.jetstream().views.os(bucket);
    const data = new TextEncoder().encode(value);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    const info = await os.put({ name, description }, stream);
    return {
      bucket,
      name: info.name,
      description: info.description ?? "",
      size: info.size,
      chunks: info.chunks,
      digest: info.digest,
      deleted: info.deleted,
      timestamp: Date.parse(info.mtime) || 0,
    };
  }

  /** Delete an object. Its chunks go; a metadata tombstone remains. */
  async objectDelete(bucket: string, name: string): Promise<void> {
    if (!this.nc || this.state.status !== "connected") throw new Error("Not connected to NATS");
    const os = await this.nc.jetstream().views.os(bucket);
    await os.delete(name);
  }

  /** Delete a key, leaving a `DEL` tombstone its history can show. */
  async kvDelete(bucket: string, key: string): Promise<void> {
    const kv = await this.requireKv(bucket);
    await kv.delete(key);
  }

  /** Purge a key, discarding its history entirely. */
  async kvPurge(bucket: string, key: string): Promise<void> {
    const kv = await this.requireKv(bucket);
    await kv.purge(key);
  }

  /** Purge a stream, optionally limited to one subject or keeping N messages. */
  async purgeStream(stream: string, opts: { subject?: string; keep?: number }): Promise<number> {
    const jsm = await this.requireJsm();
    // The client models purge options as a union of mutually exclusive shapes,
    // and an empty object matches none of them, so omit the argument entirely
    // when purging everything.
    const result =
      opts.keep != null
        ? await jsm.streams.purge(stream, opts.subject ? { filter: opts.subject, keep: opts.keep } : { keep: opts.keep })
        : opts.subject
          ? await jsm.streams.purge(stream, { filter: opts.subject })
          : await jsm.streams.purge(stream);
    return result.purged;
  }

  /** Delete one message by stream sequence. */
  async deleteMessage(stream: string, seq: number): Promise<boolean> {
    const jsm = await this.requireJsm();
    return jsm.streams.deleteMessage(stream, seq);
  }

  /** Delete a consumer. */
  async deleteConsumer(stream: string, consumer: string): Promise<boolean> {
    const jsm = await this.requireJsm();
    return jsm.consumers.delete(stream, consumer);
  }

  /** Delete a stream, and everything in it. */
  async deleteStream(stream: string): Promise<boolean> {
    const jsm = await this.requireJsm();
    return jsm.streams.delete(stream);
  }

  async getStreamMessage(stream: string, seq: number): Promise<Message | null> {
    const jsm = await this.requireJsm();
    const msg = await getDirectMessage(jsm, stream, seq);
    return msg ? directToMessage(msg) : null;
  }

  /**
   * Scan one stream through a temporary ephemeral consumer (ack-none), filtered
   * server-side by subject and bounded by a scan budget. Messages are fetched in
   * batches instead of one round trip per sequence, so this works on large
   * streams. Returns a cursor (next stream sequence) when the scan stopped
   * before the end of the window.
   */
  async queryStreamMessages(query: StreamQuery): Promise<StreamQueryPage> {
    const jsm = await this.requireJsm();
    const nc = this.nc!;
    const info = await jsm.streams.info(query.stream);
    const firstSeq = info.state.first_seq;
    const lastSeq = info.state.last_seq;
    const maxScan = normalizeScan(query.maxScan);
    const warnings: QueryWarning[] = [];

    if (info.state.messages === 0 || (query.startSeq != null && query.startSeq > lastSeq)) {
      return { messages: [], nextCursor: null, scanned: 0, warnings };
    }

    const cfg: Partial<ConsumerConfig> = {
      ack_policy: AckPolicy.None,
      inactive_threshold: 30_000_000_000, // 30s in ns; teardown also deletes it
    };
    if (query.subject) cfg.filter_subject = query.subject;
    if (query.startSeq != null) {
      cfg.deliver_policy = DeliverPolicy.StartSequence;
      cfg.opt_start_seq = Math.max(query.startSeq, firstSeq);
    } else if (query.fromTs != null) {
      cfg.deliver_policy = DeliverPolicy.StartTime;
      cfg.opt_start_time = new Date(query.fromTs).toISOString();
    } else {
      // No explicit window: bound the scan to the most recent maxScan sequences.
      const startSeq = Math.max(firstSeq, lastSeq - maxScan + 1);
      cfg.deliver_policy = DeliverPolicy.StartSequence;
      cfg.opt_start_seq = startSeq;
      if (startSeq > firstSeq) {
        warnings.push({
          code: "query.window_default",
          message: `Scanned only the most recent ${maxScan} sequences (${startSeq}-${lastSeq}). Pass fromTs or cursor to inspect older history.`,
        });
      }
    }

    const ci = await jsm.consumers.add(query.stream, cfg);
    const consumer = await nc.jetstream().consumers.get(query.stream, ci.name);
    const messages: Message[] = [];
    let scanned = 0;
    let nextCursor: string | null = null;
    try {
      scan: while (scanned < maxScan && messages.length < query.limit) {
        const batch = await consumer.fetch({
          max_messages: Math.min(500, maxScan - scanned),
          expires: 2000,
        });
        let delivered = 0;
        let drained = false;
        for await (const m of batch) {
          delivered++;
          scanned++;
          const ts = m.info?.timestampNanos ? Math.round(m.info.timestampNanos / 1e6) : Date.now();
          // Stream order is chronological, so past the window end nothing else matches.
          if (query.toTs != null && ts > query.toTs) break scan;
          messages.push(
            parseMessage({
              subject: m.subject,
              data: decoder.decode(m.data),
              bytes: m.data,
              timestamp: ts,
              size: m.data.length,
              seq: m.seq,
            }),
          );
          const more = (m.info?.pending ?? 0) > 0;
          if (messages.length >= query.limit) {
            if (more) nextCursor = String(m.seq + 1);
            break scan;
          }
          if (scanned >= maxScan) {
            if (more) {
              nextCursor = String(m.seq + 1);
              warnings.push({
                code: "query.scan_truncated",
                message: `Scan stopped after ${scanned} messages; continue with cursor ${m.seq + 1}.`,
              });
            }
            break scan;
          }
          if (!more) {
            drained = true;
            break;
          }
        }
        if (delivered === 0 || drained) break;
      }
    } finally {
      await jsm.consumers.delete(query.stream, ci.name).catch(() => {});
    }
    return { messages, nextCursor, scanned, warnings };
  }

  private async requireJsm(): Promise<JetStreamManager> {
    if (!this.nc || this.state.status !== "connected") {
      throw new Error("Not connected to NATS");
    }
    return this.nc.jetstreamManager();
  }
}

function toConnectionOptions(ctx: Context): ConnectionOptions {
  const opts: ConnectionOptions = {
    servers: ctx.url,
    name: `nats-trail/${ctx.name}`,
    timeout: 5000,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  };
  if (ctx.auth.type === "userpass") {
    opts.user = ctx.auth.username;
    opts.pass = ctx.auth.password;
  } else if (ctx.auth.type === "token") {
    opts.token = ctx.auth.token;
  } else if (ctx.auth.type === "creds" && ctx.auth.credsPath) {
    opts.authenticator = credsAuthenticator(readFileSync(ctx.auth.credsPath));
  } else if (ctx.auth.type === "nkey" && ctx.auth.nkeySeed) {
    opts.authenticator = nkeyAuthenticator(new TextEncoder().encode(ctx.auth.nkeySeed.trim()));
  }
  if (ctx.tls.enabled) {
    opts.tls = {};
    if (ctx.tls.caPath) opts.tls.caFile = ctx.tls.caPath;
    if (ctx.tls.serverName) (opts.tls as typeof opts.tls & { servername?: string }).servername = ctx.tls.serverName;
  }
  return opts;
}

interface DirectMessageLike {
  subject: string;
  data: Uint8Array;
  seq: number;
  time?: Date;
  timestamp?: Date;
  info?: { timestampNanos?: number };
}

async function getDirectMessage(jsm: JetStreamManager, stream: string, seq: number): Promise<DirectMessageLike | null> {
  const streams = jsm.streams as unknown as {
    getMessage: (stream: string, query: { seq: number }) => Promise<DirectMessageLike | null>;
  };
  return streams.getMessage(stream, { seq });
}

/** NATS durations are nanoseconds; the product speaks milliseconds. */
const NANOS_PER_MS = 1e6;

interface StreamInfoLike {
  config: {
    name: string;
    subjects?: string[];
    retention: unknown;
    storage: unknown;
    num_replicas: number;
    max_age: number;
    max_msgs: number;
    max_bytes: number;
    discard: unknown;
  };
  state: {
    messages: number;
    bytes: number;
    last_ts?: string;
    first_seq: number;
    last_seq: number;
  };
}

/**
 * An empty stream reports last_ts as the zero time (`0001-01-01T00:00:00Z`),
 * which parses to a valid but absurd negative epoch. Treat anything before the
 * unix epoch as "no messages yet" rather than rendering a year-1 date.
 */
function parseStreamTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The single place a JetStream StreamInfo becomes a core Stream. */
function toStream(si: StreamInfoLike): Stream {
  return {
    name: si.config.name,
    subjects: si.config.subjects ?? [],
    messages: si.state.messages,
    bytes: si.state.bytes,
    lastTs: parseStreamTimestamp(si.state.last_ts),
    firstSeq: si.state.first_seq,
    lastSeq: si.state.last_seq,
    retention: String(si.config.retention),
    storage: String(si.config.storage),
    replicas: si.config.num_replicas,
    maxAge: Math.round(Number(si.config.max_age) / NANOS_PER_MS),
    maxMessages: si.config.max_msgs,
    maxBytes: si.config.max_bytes,
    discard: String(si.config.discard),
  };
}

/**
 * Translate a StreamSpec into a JetStream config, omitting anything the caller
 * left unset so create keeps server defaults and update keeps current values.
 */
function toStreamConfig(spec: StreamSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: spec.name,
    subjects: spec.subjects,
  };
  if (spec.retention) config.retention = spec.retention;
  if (spec.storage) config.storage = spec.storage;
  if (spec.replicas != null) config.num_replicas = spec.replicas;
  if (spec.maxAge != null) config.max_age = spec.maxAge * NANOS_PER_MS;
  if (spec.maxMessages != null) config.max_msgs = spec.maxMessages;
  if (spec.maxBytes != null) config.max_bytes = spec.maxBytes;
  if (spec.discard) config.discard = spec.discard;
  if (spec.description) config.description = spec.description;
  return config;
}

/** Same for a consumer. Durable by name, since ephemeral ones cannot be managed. */
function toConsumerConfig(spec: ConsumerSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    durable_name: spec.name,
    ack_policy: spec.ackPolicy ?? "explicit",
  };
  const subjects = (spec.filterSubjects ?? []).filter(Boolean);
  if (subjects.length === 1) config.filter_subject = subjects[0];
  else if (subjects.length > 1) config.filter_subjects = subjects;
  if (spec.deliverPolicy) config.deliver_policy = spec.deliverPolicy;
  if (spec.startSeq != null) config.opt_start_seq = spec.startSeq;
  if (spec.startTime != null) config.opt_start_time = new Date(spec.startTime).toISOString();
  if (spec.ackWait != null) config.ack_wait = spec.ackWait * NANOS_PER_MS;
  if (spec.maxDeliver != null) config.max_deliver = spec.maxDeliver;
  if (spec.description) config.description = spec.description;
  return config;
}

function directToMessage(msg: DirectMessageLike): Message {
  return parseMessage({
    subject: msg.subject,
    data: decoder.decode(msg.data),
    bytes: msg.data,
    timestamp: msg.info?.timestampNanos ? Math.round(msg.info.timestampNanos / 1e6) : (msg.time ?? msg.timestamp ?? new Date()).getTime(),
    size: msg.data.length,
    seq: msg.seq,
  });
}

/** Shape a nats KV entry into the core `KvEntry`, mirroring message truncation. */
function toKvEntry(bucket: string, entry: KvEntryLike): KvEntry {
  const raw = entry.value ? decoder.decode(entry.value) : "";
  const { value, truncated } = truncateText(raw);
  let json: unknown = null;
  let isJson = false;
  if (!truncated && value) {
    try {
      json = JSON.parse(value);
      isJson = true;
    } catch {
      // Not JSON; the raw value is already in `value`.
    }
  }
  return {
    bucket,
    key: entry.key,
    value,
    truncated,
    json,
    isJson,
    revision: entry.revision,
    timestamp: entry.created instanceof Date ? entry.created.getTime() : Date.now(),
    operation: entry.operation === "DEL" || entry.operation === "PURGE" ? entry.operation : "PUT",
  };
}

interface KvEntryLike {
  key: string;
  value: Uint8Array | null;
  revision: number;
  created: Date;
  operation: string;
}

function consumerIssues(ackPending: number, redelivered: number, replicaLag: boolean): string[] {
  const issues: string[] = [];
  if (ackPending > 0) issues.push(`${ackPending} ack pending`);
  if (redelivered > 0) issues.push(`${redelivered} redelivered`);
  if (replicaLag) issues.push("replica lag");
  return issues;
}

/**
 * Connection pool keyed by contextId. Each context owns an independent NATS
 * connection, so an agent inspecting one context never disconnects another
 * caller (e.g. the UI watching prod) from its context.
 */
class ConnectionPool {
  private connections = new Map<string, ManagedConnection>();

  async connect(ctx: Context): Promise<ConnectionState> {
    const existing = this.connections.get(ctx.id);
    if (existing?.getState().status === "connected") return existing.getState();
    const conn = existing ?? new ManagedConnection();
    this.connections.set(ctx.id, conn);
    return conn.connectTo(ctx);
  }

  async disconnect(contextId: string): Promise<void> {
    const conn = this.connections.get(contextId);
    this.connections.delete(contextId);
    await conn?.disconnect();
  }

  getState(contextId: string | null): ConnectionState {
    if (contextId) {
      const conn = this.connections.get(contextId);
      if (conn) return conn.getState();
    }
    return { status: "disconnected", contextId, url: null, error: null, reconnects: 0 };
  }

  getStates(): ConnectionState[] {
    return [...this.connections.values()].map((conn) => conn.getState());
  }

  isConnected(contextId: string): boolean {
    return this.connections.get(contextId)?.getState().status === "connected";
  }

  getConnection(contextId: string | null): NatsConnection | null {
    return contextId ? (this.connections.get(contextId)?.getConnection() ?? null) : null;
  }

  listStreams(contextId: string): Promise<Stream[]> {
    return this.require(contextId).listStreams();
  }

  listConsumers(contextId: string, stream: string): Promise<Consumer[]> {
    return this.require(contextId).listConsumers(stream);
  }

  streamSubjects(contextId: string, stream: string): Promise<Record<string, number>> {
    return this.require(contextId).streamSubjects(stream);
  }

  // ---- Mutations ----------------------------------------------------------

  publish(contextId: string, subject: string, payload: string, headers?: Record<string, string>): Promise<void> {
    return this.require(contextId).publish(subject, payload, headers);
  }

  request(contextId: string, subject: string, payload: string, timeoutMs: number): Promise<Message> {
    return this.require(contextId).request(subject, payload, timeoutMs);
  }

  upsertStream(contextId: string, spec: StreamSpec): Promise<Stream> {
    return this.require(contextId).upsertStream(spec);
  }

  upsertConsumer(contextId: string, stream: string, spec: ConsumerSpec): Promise<Consumer> {
    return this.require(contextId).upsertConsumer(stream, spec);
  }

  kvPut(contextId: string, bucket: string, key: string, value: string, expectedRevision?: number): Promise<number> {
    return this.require(contextId).kvPut(bucket, key, value, expectedRevision);
  }

  objectPut(contextId: string, bucket: string, name: string, value: string, description?: string): Promise<ObjectEntry> {
    return this.require(contextId).objectPut(bucket, name, value, description);
  }

  objectDelete(contextId: string, bucket: string, name: string): Promise<void> {
    return this.require(contextId).objectDelete(bucket, name);
  }

  kvDelete(contextId: string, bucket: string, key: string): Promise<void> {
    return this.require(contextId).kvDelete(bucket, key);
  }

  kvPurge(contextId: string, bucket: string, key: string): Promise<void> {
    return this.require(contextId).kvPurge(bucket, key);
  }

  purgeStream(contextId: string, stream: string, opts: { subject?: string; keep?: number }): Promise<number> {
    return this.require(contextId).purgeStream(stream, opts);
  }

  deleteMessage(contextId: string, stream: string, seq: number): Promise<boolean> {
    return this.require(contextId).deleteMessage(stream, seq);
  }

  deleteConsumer(contextId: string, stream: string, consumer: string): Promise<boolean> {
    return this.require(contextId).deleteConsumer(stream, consumer);
  }

  deleteStream(contextId: string, stream: string): Promise<boolean> {
    return this.require(contextId).deleteStream(stream);
  }

  listKvBuckets(contextId: string): Promise<KvBucket[]> {
    return this.require(contextId).listKvBuckets();
  }

  listObjectBuckets(contextId: string): Promise<ObjectBucket[]> {
    return this.require(contextId).listObjectBuckets();
  }

  listObjects(contextId: string, bucket: string, limit: number): Promise<ObjectEntry[]> {
    return this.require(contextId).listObjects(bucket, limit);
  }

  listKvEntries(contextId: string, bucket: string, limit: number): Promise<KvEntry[]> {
    return this.require(contextId).listKvEntries(bucket, limit);
  }

  kvHistory(contextId: string, bucket: string, key: string, limit: number): Promise<KvEntry[]> {
    return this.require(contextId).kvHistory(bucket, key, limit);
  }

  getStreamMessage(contextId: string, stream: string, seq: number): Promise<Message | null> {
    return this.require(contextId).getStreamMessage(stream, seq);
  }

  queryStreamMessages(contextId: string, query: StreamQuery): Promise<StreamQueryPage> {
    return this.require(contextId).queryStreamMessages(query);
  }

  private require(contextId: string): ManagedConnection {
    const conn = this.connections.get(contextId);
    if (!conn) throw new Error(`Not connected to NATS: ${contextId || "no context"}`);
    return conn;
  }
}

export const connectionPool = new ConnectionPool();
