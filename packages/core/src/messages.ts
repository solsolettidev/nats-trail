import type { Message, PayloadEncoding } from "./types.js";

/** Bytes rendered for a binary payload before the preview is cut. */
const BINARY_PREVIEW_BYTES = 1024;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without Buffer or btoa: core compiles without Node or DOM libs. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

/** Space-separated lowercase hex, the usual shape for a byte dump. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (i ? " " : "") + bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Decide whether decoded text faithfully represents the original bytes.
 *
 * A UTF-8 decoder substitutes U+FFFD for invalid sequences, so its presence
 * means information was lost. Unescaped C0 control bytes point the same way:
 * protobuf and msgpack payloads are full of them.
 */
export function looksBinary(text: string): boolean {
  if (text.includes("\uFFFD")) return true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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
  /**
   * Original payload bytes. Supply them whenever available: without them a
   * binary payload can be detected but never rendered faithfully.
   */
  bytes?: Uint8Array;
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
  const binary = json === null && input.data.length > 0 && looksBinary(input.data);
  const encoding: PayloadEncoding = json !== null ? "json" : binary ? "binary" : "text";
  const preview = binary && input.bytes ? input.bytes.subarray(0, BINARY_PREVIEW_BYTES) : null;

  return {
    id: input.id ?? makeId(input.subject, input.timestamp, input.seq),
    subject: input.subject,
    timestamp: input.timestamp,
    data: input.data,
    json,
    isJson: json !== null,
    encoding,
    hex: preview ? toHex(preview) : undefined,
    base64: preview ? toBase64(preview) : undefined,
    size: input.size ?? byteLength(input.data),
    reply: input.reply,
    headers: input.headers,
    seq: input.seq,
  };
}

/**
 * Pretty-printed payload: indented JSON when possible, a hex dump for binary,
 * raw text otherwise.
 */
export function formatPayload(message: Pick<Message, "json" | "isJson" | "data"> & Partial<Pick<Message, "encoding" | "hex">>): string {
  if (message.isJson) {
    try {
      return JSON.stringify(message.json, null, 2);
    } catch {
      return message.data;
    }
  }
  if (message.encoding === "binary" && message.hex) return formatHexDump(message.hex);
  return message.data;
}

/** Group hex bytes into the classic 16-per-line dump with an offset column. */
export function formatHexDump(hex: string): string {
  const bytes = hex.split(" ").filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    const ascii = row
      .map((b) => {
        const code = parseInt(b, 16);
        return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ".";
      })
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${row.join(" ").padEnd(47)}  |${ascii}|`);
  }
  return lines.join("\n");
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
