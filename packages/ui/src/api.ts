import type {
  Context,
  ConnectionState,
  Filter,
  KvBucket,
  KvEntry,
  ObjectBucket,
  ObjectEntry,
  ServerConnection,
  ServerHealth,
  Stream,
  Consumer,
  Message,
} from "@nats-trail/core";

export type {
  Context,
  ConnectionState,
  Filter,
  KvBucket,
  KvEntry,
  ObjectBucket,
  ObjectEntry,
  ServerConnection,
  ServerHealth,
  Stream,
  Consumer,
  Message,
};

export interface Preferences {
  selectedContextId: string | null;
  lastSubject: string | null;
  recentSubjects: string[];
  favoriteSubjects: string[];
  recentStreams: string[];
  dlqSubjects: string[];
  messageViewerMode: "tree" | "raw";
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  listContexts: () => req<Context[]>("/contexts"),
  createContext: (ctx: Partial<Context>) =>
    req<Context>("/contexts", { method: "POST", body: JSON.stringify(ctx) }),
  deleteContext: (id: string) =>
    req<{ ok: boolean }>(`/contexts/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getPreferences: () => req<Preferences>("/preferences"),
  savePreferences: (p: Partial<Preferences>) =>
    req<Preferences>("/preferences", { method: "PUT", body: JSON.stringify(p) }),

  getConnection: () => req<ConnectionState>("/connection"),
  connect: (contextId: string) =>
    req<ConnectionState>("/connect", { method: "POST", body: JSON.stringify({ contextId, select: true }) }),
  disconnect: () => req<ConnectionState>("/disconnect", { method: "POST", body: JSON.stringify({}) }),

  listFilters: () => req<Filter[]>("/filters"),
  saveFilter: (filter: Partial<Filter>) =>
    req<Filter>("/filters", { method: "POST", body: JSON.stringify(filter) }),
  deleteFilter: (id: string) =>
    req<{ ok: boolean }>(`/filters/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listStreams: () => req<Stream[]>("/streams"),
  listConsumers: (stream: string) =>
    req<Consumer[]>(`/streams/${encodeURIComponent(stream)}/consumers`),

  listKvBuckets: () => req<KvBucket[]>("/kv"),
  listKvKeys: (bucket: string) =>
    req<KvEntry[]>(`/kv/${encodeURIComponent(bucket)}/keys`),
  kvHistory: (bucket: string, key: string) =>
    req<KvEntry[]>(`/kv/${encodeURIComponent(bucket)}/keys/${encodeURIComponent(key)}/history`),

  listObjectBuckets: () => req<ObjectBucket[]>("/obj"),
  listObjects: (bucket: string) =>
    req<ObjectEntry[]>(`/obj/${encodeURIComponent(bucket)}/objects`),

  serverHealth: () => req<ServerHealth>("/server/health"),
  serverConnections: () => req<ServerConnection[]>("/server/connections"),
};

export { formatPayload } from "@nats-trail/core";
