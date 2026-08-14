import { monitoringUrl, type Context, type ServerConnection, type ServerHealth } from "@nats-trail/core";

/** Requests to the monitoring port are capped so a wedged server cannot hang a panel. */
const TIMEOUT_MS = 4000;

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`monitoring endpoint ${path} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

function resolveBase(ctx: Context): string {
  const base = monitoringUrl(ctx);
  if (!base) throw new Error(`cannot derive a monitoring URL from ${ctx.url}`);
  return base;
}

/**
 * Read server health from the HTTP monitoring port. This is a separate endpoint
 * from the client connection, so it can be unreachable even while NATS itself
 * works — the error says so rather than pretending the server is down.
 */
export async function fetchServerHealth(ctx: Context): Promise<ServerHealth> {
  const base = resolveBase(ctx);
  const varz = await getJson<VarzResponse>(base, "/varz");
  // JetStream may be disabled; a failing jsz must not fail the whole panel.
  const jsz = await getJson<JszResponse>(base, "/jsz").catch(() => null);

  return {
    serverId: varz.server_id ?? "",
    serverName: varz.server_name ?? "",
    version: varz.version ?? "",
    uptime: varz.uptime ?? "",
    host: varz.host ?? "",
    port: varz.port ?? 0,
    connections: varz.connections ?? 0,
    totalConnections: varz.total_connections ?? 0,
    subscriptions: varz.subscriptions ?? 0,
    inMsgs: varz.in_msgs ?? 0,
    outMsgs: varz.out_msgs ?? 0,
    inBytes: varz.in_bytes ?? 0,
    outBytes: varz.out_bytes ?? 0,
    slowConsumers: varz.slow_consumers ?? 0,
    memory: varz.mem ?? 0,
    cpu: varz.cpu ?? 0,
    routes: varz.routes ?? 0,
    leafNodes: varz.leafnodes ?? 0,
    jetstream: jsz
      ? {
          streams: jsz.streams ?? 0,
          consumers: jsz.consumers ?? 0,
          messages: jsz.messages ?? 0,
          bytes: jsz.bytes ?? 0,
          memory: jsz.memory ?? 0,
          storage: jsz.storage ?? 0,
        }
      : null,
  };
}

/** List client connections, newest activity first, bounded by `limit`. */
export async function fetchServerConnections(ctx: Context, limit: number): Promise<ServerConnection[]> {
  const base = resolveBase(ctx);
  const connz = await getJson<ConnzResponse>(base, `/connz?limit=${Math.max(1, Math.min(limit, 1000))}&subs=false`);
  return (connz.connections ?? []).map((c) => ({
    cid: c.cid ?? 0,
    kind: c.kind ?? "Client",
    type: c.type ?? "",
    ip: c.ip ?? "",
    port: c.port ?? 0,
    name: c.name ?? "",
    language: c.lang ?? "",
    version: c.version ?? "",
    rtt: c.rtt ?? "",
    uptime: c.uptime ?? "",
    idle: c.idle ?? "",
    subscriptions: c.subscriptions ?? 0,
    inMsgs: c.in_msgs ?? 0,
    outMsgs: c.out_msgs ?? 0,
    pendingBytes: c.pending_bytes ?? 0,
  }));
}

interface VarzResponse {
  server_id?: string;
  server_name?: string;
  version?: string;
  uptime?: string;
  host?: string;
  port?: number;
  connections?: number;
  total_connections?: number;
  subscriptions?: number;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  slow_consumers?: number;
  mem?: number;
  cpu?: number;
  routes?: number;
  leafnodes?: number;
}

interface JszResponse {
  streams?: number;
  consumers?: number;
  messages?: number;
  bytes?: number;
  memory?: number;
  storage?: number;
}

interface ConnzResponse {
  connections?: {
    cid?: number;
    kind?: string;
    type?: string;
    ip?: string;
    port?: number;
    name?: string;
    lang?: string;
    version?: string;
    rtt?: string;
    uptime?: string;
    idle?: string;
    subscriptions?: number;
    in_msgs?: number;
    out_msgs?: number;
    pending_bytes?: number;
  }[];
}
