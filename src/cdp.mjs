/**
 * CDP (Chrome DevTools Protocol) session and HTTP helpers.
 */

import { request } from 'node:http';
import { MinimalWebSocket } from './ws.mjs';

const WebSocket = globalThis.WebSocket || MinimalWebSocket;

export async function httpJson(url, method = 'GET', timeout = 10000) {
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
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`HTTP request to ${url} timed out after ${timeout}ms`));
    });
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
      let settled = false;
      this._ws = new WebSocket(this._wsUrl);
      this._ws.addEventListener('open', () => {
        this._open = true;
        settled = true;
        // Prevent post-open socket errors from crashing via unhandled EventEmitter 'error'
        this._ws.addEventListener('error', () => {});
        resolve();
      });
      this._ws.addEventListener('error', (e) => {
        if (!settled) { settled = true; reject(e); }
      });
      this._ws.addEventListener('message', (event) => {
        try {
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
        } catch { /* ignore malformed frames */ }
      });
      this._ws.addEventListener('close', () => {
        this._open = false;
        if (!settled) { settled = true; reject(new Error('WebSocket closed before open')); }
        for (const [id, { reject }] of this._pending) {
          reject(new Error('WebSocket closed'));
        }
        this._pending.clear();
      });
    });
  }

  send(method, params = {}) {
    if (!this._open) return Promise.reject(new Error('WebSocket is not open'));
    const id = this._id++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, fn) {
    if (!this._events.has(method)) this._events.set(method, []);
    this._events.get(method).push(fn);
  }

  close() {
    if (this._ws) this._ws.close();
  }
}
