import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMsgpack, decodeProtobuf } from "../packages/core/dist/index.js";

const bytes = (...values) => new Uint8Array(values);

// ---- protobuf --------------------------------------------------------------

test("decodeProtobuf reads varints, strings and nested messages", () => {
  // field 1 varint 150; field 2 string "s3-events"
  const buf = bytes(
    0x08, 0x96, 0x01,
    0x12, 0x09, 0x73, 0x33, 0x2d, 0x65, 0x76, 0x65, 0x6e, 0x74, 0x73,
  );
  const fields = decodeProtobuf(buf);

  assert.deepEqual(fields, [
    { field: 1, type: "varint", value: 150 },
    { field: 2, type: "length-delimited", value: "s3-events" },
  ]);
});

test("decodeProtobuf recurses into nested messages", () => {
  // field 3 length-delimited containing { field 1 varint 42 }
  const fields = decodeProtobuf(bytes(0x1a, 0x02, 0x08, 0x2a));
  assert.equal(fields.length, 1);
  assert.equal(fields[0].field, 3);
  assert.deepEqual(fields[0].value, [{ field: 1, type: "varint", value: 42 }]);
});

test("decodeProtobuf keeps 64-bit varints exact", () => {
  // field 1 varint 2^62, well past Number.MAX_SAFE_INTEGER
  const buf = bytes(0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40);
  const [field] = decodeProtobuf(buf);
  assert.equal(field.value, "4611686018427387904", "a value beyond 2^53 must not be rounded");
});

test("decodeProtobuf falls back to hex for unprintable length-delimited data", () => {
  const [field] = decodeProtobuf(bytes(0x12, 0x03, 0xff, 0xfe, 0xfd));
  assert.equal(field.value, "ff fe fd");
});

test("decodeProtobuf renders fixed32 and fixed64 as bytes", () => {
  const f32 = decodeProtobuf(bytes(0x0d, 0x01, 0x02, 0x03, 0x04));
  assert.deepEqual(f32, [{ field: 1, type: "fixed32", value: "01 02 03 04" }]);

  const f64 = decodeProtobuf(bytes(0x09, 1, 2, 3, 4, 5, 6, 7, 8));
  assert.equal(f64[0].type, "fixed64");
});

test("decodeProtobuf refuses input that is not protobuf", () => {
  assert.equal(decodeProtobuf(bytes()), null, "empty");
  assert.equal(decodeProtobuf(bytes(0x07)), null, "wire type 7 does not exist");
  assert.equal(decodeProtobuf(bytes(0x00, 0x01)), null, "field number 0 is illegal");
  assert.equal(decodeProtobuf(bytes(0x12, 0xff)), null, "length runs past the end");
  assert.equal(decodeProtobuf(bytes(0x08)), null, "truncated varint");
});

test("decodeProtobuf does not claim plain JSON as protobuf", () => {
  const json = new TextEncoder().encode('{"type":"orders.created","total":100}');
  const fields = decodeProtobuf(json);
  // JSON happens to start with 0x7b, which is field 15 wire type 3 (start-group)
  // — the group branch returns null rather than inventing a structure.
  assert.equal(fields, null);
});

// ---- msgpack ---------------------------------------------------------------

test("decodeMsgpack reads a fixmap of common scalars", () => {
  // { "a": 1, "b": "hi", "c": true, "d": null }
  const buf = bytes(
    0x84,
    0xa1, 0x61, 0x01,
    0xa1, 0x62, 0xa2, 0x68, 0x69,
    0xa1, 0x63, 0xc3,
    0xa1, 0x64, 0xc0,
  );
  assert.deepEqual(decodeMsgpack(buf), { value: { a: 1, b: "hi", c: true, d: null } });
});

test("decodeMsgpack reads arrays and nested maps", () => {
  // { "xs": [1, 2], "n": { "k": -1 } }
  const buf = bytes(
    0x82,
    0xa2, 0x78, 0x73, 0x92, 0x01, 0x02,
    0xa1, 0x6e, 0x81, 0xa1, 0x6b, 0xff,
  );
  assert.deepEqual(decodeMsgpack(buf), { value: { xs: [1, 2], n: { k: -1 } } });
});

test("decodeMsgpack reads sized integers and floats", () => {
  // { "u16": 300, "i32": -70000, "f64": 1.5 }
  const buf = bytes(
    0x83,
    0xa3, 0x75, 0x31, 0x36, 0xcd, 0x01, 0x2c,
    0xa3, 0x69, 0x33, 0x32, 0xd2, 0xff, 0xfe, 0xee, 0x90,
    0xa3, 0x66, 0x36, 0x34, 0xcb, 0x3f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  );
  assert.deepEqual(decodeMsgpack(buf), { value: { u16: 300, i32: -70000, f64: 1.5 } });
});

test("decodeMsgpack keeps 64-bit integers exact", () => {
  // { "big": 2^62 } as uint64
  const buf = bytes(0x81, 0xa3, 0x62, 0x69, 0x67, 0xcf, 0x40, 0, 0, 0, 0, 0, 0, 0);
  assert.deepEqual(decodeMsgpack(buf), { value: { big: "4611686018427387904" } });
});

test("decodeMsgpack renders binary values as hex", () => {
  // { "b": bin8([0xff, 0x00]) }
  const buf = bytes(0x81, 0xa1, 0x62, 0xc4, 0x02, 0xff, 0x00);
  assert.deepEqual(decodeMsgpack(buf), { value: { b: "ff 00" } });
});

test("decodeMsgpack refuses trailing bytes", () => {
  // A valid fixmap followed by a stray byte is not a msgpack message.
  const buf = bytes(0x81, 0xa1, 0x61, 0x01, 0x99);
  assert.equal(decodeMsgpack(buf), null, "a partial decode must not be presented as the whole message");
});

test("decodeMsgpack refuses bare scalars", () => {
  // 0x41 is both ASCII "A" and a valid positive fixint; claiming it would make
  // every one-byte text payload look like msgpack.
  assert.equal(decodeMsgpack(bytes(0x41)), null);
  assert.equal(decodeMsgpack(bytes(0xc3)), null, "a bare boolean is not worth claiming");
  assert.equal(decodeMsgpack(bytes()), null);
});

test("decodeMsgpack does not claim plain text or JSON", () => {
  assert.equal(decodeMsgpack(new TextEncoder().encode("hello world")), null);
  assert.equal(decodeMsgpack(new TextEncoder().encode('{"a":1}')), null);
});

test("decodeMsgpack rejects invalid utf-8 inside a string", () => {
  // fixstr of length 2 holding invalid utf-8
  assert.equal(decodeMsgpack(bytes(0x81, 0xa1, 0x61, 0xa2, 0xff, 0xfe)), null);
});

test("decodeMsgpack rejects unsupported ext types rather than guessing", () => {
  // 0xd4 is fixext1, which this decoder deliberately does not handle.
  assert.equal(decodeMsgpack(bytes(0x81, 0xa1, 0x61, 0xd4, 0x00, 0x01)), null);
});
