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
  /**
   * HTTP monitoring endpoint. Defaults to the connection host on port 8222,
   * which is the NATS convention; set it when the server publishes monitoring
   * somewhere else.
   */
  monitorUrl?: string;
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

/**
 * How a payload should be read.
 *
 * `binary` means the bytes are not valid UTF-8 text, so `data` is lossy and
 * `hex` / `base64` are the only faithful representations.
 */
export type PayloadEncoding = "json" | "text" | "binary";

export interface Message {
  id: string;
  subject: string;
  /** Epoch milliseconds when the message was received/stored. */
  timestamp: number;
  /** Raw payload as UTF-8 text. Lossy when `encoding` is `binary`. */
  data: string;
  /** Parsed JSON when the payload is valid JSON, otherwise null. */
  json: unknown | null;
  /** True when `json` is populated. */
  isJson: boolean;
  encoding: PayloadEncoding;
  /** Space-separated hex bytes, only for binary payloads and capped in length. */
  hex?: string;
  /** Base64 of the payload, only for binary payloads and capped in length. */
  base64?: string;
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
  retention: string;
  storage: string;
  replicas: number;
  maxAge: number;
  maxMessages: number;
  maxBytes: number;
  discard: string;
}

/** A JetStream Key/Value bucket. */
export interface KvBucket {
  name: string;
  /**
   * Stored revisions, not live keys: a bucket keeping history holds several
   * revisions per key, and deletes are tombstones that still count. Matches
   * what `nats kv info` reports as "Values".
   */
  values: number;
  bytes: number;
  /** Revisions kept per key. */
  history: number;
  /** Per-key TTL in nanoseconds, 0 when unset. */
  ttl: number;
  storage: string;
  replicas: number;
  /** The stream backing this bucket (`KV_<name>`). */
  stream: string;
}

/** One revision of a key. `value` follows the same truncation rules as messages. */
export interface KvEntry {
  bucket: string;
  key: string;
  value: string;
  /** True when `value` was cut to the payload cap. */
  truncated: boolean;
  /** Parsed payload when the value is JSON. */
  json: unknown;
  isJson: boolean;
  revision: number;
  timestamp: number;
  /** `PUT` for a live value, `DEL`/`PURGE` for a tombstone. */
  operation: "PUT" | "DEL" | "PURGE";
}

/** A JetStream Object Store bucket. */
export interface ObjectBucket {
  name: string;
  description: string;
  /** Stored objects, excluding deleted ones. */
  objects: number;
  bytes: number;
  /** Bucket-wide TTL in nanoseconds, 0 when unset. */
  ttl: number;
  storage: string;
  replicas: number;
  /** The stream backing this bucket (`OBJ_<name>`). */
  stream: string;
}

/**
 * Metadata for one stored object. The payload itself is never streamed here.
 * Mirrors what the Object Store list API actually returns — notably there is no
 * per-object revision, unlike KV.
 */
export interface ObjectEntry {
  bucket: string;
  name: string;
  description: string;
  size: number;
  chunks: number;
  /** Algorithm-prefixed checksum, e.g. `SHA-256=…`. */
  digest: string;
  deleted: boolean;
  timestamp: number;
}

/** Server health, read from the NATS HTTP monitoring port (`varz` + `jsz`). */
export interface ServerHealth {
  serverId: string;
  serverName: string;
  version: string;
  /** Uptime exactly as the server formats it, e.g. `"1h43m21s"`. */
  uptime: string;
  host: string;
  port: number;
  connections: number;
  totalConnections: number;
  subscriptions: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  slowConsumers: number;
  memory: number;
  cpu: number;
  routes: number;
  leafNodes: number;
  /** Null when JetStream is disabled on the server. */
  jetstream: {
    streams: number;
    consumers: number;
    messages: number;
    bytes: number;
    memory: number;
    storage: number;
  } | null;
}

/** One client connection, as reported by `connz`. */
export interface ServerConnection {
  cid: number;
  kind: string;
  type: string;
  ip: string;
  port: number;
  name: string;
  language: string;
  version: string;
  /** Round-trip time as the server formats it, e.g. `"1.2ms"`. */
  rtt: string;
  uptime: string;
  idle: string;
  subscriptions: number;
  inMsgs: number;
  outMsgs: number;
  pendingBytes: number;
}

/**
 * A subject that actually carries traffic, with an inferred payload shape.
 *
 * This is what lets an agent debug a system nobody described to it: the subject
 * list comes from the server, and the field list from sampling real messages.
 */
export interface SubjectShape {
  subject: string;
  stream: string;
  messages: number;
  /** Sampled payload fields, empty when the payloads are not JSON. */
  fields: SubjectField[];
  /** How many messages the shape was inferred from. */
  sampled: number;
  encoding: PayloadEncoding | "mixed";
  lastTs: number | null;
}

export interface SubjectField {
  /** Dotted path, e.g. `order.total_cents`. */
  path: string;
  /** JSON types seen at this path, e.g. `["string"]` or `["number","null"]`. */
  types: string[];
  /** Fraction of sampled messages containing this path, 0-1. */
  presence: number;
  /** A short example value, truncated. */
  example: string | null;
}

/** One step of a reconstructed causal chain. */
export interface FlowStep {
  subject: string;
  stream: string;
  timestamp: number;
  /** Milliseconds since the previous step, null for the first. */
  deltaMs: number | null;
  /** `failed` when the payload signals an error, `dlq` for dead letters. */
  status: "ok" | "failed" | "dlq";
  /** Error text when the step failed. */
  detail: string | null;
  seq?: number;
}

/** A reconstructed end-to-end flow for one correlation id. */
export interface Flow {
  key: "request_id" | "correlation_id";
  value: string;
  steps: FlowStep[];
  /** Wall-clock span of the whole flow. */
  durationMs: number;
  /** True when any step failed or landed in a dead-letter subject. */
  failed: boolean;
  /** The first step that failed, which is the one worth reading. */
  failedAt: FlowStep | null;
  streams: string[];
}

/** One thing that looks wrong right now. */
export interface HealthFinding {
  code: string;
  severity: "warning" | "critical";
  /** What is wrong, in one sentence. */
  message: string;
  /** Where: a stream, consumer, subject or the server itself. */
  target: string;
  /** The measurement behind the finding. */
  value: number;
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
  state: "ok" | "warning";
  errors: string[];
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

export interface QueryWarning {
  code: string;
  message: string;
}

export interface QuerySummary {
  returned: number;
  limit: number;
  truncated: boolean;
}

export interface QueryEnvelope<T> {
  query: Record<string, unknown>;
  summary: QuerySummary;
  results: T[];
  nextCursor: string | null;
  warnings: QueryWarning[];
  errors: NormalizedError[];
}

/** Bounded window query over one stream, shared by the server adapter and the MCP runtime. */
export interface StreamQuery {
  stream: string;
  /** Server-side subject filter (wildcards allowed). */
  subject?: string;
  /** Maximum messages to return. */
  limit: number;
  /** Resume cursor: stream sequence to start scanning from. Wins over fromTs. */
  startSeq?: number;
  /** Window start in epoch milliseconds (server-side start time). */
  fromTs?: number;
  /** Window end in epoch milliseconds; scanning stops past it. */
  toTs?: number;
  /** Maximum messages examined before the query returns a cursor. */
  maxScan?: number;
}

export interface StreamQueryPage {
  messages: Message[];
  /** Sequence to resume from when more messages may match, else null. */
  nextCursor: string | null;
  /** Messages examined by this query. */
  scanned: number;
  warnings: QueryWarning[];
}

export interface AgentMessage {
  id: string;
  subject: string;
  timestamp: number;
  stream?: string;
  seq?: number;
  size: number;
  isJson: boolean;
  /**
   * Payload as text, or base64 when `encoding` is `binary` — an agent must
   * never be handed a lossy UTF-8 rendering of bytes without being told.
   */
  payload: string;
  encoding: PayloadEncoding;
  payloadTruncated: boolean;
  json: unknown | null;
  requestId: string | null;
  correlationId: string | null;
}
