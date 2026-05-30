import type {
  Context,
  ConnectionState,
  Stream,
  Consumer,
  Message,
} from "@nats-trail/core";

export type { Context, ConnectionState, Stream, Consumer, Message };

export interface Preferences {
  selectedContextId: string | null;
  lastSubject: string | null;
  recentSubjects: string[];
  favoriteSubjects: string[];
  recentStreams: string[];
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
    req<ConnectionState>("/connect", { method: "POST", body: JSON.stringify({ contextId }) }),
  disconnect: () => req<ConnectionState>("/disconnect", { method: "POST" }),

  listStreams: () => req<Stream[]>("/streams"),
  listConsumers: (stream: string) =>
    req<Consumer[]>(`/streams/${encodeURIComponent(stream)}/consumers`),
};

/** Pretty-print a message payload (JSON when possible). Mirrors core.formatPayload. */
export function formatPayload(m: Message): string {
  if (m.isJson) {
    try {
      return JSON.stringify(m.json, null, 2);
    } catch {
      return m.data;
    }
  }
  return m.data;
}
