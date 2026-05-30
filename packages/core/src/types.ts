// Core domain types shared by every interface (UI now; CLI and MCP later).

export type Environment = "local" | "dev" | "staging" | "prod" | "custom";

export type AuthType = "none" | "userpass" | "token" | "creds";

export interface ContextAuth {
  type: AuthType;
  username?: string;
  password?: string;
  token?: string;
  /** Path to a NATS .creds file (not the contents). */
  credsPath?: string;
}

export interface ContextTLS {
  enabled: boolean;
  /** Expected server name for verification. */
  serverName?: string;
  /** Path to a CA PEM file. */
  caPath?: string;
}

export interface Context {
  id: string;
  name: string;
  environment: Environment;
  url: string;
  auth: ContextAuth;
  tls: ContextTLS;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  contextId: string | null;
  url: string | null;
  /** Normalized error message when status is "error". */
  error: string | null;
  /** Reconnect attempts observed since connect. */
  reconnects: number;
}

export interface Message {
  id: string;
  subject: string;
  /** Epoch milliseconds when the message was received/stored. */
  timestamp: number;
  /** Raw payload as UTF-8 text (best effort). */
  data: string;
  /** Parsed JSON when the payload is valid JSON, otherwise null. */
  json: unknown | null;
  /** True when `json` is populated. */
  isJson: boolean;
  /** Payload size in bytes. */
  size: number;
  /** NATS reply subject, if any. */
  reply?: string;
  headers?: Record<string, string[]>;
  /** JetStream stream sequence when the message came from a stream. */
  seq?: number;
}

export interface Stream {
  name: string;
  subjects: string[];
  messages: number;
  bytes: number;
  /** Epoch milliseconds of the last stored message, or null. */
  lastTs: number | null;
  firstSeq: number;
  lastSeq: number;
}

export interface Consumer {
  name: string;
  stream: string;
  durableName: string | null;
  pending: number;
  /** Messages redelivered / awaiting ack. */
  ackPending: number;
  redelivered: number;
  lastDelivered: number | null;
  /** Push or pull. */
  deliveryKind: "push" | "pull";
  /** Subjects this consumer filters from its stream (empty = whole stream). */
  filterSubjects: string[];
}

/** A reusable, named search definition (used by saved filters and future CLI). */
export interface Filter {
  id: string;
  name: string;
  subject?: string;
  stream?: string;
  /** Free-text match against the payload. */
  text?: string;
  fromTs?: number;
  toTs?: number;
  /** Dotted path -> expected value, evaluated against parsed JSON. */
  eventType?: string;
}

export interface TraceStep {
  subject: string;
  timestamp: number;
  messageId: string;
}

export interface Trace {
  key: "request_id" | "correlation_id";
  value: string;
  steps: TraceStep[];
}

export interface DLQEvent {
  message: Message;
  reason: string | null;
  originalSubject: string | null;
}

/** Stable error shape returned by the API bridge and used by every interface. */
export interface NormalizedError {
  code: string;
  message: string;
  retriable: boolean;
}
