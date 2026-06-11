import {
  connect,
  credsAuthenticator,
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
  type Context,
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
      out.push({
        name: si.config.name,
        subjects: si.config.subjects ?? [],
        messages: si.state.messages,
        bytes: si.state.bytes,
        lastTs: si.state.last_ts ? Date.parse(si.state.last_ts) || null : null,
        firstSeq: si.state.first_seq,
        lastSeq: si.state.last_seq,
        retention: String(si.config.retention),
        storage: String(si.config.storage),
        replicas: si.config.num_replicas,
        maxAge: Number(si.config.max_age),
        maxMessages: si.config.max_msgs,
        maxBytes: si.config.max_bytes,
        discard: String(si.config.discard),
      });
    }
    return out;
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

function directToMessage(msg: DirectMessageLike): Message {
  return parseMessage({
    subject: msg.subject,
    data: decoder.decode(msg.data),
    timestamp: msg.info?.timestampNanos ? Math.round(msg.info.timestampNanos / 1e6) : (msg.time ?? msg.timestamp ?? new Date()).getTime(),
    size: msg.data.length,
    seq: msg.seq,
  });
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
