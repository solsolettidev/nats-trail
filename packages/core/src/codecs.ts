/**
 * Schema-less decoders for the binary payloads that show up in event-driven
 * systems.
 *
 * Neither needs a schema registry or a runtime dependency. Protobuf without a
 * descriptor cannot recover field *names*, but the wire format carries field
 * numbers, types and values — which is the difference between "I can see the
 * message" and "I have a hex dump".
 */

/**
 * TextDecoder is a platform global in both Node and browsers, but core compiles
 * without DOM or Node lib types on purpose. Declaring just the surface used here
 * keeps that property instead of pulling in either lib.
 */
declare const TextDecoder: {
  new (label?: string, options?: { fatal?: boolean }): { decode(input?: Uint8Array): string };
};

/** Decoded protobuf field, keyed by number because names need a descriptor. */
export interface ProtobufField {
  field: number;
  /** Wire type name, e.g. `varint`, `length-delimited`. */
  type: string;
  /**
   * Best-effort value. Length-delimited fields are shown as a nested message
   * when they parse as one, otherwise as a string, otherwise as hex.
   */
  value: unknown;
}

const WIRE_TYPES: Record<number, string> = {
  0: "varint",
  1: "fixed64",
  2: "length-delimited",
  3: "start-group",
  4: "end-group",
  5: "fixed32",
};

class Reader {
  constructor(
    private readonly bytes: Uint8Array,
    public offset = 0,
  ) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  byte(): number {
    if (this.done) throw new Error("unexpected end of input");
    return this.bytes[this.offset++];
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error("length exceeds input");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** Base-128 varint. Returns a bigint so 64-bit values survive intact. */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.byte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint too long");
  }
}

/** A number when it fits exactly, otherwise the decimal string. */
function narrow(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function isPrintable(text: string): boolean {
  if (text.includes("�")) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (i ? " " : "") + bytes[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Decode protobuf wire format without a schema. Returns null when the bytes are
 * not a valid message — a false positive here would be worse than a hex dump,
 * because it would look authoritative.
 */
export function decodeProtobuf(bytes: Uint8Array, depth = 0): ProtobufField[] | null {
  if (bytes.length === 0 || depth > 6) return null;
  const reader = new Reader(bytes);
  const fields: ProtobufField[] = [];

  try {
    while (!reader.done) {
      const key = reader.varint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      const type = WIRE_TYPES[wire];
      // Field 0 is illegal and unknown wire types mean this is not protobuf.
      if (!type || field === 0) return null;

      if (wire === 0) {
        fields.push({ field, type, value: narrow(reader.varint()) });
      } else if (wire === 1) {
        fields.push({ field, type, value: toHex(reader.take(8)) });
      } else if (wire === 5) {
        fields.push({ field, type, value: toHex(reader.take(4)) });
      } else if (wire === 2) {
        const length = Number(reader.varint());
        const chunk = reader.take(length);
        const nested = decodeProtobuf(chunk, depth + 1);
        if (nested && nested.length > 0) {
          fields.push({ field, type, value: nested });
        } else {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk);
          fields.push({ field, type, value: isPrintable(text) ? text : toHex(chunk) });
        }
      } else {
        // Groups are deprecated and rare; treating them as unknown is honest.
        return null;
      }
    }
  } catch {
    return null;
  }

  return fields.length > 0 ? fields : null;
}

/**
 * Decode msgpack. Returns `{ value }` on success and null when the bytes are
 * not msgpack or do not consume exactly — trailing bytes mean a wrong guess.
 */
export function decodeMsgpack(bytes: Uint8Array): { value: unknown } | null {
  if (bytes.length === 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;

  function need(n: number): void {
    if (offset + n > bytes.length) throw new Error("unexpected end of input");
  }

  function str(length: number): string {
    need(length);
    const out = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return out;
  }

  function bin(length: number): string {
    need(length);
    const out = toHex(bytes.subarray(offset, offset + length));
    offset += length;
    return out;
  }

  function array(length: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) out.push(read());
    return out;
  }

  function map(length: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < length; i++) {
      const key = read();
      out[typeof key === "string" ? key : JSON.stringify(key)] = read();
    }
    return out;
  }

  function read(): unknown {
    need(1);
    const byte = bytes[offset++];

    if (byte <= 0x7f) return byte; // positive fixint
    if (byte >= 0xe0) return byte - 0x100; // negative fixint
    if (byte >= 0x80 && byte <= 0x8f) return map(byte & 0x0f); // fixmap
    if (byte >= 0x90 && byte <= 0x9f) return array(byte & 0x0f); // fixarray
    if (byte >= 0xa0 && byte <= 0xbf) return str(byte & 0x1f); // fixstr

    switch (byte) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: need(1); return bin(bytes[offset++]);
      case 0xc5: { need(2); const n = view.getUint16(offset); offset += 2; return bin(n); }
      case 0xc6: { need(4); const n = view.getUint32(offset); offset += 4; return bin(n); }
      case 0xca: { need(4); const n = view.getFloat32(offset); offset += 4; return n; }
      case 0xcb: { need(8); const n = view.getFloat64(offset); offset += 8; return n; }
      case 0xcc: need(1); return bytes[offset++];
      case 0xcd: { need(2); const n = view.getUint16(offset); offset += 2; return n; }
      case 0xce: { need(4); const n = view.getUint32(offset); offset += 4; return n; }
      case 0xcf: { need(8); const n = view.getBigUint64(offset); offset += 8; return narrow(n); }
      case 0xd0: { need(1); const n = view.getInt8(offset); offset += 1; return n; }
      case 0xd1: { need(2); const n = view.getInt16(offset); offset += 2; return n; }
      case 0xd2: { need(4); const n = view.getInt32(offset); offset += 4; return n; }
      case 0xd3: { need(8); const n = view.getBigInt64(offset); offset += 8; return narrow(n); }
      case 0xd9: need(1); return str(bytes[offset++]);
      case 0xda: { need(2); const n = view.getUint16(offset); offset += 2; return str(n); }
      case 0xdb: { need(4); const n = view.getUint32(offset); offset += 4; return str(n); }
      case 0xdc: { need(2); const n = view.getUint16(offset); offset += 2; return array(n); }
      case 0xdd: { need(4); const n = view.getUint32(offset); offset += 4; return array(n); }
      case 0xde: { need(2); const n = view.getUint16(offset); offset += 2; return map(n); }
      case 0xdf: { need(4); const n = view.getUint32(offset); offset += 4; return map(n); }
      default:
        // Ext types and 0xc1 (never used) are not worth guessing at.
        throw new Error(`unsupported msgpack type 0x${byte.toString(16)}`);
    }
  }

  try {
    const value = read();
    // Leftover bytes mean this was not really msgpack; say nothing rather than
    // present a partial decode as the whole message.
    if (offset !== bytes.length) return null;
    // A bare scalar is indistinguishable from noise: one byte of ASCII text is
    // a valid positive fixint. Only structures are worth claiming.
    if (value === null || typeof value !== "object") return null;
    return { value };
  } catch {
    return null;
  }
}
