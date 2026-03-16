/**
 * CDP (Chrome DevTools Protocol) session and HTTP helpers.
 */

import { request } from 'node:http';
import { MinimalWebSocket } from './ws.mjs';

const WebSocket = globalThis.WebSocket || MinimalWebSocket;

export async function httpJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export class CDPSession {
  constructor(wsUrl) {
    this._wsUrl = wsUrl;
    this._id = 1;
    this._pending = new Map();
    this._events = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._wsUrl);
      this._ws.addEventListener('open', () => resolve());
      this._ws.addEventListener('error', (e) => reject(e));
      this._ws.addEventListener('message', (event) => {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
        if (msg.method && this._events.has(msg.method)) {
          for (const fn of this._events.get(msg.method)) fn(msg.params);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this._id++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this._events.has(method)) this._events.set(method, []);
    this._events.get(method).push(fn);
  }

  close() {
    this._ws.close();
  }
}
