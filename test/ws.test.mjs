import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, parseFrame, OPCODES } from '../src/ws.mjs';

// ── encodeFrame ──

describe('encodeFrame', () => {
  it('encodes short text frame (<126 bytes)', () => {
    const payload = Buffer.from('hello');
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame = encodeFrame(OPCODES.TEXT, payload, mask);

    // Header: 2 bytes (FIN+opcode, MASK+len) + 4 bytes mask + 5 bytes masked payload
    assert.equal(frame.length, 2 + 4 + 5);
    assert.equal(frame[0], 0x80 | OPCODES.TEXT); // FIN + TEXT
    assert.equal(frame[1], 0x80 | 5); // MASK + length
  });

  it('encodes medium frame (126-65535 bytes)', () => {
    const payload = Buffer.alloc(200, 0x41); // 200 bytes of 'A'
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame = encodeFrame(OPCODES.TEXT, payload, mask);

    // Header: 2 + 2 (extended len) + 4 (mask) + 200
    assert.equal(frame.length, 2 + 2 + 4 + 200);
    assert.equal(frame[1] & 0x7f, 126); // extended length indicator
  });

  it('masks payload correctly', () => {
    const payload = Buffer.from('test');
    const mask = Buffer.from([0x00, 0x00, 0x00, 0x00]); // zero mask = no change
    const frame = encodeFrame(OPCODES.TEXT, payload, mask);

    // With zero mask, masked payload should equal original
    const maskedPayload = frame.subarray(6); // 2 + 4 mask bytes
    assert.deepEqual(maskedPayload, payload);
  });
});

// ── parseFrame ──

describe('parseFrame', () => {
  it('returns null for insufficient data', () => {
    assert.equal(parseFrame(Buffer.alloc(1)), null);
  });

  it('parses unmasked text frame', () => {
    const payload = Buffer.from('hello');
    const buf = Buffer.alloc(2 + payload.length);
    buf[0] = 0x80 | OPCODES.TEXT; // FIN + TEXT
    buf[1] = payload.length; // no mask
    payload.copy(buf, 2);

    const frame = parseFrame(buf);
    assert.ok(frame);
    assert.equal(frame.opcode, OPCODES.TEXT);
    assert.equal(frame.payload.toString(), 'hello');
    assert.equal(frame.frameLen, 2 + 5);
  });

  it('parses medium-length frame (126-byte header)', () => {
    const payload = Buffer.alloc(200, 0x42);
    const buf = Buffer.alloc(4 + payload.length);
    buf[0] = 0x80 | OPCODES.TEXT;
    buf[1] = 126;
    buf.writeUInt16BE(200, 2);
    payload.copy(buf, 4);

    const frame = parseFrame(buf);
    assert.ok(frame);
    assert.equal(frame.payload.length, 200);
    assert.equal(frame.frameLen, 4 + 200);
  });

  it('returns null when payload incomplete', () => {
    const buf = Buffer.alloc(2);
    buf[0] = 0x80 | OPCODES.TEXT;
    buf[1] = 50; // says 50 bytes but we only have 2
    assert.equal(parseFrame(buf), null);
  });

  it('parses masked frame', () => {
    const original = Buffer.from('test');
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const masked = Buffer.from(original);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    const buf = Buffer.alloc(2 + 4 + original.length);
    buf[0] = 0x80 | OPCODES.TEXT;
    buf[1] = 0x80 | original.length; // masked bit set
    mask.copy(buf, 2);
    masked.copy(buf, 6);

    const frame = parseFrame(buf);
    assert.ok(frame);
    assert.equal(frame.payload.toString(), 'test');
  });

  it('parses CLOSE frame', () => {
    const buf = Buffer.alloc(2);
    buf[0] = 0x80 | OPCODES.CLOSE;
    buf[1] = 0;
    const frame = parseFrame(buf);
    assert.equal(frame.opcode, OPCODES.CLOSE);
  });

  it('parses PING frame', () => {
    const buf = Buffer.alloc(2);
    buf[0] = 0x80 | OPCODES.PING;
    buf[1] = 0;
    const frame = parseFrame(buf);
    assert.equal(frame.opcode, OPCODES.PING);
  });
});

// ── Round-trip ──

describe('encodeFrame + parseFrame round-trip', () => {
  it('encodes then decodes to original', () => {
    const original = 'Hello, WebSocket!';
    const payload = Buffer.from(original);
    const mask = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const frame = encodeFrame(OPCODES.TEXT, payload, mask);

    // parseFrame expects unmasked server frames by default,
    // but our encoded frames are masked (client→server).
    // Verify the frame is decodable
    const parsed = parseFrame(frame);
    assert.ok(parsed);
    assert.equal(parsed.opcode, OPCODES.TEXT);
    assert.equal(parsed.payload.toString(), original);
  });
});
