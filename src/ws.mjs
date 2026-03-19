/**
 * Minimal WebSocket client using built-in Node modules.
 * Only supports ws:// (no TLS) and text frames — sufficient for CDP over localhost.
 * Provides the same API surface as globalThis.WebSocket used by CDPSession.
 */

import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const OPCODES = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/**
 * Encode a WebSocket frame with masking.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {Buffer} mask - 4-byte mask key
 * @returns {Buffer} Complete frame
 */
export function encodeFrame(opcode, payload, mask) {
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * Parse a single WebSocket frame from a buffer.
 * @param {Buffer} buf
 * @returns {{ opcode: number, payload: Buffer, frameLen: number } | null}
 */
export function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const isMasked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (isMasked) offset += 4;
  if (buf.length < offset + payloadLen) return null;

  let payload = buf.subarray(offset, offset + payloadLen);
  if (isMasked) {
    const maskKey = buf.subarray(offset - 4, offset);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }

  return { opcode, payload, frameLen: offset + payloadLen };
}

export class MinimalWebSocket extends EventEmitter {
  constructor(url) {
    super();
    const parsed = new URL(url);
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._opened = false;

    const key = randomBytes(16).toString('base64');
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port) || 80 }, () => {
      const path = parsed.pathname + parsed.search;
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${parsed.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this._emit('error', err);
      if (this._opened) this._socket.destroy();
    });
    socket.on('close', () => this._emit('close'));

    this._socket = socket;
    this._key = key;
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    if (!this._opened) {
      // Look for end of HTTP upgrade response
      const idx = this._buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;

      const header = this._buffer.subarray(0, idx).toString();
      const statusLine = header.split('\r\n')[0];
      if (!statusLine.includes('101')) {
        this._emit('error', new Error(`WebSocket upgrade failed: ${header.split('\r\n')[0]}`));
        this._socket.destroy();
        return;
      }
      this._opened = true;
      this._buffer = this._buffer.subarray(idx + 4);
      this._emit('open');
      // Defer frame parsing so 'open' listeners settle before 'message' fires
      if (this._buffer.length > 0) queueMicrotask(() => this._parseFrames());
      return;
    }

    // Parse frames
    this._parseFrames();
  }

  _parseFrames() {
    while (this._buffer.length >= 2) {
      const frame = parseFrame(this._buffer);
      if (!frame) return;

      this._buffer = this._buffer.subarray(frame.frameLen);

      if (frame.opcode === OPCODES.TEXT) {
        this._emit('message', { data: frame.payload.toString('utf-8') });
      } else if (frame.opcode === OPCODES.CLOSE) {
        try { this._sendFrame(OPCODES.CLOSE, frame.payload); } catch {}
        this._socket.destroy();
      } else if (frame.opcode === OPCODES.PING) {
        this._sendFrame(OPCODES.PONG, frame.payload);
      }
    }
  }

  send(data) {
    this._sendFrame(OPCODES.TEXT, Buffer.from(data, 'utf-8'));
  }

  _sendFrame(opcode, payload) {
    if (!this._socket || this._socket.destroyed) return;
    const mask = randomBytes(4);
    this._socket.write(encodeFrame(opcode, payload, mask));
  }

  close() {
    if (!this._socket || this._socket.destroyed) return;
    try { this._sendFrame(OPCODES.CLOSE, Buffer.alloc(0)); } catch {}
    this._socket.destroy();
  }

  /** Mimic the browser WebSocket addEventListener API */
  addEventListener(type, fn) {
    this.on(type, fn);
  }

  removeEventListener(type, fn) {
    this.off(type, fn);
  }

  /** Internal emit that matches browser WebSocket event style */
  _emit(type, data) {
    this.emit(type, data);
  }
}
