/**
 * Minimal WebSocket client using built-in Node modules.
 * Only supports ws:// (no TLS) and text frames — sufficient for CDP over localhost.
 * Provides the same API surface as globalThis.WebSocket used by CDPSession.
 */

import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const OPCODES = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

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
      const byte0 = this._buffer[0];
      const byte1 = this._buffer[1];
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        // Read as BigInt, but CDP messages won't exceed safe integer range
        payloadLen = Number(this._buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (masked) offset += 4; // skip mask key (server frames shouldn't be masked, but handle it)
      if (this._buffer.length < offset + payloadLen) return;

      let payload = this._buffer.subarray(offset, offset + payloadLen);
      if (masked) {
        const maskKey = this._buffer.subarray(offset - 4, offset);
        payload = Buffer.from(payload); // copy before mutating
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }

      this._buffer = this._buffer.subarray(offset + payloadLen);

      if (opcode === OPCODES.TEXT) {
        this._emit('message', { data: payload.toString('utf-8') });
      } else if (opcode === OPCODES.CLOSE) {
        try { this._sendFrame(OPCODES.CLOSE, payload); } catch {}
        this._socket.destroy();
      } else if (opcode === OPCODES.PING) {
        this._sendFrame(OPCODES.PONG, payload);
      }
    }
  }

  send(data) {
    this._sendFrame(OPCODES.TEXT, Buffer.from(data, 'utf-8'));
  }

  _sendFrame(opcode, payload) {
    if (!this._socket || this._socket.destroyed) return;
    const mask = randomBytes(4);
    let header;

    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = 0x80 | payload.length; // MASK + length
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

    this._socket.write(Buffer.concat([header, masked]));
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
