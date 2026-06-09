import {
  connect,
  credsAuthenticator,
  type NatsConnection,
  type ConnectionOptions,
  type JetStreamManager,
} from "nats";
import { readFileSync } from "node:fs";
import {
  normalizeError,
  parseMessage,
  subjectMatches,
  type Context,
  type ConnectionState,
  type Stream,
  type Consumer,
  type Message,
} from "@nats-trail/core";

const decoder = new TextDecoder();

/**
 * Single active NATS connection for the process (v0). Owns connection state,
 * JetStream access and status tracking. The UI never touches NATS directly.
 */
class ConnectionManager {
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

  async searchStreamMessages(input: { stream: string; subject?: string; limit: number }): Promise<Message[]> {
    const streams = await this.listStreams();
    const stream = streams.find((item) => item.name === input.stream);
    if (!stream) return [];
    const out: Message[] = [];
    for (let seq = stream.lastSeq; seq >= stream.firstSeq && out.length < input.limit; seq--) {
      const msg = await this.getStreamMessage(stream.name, seq).catch(() => null);
      if (!msg) continue;
      if (input.subject && !subjectMatches(input.subject, msg.subject)) continue;
      out.push(msg);
    }
    return out;
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

export const connectionManager = new ConnectionManager();
