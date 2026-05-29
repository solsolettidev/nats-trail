import type { Message } from "./types.js";

/** Try to parse a UTF-8 string as JSON; return null when it is not JSON. */
export function tryParseJson(data: string): unknown | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export interface ParseMessageInput {
  subject: string;
  data: string;
  timestamp: number;
  size?: number;
  reply?: string;
  headers?: Record<string, string[]>;
  seq?: number;
  id?: string;
}

/** Build a core Message from raw transport data. The single place payloads are parsed. */
export function parseMessage(input: ParseMessageInput): Message {
  const json = tryParseJson(input.data);
  return {
    id: input.id ?? makeId(input.subject, input.timestamp, input.seq),
    subject: input.subject,
    timestamp: input.timestamp,
    data: input.data,
    json,
    isJson: json !== null,
    size: input.size ?? byteLength(input.data),
    reply: input.reply,
    headers: input.headers,
    seq: input.seq,
  };
}

/** Pretty-printed payload: indented JSON when possible, raw text otherwise. */
export function formatPayload(message: Pick<Message, "json" | "isJson" | "data">): string {
  if (message.isJson) {
    try {
      return JSON.stringify(message.json, null, 2);
    } catch {
      return message.data;
    }
  }
  return message.data;
}

function byteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function makeId(subject: string, ts: number, seq?: number): string {
  return seq != null ? `${subject}#${seq}` : `${subject}@${ts}:${counter++}`;
}

let counter = 0;
