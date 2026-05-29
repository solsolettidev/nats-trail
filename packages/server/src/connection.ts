import {
  connect,
  type NatsConnection,
  type ConnectionOptions,
  type JetStreamManager,
} from "nats";
import {
  normalizeError,
  type Context,
  type ConnectionState,
  type Stream,
  type Consumer,
} from "@nats-trail/core";

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
      });
    }
    return out;
  }

  async listConsumers(stream: string): Promise<Consumer[]> {
    const jsm = await this.requireJsm();
    const out: Consumer[] = [];
    for await (const ci of jsm.consumers.list(stream)) {
      out.push({
        name: ci.name,
        stream,
        durableName: ci.config.durable_name ?? null,
        pending: ci.num_pending,
        ackPending: ci.num_ack_pending,
        redelivered: ci.num_redelivered,
        lastDelivered: ci.delivered?.stream_seq ?? null,
        deliveryKind: ci.config.deliver_subject ? "push" : "pull",
      });
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
  }
  if (ctx.tls.enabled) {
    opts.tls = {};
    if (ctx.tls.caPath) opts.tls.caFile = ctx.tls.caPath;
  }
  return opts;
}

export const connectionManager = new ConnectionManager();
